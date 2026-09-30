const express = require('express');
const { db } = require('./db');

const TASK_STATUSES = ['draft', 'enabled', 'disabled'];
const REWARD_TYPES = ['points', 'coins', 'coupon', 'item'];
const REWARD_STATUSES = ['active', 'inactive'];

function isValidDateTime(s) {
  return typeof s === 'string' && !Number.isNaN(Date.parse(s.replace(' ', 'T')));
}

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

function notFound(res, message = '资源不存在') {
  return res.status(404).json({ error: message });
}

function getTaskOr404(req, res) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) {
    notFound(res, '任务不存在');
    return null;
  }
  return task;
}

function taskWithReward(task) {
  const reward = db.prepare('SELECT * FROM rewards WHERE task_id = ?').get(task.id);
  if (reward) {
    const remaining = reward.stock === null ? null : Math.max(0, reward.stock - reward.claimed_count);
    reward.remaining = remaining;
    reward.soldOut = remaining !== null && remaining <= 0;
  }
  return { ...task, reward: reward || null };
}

function isWithinWindow(task) {
  const now = new Date();
  return new Date(task.start_time.replace(' ', 'T')) <= now
    && now <= new Date(task.end_time.replace(' ', 'T'));
}

// 返回任务当前相对有效期的时间状态：not_started / in_window / expired
function windowState(task) {
  const now = new Date();
  if (now < new Date(task.start_time.replace(' ', 'T'))) return 'not_started';
  if (now > new Date(task.end_time.replace(' ', 'T'))) return 'expired';
  return 'in_window';
}

function hasCompletedUsers(taskId) {
  return !!db.prepare(
    `SELECT id FROM user_tasks WHERE task_id = ? AND status = 'completed' LIMIT 1`,
  ).get(taskId);
}

function hasClaimedUsers(taskId) {
  return !!db.prepare('SELECT id FROM reward_records WHERE task_id = ? LIMIT 1').get(taskId);
}

function validateTaskBody(body) {
  const { name, description, startTime, endTime, reward } = body || {};
  if (!name || typeof name !== 'string' || !name.trim()) return '任务名称不能为空';
  if (!startTime || !isValidDateTime(startTime)) return '开始时间格式无效（示例：2026-01-01 00:00:00）';
  if (!endTime || !isValidDateTime(endTime)) return '结束时间格式无效（示例：2027-12-31 23:59:59）';
  if (Date.parse(endTime.replace(' ', 'T')) <= Date.parse(startTime.replace(' ', 'T'))) {
    return '结束时间必须晚于开始时间';
  }
  if (reward !== undefined && reward !== null) {
    const { name: rName, type, value, status, stock } = reward;
    if (!rName || !String(rName).trim()) return '奖励名称不能为空';
    if (!REWARD_TYPES.includes(type)) return `奖励类型必须是：${REWARD_TYPES.join(' / ')}`;
    if (!Number.isInteger(value) || value <= 0) return '奖励数量/价值必须是正整数';
    if (status !== undefined && !REWARD_STATUSES.includes(status)) return '奖励状态无效';
    if (stock !== undefined && stock !== null
        && (!Number.isInteger(stock) || stock <= 0)) return '奖励库存必须是正整数，留空表示不限库存';
  }
  return null;
}

// ---------- 查询 ----------

function listTasksForUser(req, res) {
  const userId = Number(req.query.userId || 0);
  const rows = db.prepare(`
    SELECT t.*, ut.status AS user_status, ut.completed_at,
           rr.id AS reward_record_id
    FROM tasks t
    LEFT JOIN user_tasks ut ON ut.task_id = t.id AND ut.user_id = ?
    LEFT JOIN reward_records rr ON rr.task_id = t.id AND rr.user_id = ?
    WHERE t.status = 'enabled'
    ORDER BY t.id DESC
  `).all(userId, userId);
  const tasks = rows.map((r) => {
    const reward = db.prepare('SELECT * FROM rewards WHERE task_id = ?').get(r.id);
    let userState = r.user_status || 'not_started';
    if (r.reward_record_id) userState = 'claimed';
    else if (userState === 'completed') userState = 'completed_unclaimed';
    return { ...taskWithReward(r), userState, inWindow: isWithinWindow(r) };
  });
  res.json({ tasks });
}

