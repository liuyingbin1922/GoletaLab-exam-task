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
  assert.match(r.body.error, /有效期/);
});

test('查询不存在的任务/用户返回 404', async () => {
  assert.equal((await call('/api/tasks/99999')).status, 404);
  assert.equal((await call('/api/users/99999/rewards')).status, 404);
});
