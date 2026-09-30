const { createApp } = require('./app');

const PORT = Number(process.env.PORT || 3000);
const app = createApp();

app.listen(PORT, () => {
  console.log(`任务奖励中心已启动: http://localhost:${PORT}`);
});
