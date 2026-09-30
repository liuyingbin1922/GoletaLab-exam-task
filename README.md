# 任务奖励中心（简化版）

一个最小可运行的「任务奖励中心」全栈示例：运营人员创建/编辑/启停任务并配置奖励，普通用户浏览任务、标记完成、领取奖励并查看奖励记录。

- 后端：Node.js + Express + better-sqlite3（SQLite 持久化，无需单独安装数据库）
- 前端：原生 HTML / CSS / JavaScript 多页应用
- 测试：Node 内置 `node:test` 运行 API 集成测试（内存数据库，不影响真实数据）

## 安装

要求 Node.js >= 18。

```bash
npm install
```

## 启动

```bash
npm start
# 或开发模式（文件变更自动重启）
npm run dev
```

启动后访问 http://localhost:3000 。

首次启动会自动创建 SQLite 数据库文件 `data/app.db` 并写入种子数据：

- 用户：`1. 小明`、`2. 小红`（页面右上角可切换，用于模拟不同用户）
- 任务：「每日签到」（已启用，用户 1 已完成未领取——可直接演示领取流程）、「完善个人资料」（已启用）、「邀请好友注册」（已停用）

可用环境变量：`PORT`（默认 3000）、`DB_FILE`（默认 `data/app.db`，测试时置为 `:memory:`）。

## 测试

```bash
npm test
```

测试基于 Node 内置测试运行器，覆盖：任务可见性与启停、创建/编辑校验、完成→领取→奖励记录的完整流程、防重复完成/领取、有效期限制、404 等。

## 项目结构

```
├── package.json
├── server/
│   ├── index.js     # 启动入口
│   ├── app.js       # Express 应用装配、页面路由、错误处理
│   ├── db.js        # SQLite 连接、建表、种子数据
│   └── routes.js    # 全部 API 路由与业务逻辑
├── public/          # 前端静态页面（无构建步骤）
│   ├── index.html           # /            首页·任务列表
│   ├── task.html            # /tasks/:id   任务详情
│   ├── my-rewards.html      # /my-rewards  我的奖励
│   ├── admin-tasks.html     # /admin/tasks 任务管理
│   ├── admin-task-form.html # /admin/tasks/create、/admin/tasks/:id/edit 创建/编辑
│   ├── common.js            # 用户切换、API 封装
│   └── style.css
├── tests/
│   └── api.test.js  # API 集成测试
└── data/            # 运行时生成（SQLite 数据库，已 gitignore）
```

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/users` | 用户列表 |
| GET | `/api/tasks?userId=` | 用户视角任务列表（仅已启用，附带当前用户状态） |
| GET | `/api/tasks/all` | 运营视角全部任务 |
| GET | `/api/tasks/:id?userId=` | 任务详情（含奖励、当前用户状态） |
| POST | `/api/tasks` | 创建任务（可带奖励配置，初始为草稿） |
| PUT | `/api/tasks/:id` | 编辑任务（含奖励配置） |
| POST | `/api/tasks/:id/enable` | 启用任务 |
| POST | `/api/tasks/:id/disable` | 停用任务（历史完成/奖励记录保留） |
| DELETE | `/api/tasks/:id` | 删除任务（已有用户领取奖励时不允许删除） |
| POST | `/api/tasks/:id/complete` | body `{ userId }`，用户标记任务完成 |
| POST | `/api/tasks/:id/claim` | body `{ userId }`，领取奖励（生成奖励记录） |
| GET | `/api/users/:id/tasks` | 某用户的任务参与状态 |
| GET | `/api/users/:id/rewards` | 某用户的奖励领取记录 |

任务字段：名称、描述、状态（draft/enabled/disabled）、开始时间、结束时间、创建/更新时间、奖励信息。
奖励字段：名称、类型（points/coins/coupon/item）、数量/价值（正整数）、状态（active/inactive）、库存（stock，留空/NULL 表示不限）、已领取数量（claimed_count）。

## 核心业务流程

```
运营创建任务(草稿) → 配置奖励 → 启用 → 用户可见
→ 用户标记完成 → 状态变为「已完成·未领取」→ 用户领取 → 生成奖励记录（唯一约束防重复）
```

关键规则：

**完成校验（需求 1）**
- 仅 `enabled` 且处于有效期 `[start_time, end_time]` 内的任务可完成；未开始/已过期分别返回「任务未开始，暂不能完成」「任务已过期，无法完成」；
- 同一用户不能重复完成同一任务（「任务已完成，无需重复操作」）；
- 已领取的任务不能再次领取（「奖励已领取，请勿重复领取」），`reward_records` 对 `(user_id, task_id)` 有唯一约束兜底。

**奖励库存（需求 2）**
- 奖励含库存（stock）、已领取数量（claimed_count）、剩余库存（接口以 `remaining` / `soldOut` 返回），`stock` 留空表示不限；
- 领取时先查库存，扣减使用 `UPDATE ... WHERE claimed_count < stock` 原子操作并在事务内写入奖励记录；库存不足返回「奖励已领完（库存不足）」，并发下不会超发、不会变为负数；
- 剩余库存为 0 时前端展示「已领完」，领取按钮不可操作。

**编辑兼容（需求 3）**
- 已有用户完成的任务，不允许修改奖励类型（名称、数量等其他字段可改）；
- 已有用户领取奖励的任务，不允许删除（`DELETE /api/tasks/:id` 返回 400）；
- 已经开始的任务（开始时间已到），不能把开始时间修改到当前时间之后；
- 停用任务只改状态，历史完成记录（user_tasks）与奖励记录（reward_records）均保留可查。

**测试（需求 4）**：`npm test` 共 15 个用例，覆盖正常完成、重复完成、正常领取、重复领取、库存不足（含库存不为负断言）、任务过期、任务未开始、禁用任务、奖励类型锁定、开始时间锁定、删除保护与停用后历史保留。

其余通用校验（名称为空、时间格式、结束早于开始、奖励数值非法等）均返回 400。

## 已知限制

- 无鉴权/登录：用户身份通过页面右上角选择和请求中的 `userId` 传递，运营后台接口未做权限控制，仅用于演示；
- 「用户完成任务」由用户自行点击标记，未对接真实业务事件；
- 无分页、无并发扣减库存等复杂场景处理（SQLite 单写者，简单场景够用）；
- 前端为无构建的原生多页应用，仅适配桌面浏览器；
- 时间字段以 `YYYY-MM-DD HH:mm:ss` 字符串存储与校验，未处理时区（按服务器本地时间比较）。

## License

MIT（示例项目）