function getTask(req, res) {
  const task = getTaskOr404(req, res);
  if (!task) return;
  const userId = Number(req.query.userId || 0);
  let userState = 'not_started';
  if (userId) {
    const ut = db.prepare('SELECT * FROM user_tasks WHERE user_id = ? AND task_id = ?').get(userId, task.id);
    const rr = db.prepare('SELECT id FROM reward_records WHERE user_id = ? AND task_id = ?').get(userId, task.id);
    if (rr) userState = 'claimed';
    else if (ut && ut.status === 'completed') userState = 'completed_unclaimed';
  }
  res.json({ task: { ...taskWithReward(task), userState, inWindow: isWithinWindow(task) } });
}

function listAllTasks(req, res) {
  const tasks = db.prepare('SELECT * FROM tasks ORDER BY id DESC').all().map(taskWithReward);
  res.json({ tasks });
}

function listUserTasks(req, res) {
  const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(req.params.id);
  if (!user) return notFound(res, '用户不存在');
  const rows = db.prepare(`
    SELECT t.*, ut.status AS user_status, ut.completed_at,
           rr.id AS reward_record_id
    FROM user_tasks ut
    JOIN tasks t ON t.id = ut.task_id
    LEFT JOIN reward_records rr ON rr.task_id = ut.task_id AND rr.user_id = ut.user_id
    WHERE ut.user_id = ?
    ORDER BY ut.id DESC
  `).all(user.id);
  const tasks = rows.map((r) => ({
    ...taskWithReward(r),
    userState: r.reward_record_id ? 'claimed' : (r.user_status === 'completed' ? 'completed_unclaimed' : r.user_status),
  }));
  res.json({ user, tasks });
}

function listUserRewards(req, res) {
  const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(req.params.id);
  if (!user) return notFound(res, '用户不存在');
  const records = db.prepare(`
    SELECT rr.*, t.name AS task_name
    FROM reward_records rr
    JOIN tasks t ON t.id = rr.task_id
    WHERE rr.user_id = ?
    ORDER BY rr.id DESC
  `).all(user.id);
  res.json({ user, rewards: records });
}

function listUsers(req, res) {
  res.json({ users: db.prepare('SELECT id, username FROM users ORDER BY id').all() });
}

// ---------- 运营操作 ----------

function createTask(req, res) {
  const err = validateTaskBody(req.body);
  if (err) return badRequest(res, err);

  const { name, description = '', startTime, endTime, reward } = req.body;
  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO tasks (name, description, status, start_time, end_time)
      VALUES (?, ?, 'draft', ?, ?)
    `).run(name.trim(), String(description), startTime, endTime);
    const taskId = info.lastInsertRowid;
    if (reward) {
      db.prepare(`
        INSERT INTO rewards (task_id, name, type, value, status, stock)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(taskId, String(reward.name).trim(), reward.type, reward.value,
        reward.status || 'active', reward.stock ?? null);
    }
    return taskId;
  });
  const taskId = tx();
  res.status(201).json({ task: taskWithReward(db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId)) });
}

function updateTask(req, res) {
  const task = getTaskOr404(req, res);
  if (!task) return;
  const err = validateTaskBody(req.body);
  if (err) return badRequest(res, err);

  const { name, description = '', startTime, endTime, reward } = req.body;

  // 编辑兼容规则
  const existingReward = db.prepare('SELECT * FROM rewards WHERE task_id = ?').get(task.id);
  if (reward && existingReward && hasCompletedUsers(task.id) && reward.type !== existingReward.type) {
    return badRequest(res, '已有用户完成该任务，不允许修改奖励类型');
  }
  // 已经开始的任务（开始时间已到）不能把开始时间修改到当前时间之后
  const taskStarted = windowState(task) !== 'not_started';
  if (taskStarted && Date.parse(startTime.replace(' ', 'T')) > Date.now()) {
    return badRequest(res, '任务已开始，不能把开始时间修改到当前时间之后');
  }

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE tasks SET name = ?, description = ?, start_time = ?, end_time = ?,
                       updated_at = datetime('now')
      WHERE id = ?
    `).run(name.trim(), String(description), startTime, endTime, task.id);
    if (reward) {
      const stock = reward.stock === undefined ? existingReward?.stock ?? null : reward.stock;
      if (existingReward) {
        db.prepare(`
          UPDATE rewards SET name = ?, type = ?, value = ?, status = ?, stock = ? WHERE task_id = ?
        `).run(String(reward.name).trim(), reward.type, reward.value,
          reward.status || existingReward.status, stock, task.id);
      } else {
        db.prepare(`
          INSERT INTO rewards (task_id, name, type, value, status, stock)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(task.id, String(reward.name).trim(), reward.type, reward.value,
          reward.status || 'active', stock);
      }
    }
  });
  tx();
  res.json({ task: taskWithReward(db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id)) });
}

