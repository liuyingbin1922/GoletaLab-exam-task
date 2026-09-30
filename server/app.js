const path = require('path');
const express = require('express');
const { createApiRouter } = require('./routes');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.use('/api', createApiRouter());

  // 避免浏览器请求 favicon 产生 404 噪音
  app.get('/favicon.ico', (req, res) => res.status(204).end());

  // 前端页面路由（多页应用，URL 形如 /tasks/1、/admin/tasks/create）
  const page = (file) => (req, res) => res.sendFile(path.join(__dirname, '..', 'public', file));
  app.get('/tasks/:id', page('task.html'));
  app.get('/my-rewards', page('my-rewards.html'));
  app.get('/admin/tasks', page('admin-tasks.html'));
  app.get('/admin/tasks/create', page('admin-task-form.html'));
  app.get('/admin/tasks/:id/edit', page('admin-task-form.html'));

  app.use((req, res) => res.status(404).json({ error: '接口不存在' }));

  // 统一错误处理
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || '服务器内部错误' });
  });

  return app;
}

module.exports = { createApp };
