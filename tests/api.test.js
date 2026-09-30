// 使用内存数据库跑 API 集成测试
process.env.DB_FILE = ':memory:';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server/app');

let server;
let base;

before(async () => {
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function call(path, options = {}) {
  const res = await fetch(base + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  return { status: res.status, body: await res.json() };
}

const post = (path, body) => call(path, { method: 'POST', body: JSON.stringify(body || {}) });

test('GET /api/tasks 只返回已启用任务', async () => {
  const { status, body } = await call('/api/tasks?userId=1');
  assert.equal(status, 200);
  assert.ok(body.tasks.length >= 2);
  assert.ok(body.tasks.every((t) => t.status === 'enabled'));
});

test('创建任务（草稿）→ 用户不可见 → 启用后可见', async () => {
  const created = await post('/api/tasks', {
    name: '测试任务A',
    description: 'desc',
    startTime: '2026-01-01 00:00:00',
    endTime: '2027-12-31 23:59:59',
    reward: { name: '5 积分', type: 'points', value: 5 },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.task.status, 'draft');

  const id = created.body.task.id;
  let list = await call('/api/tasks?userId=1');
  assert.ok(!list.body.tasks.some((t) => t.id === id));

  await post(`/api/tasks/${id}/enable`);
  list = await call('/api/tasks?userId=1');
  const task = list.body.tasks.find((t) => t.id === id);
  assert.ok(task, '启用后应对用户可见');
  assert.equal(task.reward.name, '5 积分');
});

test('停用任务后用户不可见，启用/停用可反复切换', async () => {
  const created = await post('/api/tasks', {
    name: '测试任务B',
    startTime: '2026-01-01 00:00:00',
    endTime: '2027-12-31 23:59:59',
  });
  const id = created.body.task.id;
  await post(`/api/tasks/${id}/enable`);
  await post(`/api/tasks/${id}/disable`);
  let list = await call('/api/tasks?userId=1');
  assert.ok(!list.body.tasks.some((t) => t.id === id));
  await post(`/api/tasks/${id}/enable`);
  list = await call('/api/tasks?userId=1');
  assert.ok(list.body.tasks.some((t) => t.id === id));
});

test('编辑任务可更新奖励配置', async () => {
  const created = await post('/api/tasks', {
    name: '测试任务C',
    startTime: '2026-01-01 00:00:00',
    endTime: '2027-12-31 23:59:59',
  });
  const id = created.body.task.id;
  const updated = await call(`/api/tasks/${id}`, {
    method: 'PUT',
    body: JSON.stringify({
      name: '测试任务C-改',
      startTime: '2026-01-01 00:00:00',
      endTime: '2027-12-31 23:59:59',
      reward: { name: '20 金币', type: 'coins', value: 20 },
    }),
  });
  assert.equal(updated.body.task.name, '测试任务C-改');
  assert.equal(updated.body.task.reward.name, '20 金币');
});

test('完整业务流程：完成 → 领取 → 奖励记录生成 → 不可重复领取', async () => {
  const created = await post('/api/tasks', {
    name: '测试任务D',
    startTime: '2026-01-01 00:00:00',
    endTime: '2027-12-31 23:59:59',
    reward: { name: '3 积分', type: 'points', value: 3 },
  });
  const id = created.body.task.id;
  await post(`/api/tasks/${id}/enable`);

  // 未完成不能领取
  let r = await post(`/api/tasks/${id}/claim`, { userId: 1 });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /尚未完成/);

  // 完成
  r = await post(`/api/tasks/${id}/complete`, { userId: 1 });
  assert.equal(r.status, 200);

  // 重复完成被拒绝
  r = await post(`/api/tasks/${id}/complete`, { userId: 1 });
  assert.equal(r.status, 400);

  // 领取
  r = await post(`/api/tasks/${id}/claim`, { userId: 1 });
  assert.equal(r.status, 201);
  assert.equal(r.body.record.reward_name, '3 积分');

  // 重复领取被拒绝
  r = await post(`/api/tasks/${id}/claim`, { userId: 1 });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /重复/);

  // 奖励记录可查
  const rewards = await call('/api/users/1/rewards');
  assert.ok(rewards.body.rewards.some((x) => x.task_id === id));

  // 用户任务状态
  const userTasks = await call('/api/users/1/tasks');
  const ut = userTasks.body.tasks.find((x) => x.id === id);
  assert.equal(ut.userState, 'claimed');
});

test('草稿/停用任务不能被完成；无效参数返回 400', async () => {
  const created = await post('/api/tasks', {
    name: '测试任务E',
    startTime: '2026-01-01 00:00:00',
    endTime: '2027-12-31 23:59:59',
  });
  const id = created.body.task.id;
  let r = await post(`/api/tasks/${id}/complete`, { userId: 1 });
  assert.equal(r.status, 400);

  r = await post('/api/tasks', { name: '', startTime: '2026-01-01', endTime: '2027-01-01' });
  assert.equal(r.status, 400);

  r = await post('/api/tasks', { name: 'x', startTime: '2027-01-01', endTime: '2026-01-01' });
  assert.equal(r.status, 400);

  r = await post('/api/tasks', {
    name: 'x', startTime: '2026-01-01', endTime: '2027-01-01',
    reward: { name: 'r', type: 'bogus', value: 1 },
  });
  assert.equal(r.status, 400);
});

test('过期任务不能完成', async () => {
  const created = await post('/api/tasks', {
    name: '测试任务F',
    startTime: '2020-01-01 00:00:00',
    endTime: '2020-12-31 23:59:59',
    reward: { name: '1 积分', type: 'points', value: 1 },
  });
  const id = created.body.task.id;
  await post(`/api/tasks/${id}/enable`);
  const r = await post(`/api/tasks/${id}/complete`, { userId: 1 });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /已过期/);
});

test('查询不存在的任务/用户返回 404', async () => {
  assert.equal((await call('/api/tasks/99999')).status, 404);
  assert.equal((await call('/api/users/99999/rewards')).status, 404);
});

test('未开始的任务不能完成', async () => {
  const created = await post('/api/tasks', {
    name: '未开始任务',
    startTime: '2027-01-01 00:00:00',
    endTime: '2028-12-31 23:59:59',
    reward: { name: '1 积分', type: 'points', value: 1 },
  });
  const id = created.body.task.id;
  await post(`/api/tasks/${id}/enable`);
  const r = await post(`/api/tasks/${id}/complete`, { userId: 1 });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /未开始/);
});

