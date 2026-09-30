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
  return { ...task, reward: reward || null };
}

function isWithinWindow(task) {
  const now = new Date();
  return new Date(task.start_time.replace(' ', 'T')) <= now
    && now <= new Date(task.end_time.replace(' ', 'T'));
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
    const { name: rName, type, value, status } = reward;
    if (!rName || !String(rName).trim()) return '奖励名称不能为空';
    if (!REWARD_TYPES.includes(type)) return `奖励类型必须是：${REWARD_TYPES.join(' / ')}`;
    if (!Number.isInteger(value) || value <= 0) return '奖励数量/价值必须是正整数';
    if (status !== undefined && !REWARD_STATUSES.includes(status)) return '奖励状态无效';
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
        INSERT INTO rewards (task_id, name, type, value, status)
        VALUES (?, ?, ?, ?, ?)
      `).run(taskId, String(reward.name).trim(), reward.type, reward.value,
        reward.status || 'active');
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
  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE tasks SET name = ?, description = ?, start_time = ?, end_time = ?,
                       updated_at = datetime('now')
      WHERE id = ?
    `).run(name.trim(), String(description), startTime, endTime, task.id);
    if (reward) {
      const existing = db.prepare('SELECT * FROM rewards WHERE task_id = ?').get(task.id);
      if (existing) {
        db.prepare(`
          UPDATE rewards SET name = ?, type = ?, value = ?, status = ? WHERE task_id = ?
        `).run(String(reward.name).trim(), reward.type, reward.value,
          reward.status || existing.status, task.id);
      } else {
        db.prepare(`
          INSERT INTO rewards (task_id, name, type, value, status)
          VALUES (?, ?, ?, ?, ?)
        `).run(task.id, String(reward.name).trim(), reward.type, reward.value,
          reward.status || 'active');
      }
    }
  });
  tx();
  res.json({ task: taskWithReward(db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id)) });
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
  if (!isWithinWindow(task)) return badRequest(res, '任务不在有效期内');

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

  const info = db.prepare(`
    INSERT INTO reward_records (user_id, task_id, reward_id, reward_name, reward_type, value)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, task.id, reward.id, reward.name, reward.type, reward.value);

  const record = db.prepare('SELECT * FROM reward_records WHERE id = ?').get(info.lastInsertRowid);
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
  router.post('/tasks/:id/enable', setTaskStatus('enabled'));
  router.post('/tasks/:id/disable', setTaskStatus('disabled'));
  router.post('/tasks/:id/complete', completeTask);
  router.post('/tasks/:id/claim', claimReward);
  return router;
}

module.exports = { createApiRouter };
