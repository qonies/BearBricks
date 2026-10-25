// Fastify 应用工厂（静态托管 client dist + /healthz），供 index 与集成测试复用

import Fastify, { type FastifyInstance } from 'fastify';
import compress from '@fastify/compress';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WsHub } from './net/wsHub';
import { RoomManager } from './room/roomManager';
import { config } from './config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 兼容 tsx（src/）与 esbuild 产物（dist/）：两者均位于 root 下三级，统一向上三级定位；
 *  Docker 部署以 CLIENT_DIST 环境变量覆盖（technical-design §9） */
function resolveClientDist(): string {
  if (process.env.CLIENT_DIST) return path.resolve(process.env.CLIENT_DIST);
  return path.resolve(__dirname, '../../../packages/client/dist');
}

const CLIENT_DIST = resolveClientDist();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
};

export function createApp(): { app: FastifyInstance; manager: RoomManager; hub: WsHub } {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  // gzip/deflate（静态 JS/CSS/JSON；阈值 1KB）
  app.register(compress, { global: true, threshold: 1024 });
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'same-origin');
    if (config.isProd) {
      reply.header('content-security-policy', "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    }
    return payload;
  });
  if (config.isProd && !config.origin) {
    // 部署护栏（P1-4）：生产环境未配置 ORIGIN 时，非 localhost 来源的 WebSocket 会被拒绝
    app.log.warn(
      'NODE_ENV=production 且未设置 ORIGIN：/ws 仅接受 localhost 来源；局域网/域名部署请设置 ORIGIN（例如 http://<host>:3000）',
    );
  }
  const manager = new RoomManager(app.log);

  app.get('/healthz', async () => ({
    ok: true,
    rooms: manager.roomCount(),
    sessions: manager.sessionCount(),
  }));

  app.get('/*', async (req, reply) => {
    const url = (req.url ?? '/').split('?')[0];
    if (url === '/ws' || url.startsWith('/ws?')) return reply.code(404).send();
    let rel: string;
    try {
      rel = url === '/' ? '/index.html' : decodeURIComponent(url);
    } catch {
      return reply.code(400).send();
    }
    // 归一化后做前缀校验（startsWith 单独使用存在 client-dist-xxx 兄弟目录碰撞风险）
    const filePath = path.join(CLIENT_DIST, rel);
    const inside =
      filePath === CLIENT_DIST || filePath.startsWith(CLIENT_DIST + path.sep);
    let ok = false;
    if (inside) {
      try {
        // 异步 stat/read：同步读盘会阻塞事件循环（静态资源与对局 tick 共用同一线程）
        ok = (await stat(filePath)).isFile();
      } catch {
        ok = false;
      }
    }
    if (ok) {
      const type = MIME[path.extname(filePath)] ?? 'application/octet-stream';
      // 只有 Vite 指纹资源（/assets/）可 immutable；manifest/favicon/index.html 必须可刷新
      const header = url.startsWith('/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'no-cache';
      const body = await readFile(filePath);
      return reply.type(type).header('cache-control', header).send(body);
    }
    // SPA 兜底
    const index = path.join(CLIENT_DIST, 'index.html');
    try {
      const body = await readFile(index);
      return reply.type('text/html; charset=utf-8').header('cache-control', 'no-cache').send(body);
    } catch {
      return reply.code(404).send({ error: 'not found' });
    }
  });

  const hub = new WsHub(app.server, {
    allowOrigin: (origin) => config.allowOrigin(origin),
    trustProxy: config.trustProxy,
    onConnection: (ws, ip) => manager.createSession(ws, ip),
    log: app.log,
  });

  return { app, manager, hub };
}