test('已停用的任务不能完成', async () => {
  const created = await post('/api/tasks', {
    name: '停用任务',
    startTime: '2026-01-01 00:00:00',
    endTime: '2027-12-31 23:59:59',
    reward: { name: '1 积分', type: 'points', value: 1 },
  });
  const id = created.body.task.id;
  await post(`/api/tasks/${id}/enable`);
  await post(`/api/tasks/${id}/disable`);
  const r = await post(`/api/tasks/${id}/complete`, { userId: 1 });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /未启用/);
});

test('奖励库存：正常领取扣库存，领完后拒绝且不出现负库存', async () => {
  const created = await post('/api/tasks', {
    name: '限量任务（库存1）',
    startTime: '2026-01-01 00:00:00',
    endTime: '2027-12-31 23:59:59',
    reward: { name: '限量周边', type: 'item', value: 1, stock: 1 },
  });
  const id = created.body.task.id;
  await post(`/api/tasks/${id}/enable`);
  await post(`/api/tasks/${id}/complete`, { userId: 1 });
  await post(`/api/tasks/${id}/complete`, { userId: 2 });

  // 用户1 领取成功，库存 1 -> 0
  let r = await post(`/api/tasks/${id}/claim`, { userId: 1 });
  assert.equal(r.status, 201);

  // 用户2 领取失败：已领完
  r = await post(`/api/tasks/${id}/claim`, { userId: 2 });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /已领完|库存不足/);

  // 库存不能为负，已领取数仍为 1
  const detail = await call(`/api/tasks/${id}`);
  assert.equal(detail.body.task.reward.claimed_count, 1);
  assert.equal(detail.body.task.reward.remaining, 0);
  assert.equal(detail.body.task.reward.soldOut, true);

  // 用户1 再次领取仍被拒绝（重复领取）
  r = await post(`/api/tasks/${id}/claim`, { userId: 1 });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /重复/);
  const after = await call(`/api/tasks/${id}`);
  assert.equal(after.body.task.reward.claimed_count, 1);
});

