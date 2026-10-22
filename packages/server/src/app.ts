// Fastify 应用工厂（静态托管 client dist + /healthz），供 index 与集成测试复用

import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, readFileSync, statSync } from 'node:fs';
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
  '.woff2': 'font/woff2',
};

export function createApp(): { app: FastifyInstance; manager: RoomManager; hub: WsHub } {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  const manager = new RoomManager();

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
        ok = existsSync(filePath) && statSync(filePath).isFile();
      } catch {
        ok = false;
      }
    }
    if (ok) {
      const type = MIME[path.extname(filePath)] ?? 'application/octet-stream';
      // 指纹资源长缓存；index.html 不缓存（保证发版即生效）
      const header = path.basename(filePath) === 'index.html' ? 'no-cache' : 'public, max-age=31536000, immutable';
      return reply.type(type).header('cache-control', header).send(readFileSync(filePath));
    }
    // SPA 兜底
    const index = path.join(CLIENT_DIST, 'index.html');
    if (existsSync(index))
      return reply
        .type('text/html; charset=utf-8')
        .header('cache-control', 'no-cache')
        .send(readFileSync(index));
    return reply.code(404).send({ error: 'not found' });
  });

  const hub = new WsHub(app.server, {
    allowOrigin: (origin) => config.allowOrigin(origin),
    trustProxy: config.trustProxy,
    onConnection: (ws, ip) => manager.createSession(ws, ip),
  });

  return { app, manager, hub };
}