function deleteTask(req, res) {
  const task = getTaskOr404(req, res);
  if (!task) return;
  if (hasClaimedUsers(task.id)) {
    return badRequest(res, '已有用户领取该任务的奖励，不允许删除');
  }
  db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
  res.json({ ok: true, deletedId: task.id });
}

function setTaskStatus(status) {
  return (req, res) => {
    const task = getTaskOr404(req, res);
    if (!task) return;
    if (!TASK_STATUSES.includes(status)) return badRequest(res, '状态无效');
    db.prepare(`UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, task.id);
    res.json({ task: taskWithReward(db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id)) });
  };
}

// ---------- 用户操作 ----------

function completeTask(req, res) {
  const task = getTaskOr404(req, res);
  if (!task) return;
  const userId = Number(req.body?.userId || 0);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return badRequest(res, 'userId 无效');
  if (task.status !== 'enabled') return badRequest(res, '任务未启用，无法完成');
  const ws = windowState(task);
  if (ws === 'not_started') return badRequest(res, '任务未开始，暂不能完成');
  if (ws === 'expired') return badRequest(res, '任务已过期，无法完成');

  const existing = db.prepare('SELECT * FROM user_tasks WHERE user_id = ? AND task_id = ?').get(userId, task.id);
  if (existing?.status === 'completed') return badRequest(res, '任务已完成，无需重复操作');

  if (existing) {
    db.prepare(`UPDATE user_tasks SET status = 'completed', completed_at = datetime('now') WHERE id = ?`).run(existing.id);
  } else {
    db.prepare(`INSERT INTO user_tasks (user_id, task_id, status, completed_at) VALUES (?, ?, 'completed', datetime('now'))`).run(userId, task.id);
  }
  res.json({ ok: true, userState: 'completed_unclaimed' });
}

function claimReward(req, res) {
  const task = getTaskOr404(req, res);
  if (!task) return;
  const userId = Number(req.body?.userId || 0);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return badRequest(res, 'userId 无效');

  const ut = db.prepare('SELECT * FROM user_tasks WHERE user_id = ? AND task_id = ?').get(userId, task.id);
  if (!ut || ut.status !== 'completed') return badRequest(res, '任务尚未完成，无法领取奖励');

  const reward = db.prepare('SELECT * FROM rewards WHERE task_id = ?').get(task.id);
  if (!reward) return badRequest(res, '该任务未配置奖励');
  if (reward.status !== 'active') return badRequest(res, '奖励已停用，无法领取');

  const dup = db.prepare('SELECT id FROM reward_records WHERE user_id = ? AND task_id = ?').get(userId, task.id);
  if (dup) return badRequest(res, '奖励已领取，请勿重复领取');
  if (reward.stock !== null && reward.claimed_count >= reward.stock) {
    return badRequest(res, '奖励已领完（库存不足）');
  }

  // 原子扣减库存并写入奖励记录，保证并发下不会超发、不会出现负库存
  const tx = db.transaction(() => {
    const dec = db.prepare(`
      UPDATE rewards SET claimed_count = claimed_count + 1
      WHERE task_id = ? AND (stock IS NULL OR claimed_count < stock)
    `).run(task.id);
    if (dec.changes === 0) {
      throw Object.assign(new Error('奖励已领完（库存不足）'), { status: 400 });
    }
    return db.prepare(`
      INSERT INTO reward_records (user_id, task_id, reward_id, reward_name, reward_type, value)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, task.id, reward.id, reward.name, reward.type, reward.value).lastInsertRowid;
  });

  let recordId;
  try {
    recordId = tx();
  } catch (e) {
    return badRequest(res, e.message || '领取失败');
  }
  const record = db.prepare('SELECT * FROM reward_records WHERE id = ?').get(recordId);
  res.status(201).json({ ok: true, record, userState: 'claimed' });
}

// ---------- 路由 ----------

function createApiRouter() {
  const router = express.Router();
  router.get('/users', listUsers);
  router.get('/users/:id/tasks', listUserTasks);
  router.get('/users/:id/rewards', listUserRewards);

  router.get('/tasks', listTasksForUser);
  router.get('/tasks/all', listAllTasks);
  router.get('/tasks/:id', getTask);
  router.post('/tasks', createTask);
  router.put('/tasks/:id', updateTask);
  router.delete('/tasks/:id', deleteTask);
  router.post('/tasks/:id/enable', setTaskStatus('enabled'));
  router.post('/tasks/:id/disable', setTaskStatus('disabled'));
  router.post('/tasks/:id/complete', completeTask);
  router.post('/tasks/:id/claim', claimReward);
  return router;
}

module.exports = { createApiRouter };