test('编辑规则：已有用户完成任务后不能修改奖励类型', async () => {
  const created = await post('/api/tasks', {
    name: '类型锁定任务',
    startTime: '2026-01-01 00:00:00',
    endTime: '2027-12-31 23:59:59',
    reward: { name: '10 积分', type: 'points', value: 10, stock: 10 },
  });
  const id = created.body.task.id;
  await post(`/api/tasks/${id}/enable`);
  await post(`/api/tasks/${id}/complete`, { userId: 1 });

  // 改类型被拒绝
  let r = await call(`/api/tasks/${id}`, {
    method: 'PUT',
    body: JSON.stringify({
      name: '类型锁定任务', startTime: '2026-01-01 00:00:00', endTime: '2027-12-31 23:59:59',
      reward: { name: '10 积分', type: 'coins', value: 10 },
    }),
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /奖励类型/);

  // 不改类型（改数量）允许
  r = await call(`/api/tasks/${id}`, {
    method: 'PUT',
    body: JSON.stringify({
      name: '类型锁定任务', startTime: '2026-01-01 00:00:00', endTime: '2027-12-31 23:59:59',
      reward: { name: '10 积分', type: 'points', value: 20 },
    }),
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.task.reward.value, 20);
});

test('编辑规则：已开始任务不能把开始时间改到当前时间之后', async () => {
  const created = await post('/api/tasks', {
    name: '已开始任务',
    startTime: '2026-01-01 00:00:00',
    endTime: '2027-12-31 23:59:59',
  });
  const id = created.body.task.id;

  // 已开始（start_time 已过）→ 改到未来被拒绝
  let r = await call(`/api/tasks/${id}`, {
    method: 'PUT',
    body: JSON.stringify({
      name: '已开始任务', startTime: '2027-06-01 00:00:00', endTime: '2027-12-31 23:59:59',
    }),
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /开始时间/);

  // 未开始的任务允许修改开始时间
  const future = await post('/api/tasks', {
    name: '未来任务',
    startTime: '2027-01-01 00:00:00',
    endTime: '2028-12-31 23:59:59',
  });
  r = await call(`/api/tasks/${future.body.task.id}`, {
    method: 'PUT',
    body: JSON.stringify({
      name: '未来任务', startTime: '2027-06-01 00:00:00', endTime: '2028-12-31 23:59:59',
    }),
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.task.start_time, '2027-06-01 00:00:00');
});

test('删除规则：有领取记录不能删除；无领取记录可删除', async () => {
  const withClaim = await post('/api/tasks', {
    name: '有领取记录的任务',
    startTime: '2026-01-01 00:00:00',
    endTime: '2027-12-31 23:59:59',
    reward: { name: '1 积分', type: 'points', value: 1 },
  });
  const id1 = withClaim.body.task.id;
  await post(`/api/tasks/${id1}/enable`);
  await post(`/api/tasks/${id1}/complete`, { userId: 1 });
  await post(`/api/tasks/${id1}/claim`, { userId: 1 });

  let r = await call(`/api/tasks/${id1}`, { method: 'DELETE' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /不允许删除/);

  // 有完成但未领取的用户：仅完成记录不阻止删除（需求只限制已领取）
  const noClaim = await post('/api/tasks', {
    name: '仅完成未领取的任务',
    startTime: '2026-01-01 00:00:00',
    endTime: '2027-12-31 23:59:59',
    reward: { name: '1 积分', type: 'points', value: 1 },
  });
  const id2 = noClaim.body.task.id;
  await post(`/api/tasks/${id2}/enable`);
  await post(`/api/tasks/${id2}/complete`, { userId: 1 });
  r = await call(`/api/tasks/${id2}`, { method: 'DELETE' });
  assert.equal(r.status, 200);
  assert.equal((await call(`/api/tasks/${id2}`)).status, 404);
});

test('停用任务后，历史完成记录与奖励记录保留', async () => {
  const created = await post('/api/tasks', {
    name: '将停用的任务',
    startTime: '2026-01-01 00:00:00',
    endTime: '2027-12-31 23:59:59',
    reward: { name: '2 积分', type: 'points', value: 2 },
  });
  const id = created.body.task.id;
  await post(`/api/tasks/${id}/enable`);
  await post(`/api/tasks/${id}/complete`, { userId: 2 });
  await post(`/api/tasks/${id}/claim`, { userId: 2 });
  await post(`/api/tasks/${id}/disable`);

  // 任务对用户端不可见
  const list = await call('/api/tasks?userId=2');
  assert.ok(!list.body.tasks.some((t) => t.id === id));

  // 但用户的历史记录仍在
  const rewards = await call('/api/users/2/rewards');
  assert.ok(rewards.body.rewards.some((x) => x.task_id === id));
  const userTasks = await call('/api/users/2/tasks');
  assert.ok(userTasks.body.tasks.some((x) => x.id === id && x.userState === 'claimed'));
});
