const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

function createDb(filePath) {
  if (filePath !== ':memory:') {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      username   TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status      TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','enabled','disabled')),
      start_time  TEXT NOT NULL,
      end_time    TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS rewards (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id    INTEGER NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      type       TEXT NOT NULL CHECK (type IN ('points','coins','coupon','item')),
      value      INTEGER NOT NULL,
      status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_tasks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL REFERENCES users(id),
      task_id      INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      status       TEXT NOT NULL DEFAULT 'in_progress'
                   CHECK (status IN ('in_progress','completed')),
      completed_at TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (user_id, task_id)
    );

    CREATE TABLE IF NOT EXISTS reward_records (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL REFERENCES users(id),
      task_id      INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      reward_id    INTEGER NOT NULL REFERENCES rewards(id),
      reward_name  TEXT NOT NULL,
      reward_type  TEXT NOT NULL,
      value        INTEGER NOT NULL,
      status       TEXT NOT NULL DEFAULT 'claimed',
      claimed_at   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (user_id, task_id)
    );

    CREATE INDEX IF NOT EXISTS idx_user_tasks_user ON user_tasks(user_id);
    CREATE INDEX IF NOT EXISTS idx_reward_records_user ON reward_records(user_id);
  `);
}

function seedIfEmpty(db) {
  const count = db.prepare('SELECT COUNT(*) AS c FROM tasks').get().c;
  if (count > 0) return;

  const insertUser = db.prepare('INSERT INTO users (username) VALUES (?)');
  insertUser.run('小明');
  insertUser.run('小红');

  const insertTask = db.prepare(`
    INSERT INTO tasks (name, description, status, start_time, end_time)
    VALUES (@name, @description, @status, @startTime, @endTime)
  `);
  const insertReward = db.prepare(`
    INSERT INTO rewards (task_id, name, type, value, status)
    VALUES (@taskId, @name, @type, @value, @status)
  `);
  const insertUserTask = db.prepare(`
    INSERT INTO user_tasks (user_id, task_id, status, completed_at)
    VALUES (?, ?, 'completed', datetime('now'))
  `);

  const seedAll = db.transaction(() => {
    const t1 = insertTask.run({
      name: '每日签到',
      description: '登录应用并完成一次签到。',
      status: 'enabled',
      startTime: '2026-01-01 00:00:00',
      endTime: '2027-12-31 23:59:59',
    }).lastInsertRowid;
    insertReward.run({ taskId: t1, name: '10 积分', type: 'points', value: 10, status: 'active' });
    // 用户 1 已完成未领取（可在页面演示领取流程）
    insertUserTask.run(1, t1);

    const t2 = insertTask.run({
      name: '完善个人资料',
      description: '补全头像、昵称和手机号。',
      status: 'enabled',
      startTime: '2026-01-01 00:00:00',
      endTime: '2027-12-31 23:59:59',
    }).lastInsertRowid;
    insertReward.run({ taskId: t2, name: '50 金币', type: 'coins', value: 50, status: 'active' });

    const t3 = insertTask.run({
      name: '邀请好友注册',
      description: '邀请一位新用户完成注册。',
      status: 'disabled',
      startTime: '2026-01-01 00:00:00',
      endTime: '2027-12-31 23:59:59',
    }).lastInsertRowid;
    insertReward.run({ taskId: t3, name: '5 元优惠券', type: 'coupon', value: 500, status: 'active' });
  });
  seedAll();
}

const dbFile = process.env.DB_FILE || path.join(DATA_DIR, 'app.db');
const db = createDb(dbFile);
seedIfEmpty(db);

module.exports = { db, createDb, seedIfEmpty };
