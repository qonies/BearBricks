// 入口：启动 HTTP + WS，优雅停机（SIGTERM → 广播 E4999 → 5s 内关闭，NFR-4）

import { createApp } from './app';
import { config } from './config';

const { app, manager, hub } = createApp();

let closing = false;
/** exitCode：SIGTERM/SIGINT 正常退出为 0；uncaughtException/unhandledRejection 以非零码退出（NFR-4，交由 Docker/systemd 重启） */
const shutdown = (signal: string, exitCode = 0): void => {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'graceful shutdown');
  manager.shutdown(); // 广播 E4999（session.shutdown 100ms 后自行 terminate，给消息留出 flush 时间）
  setTimeout(() => hub.closeAll(), 200).unref();
  app.server.close(() => process.exit(exitCode));
  setTimeout(() => process.exit(exitCode), 5000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  app.log.error({ err }, 'uncaughtException');
  shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (reason) => {
  app.log.error({ reason }, 'unhandledRejection');
  shutdown('unhandledRejection', 1);
});

app
  .listen({ port: config.port, host: '0.0.0.0' })
  .then(() => app.log.info(`BearBricks server listening on :${config.port}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
