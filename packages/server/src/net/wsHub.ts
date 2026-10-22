// wsHub：升级握手（/ws 路径 + Origin 校验 + 每 IP 并发 ≤5）、消息分发入口

import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';

const MAX_IP_CONNECTIONS = 5;
// 与 session 的 4KB 上限一致；maxPayload 在 ws 层拒收超大帧，避免先缓冲再检查的内存 DoS
const MAX_PAYLOAD_BYTES = 4096;

export interface WsHubOptions {
  allowOrigin(origin: string | undefined): boolean;
  /** 仅在可信反代后开启：信任 x-forwarded-for 获取真实客户端 IP（限流维度） */
  trustProxy?: boolean;
  onConnection(socket: WebSocket, ip: string): void;
}

export class WsHub {
  private wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  private ipCounts = new Map<string, number>();

  constructor(
    server: HttpServer,
    private options: WsHubOptions,
  ) {
    server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    if (!this.options.allowOrigin(req.headers.origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const ip = this.ipOf(req);
    const count = this.ipCounts.get(ip) ?? 0;
    if (count >= MAX_IP_CONNECTIONS) {
      socket.destroy();
      return;
    }
    this.ipCounts.set(ip, count + 1);
    this.wss.handleUpgrade(req, socket as never, head, (ws) => {
      ws.once('close', () => {
        const c = (this.ipCounts.get(ip) ?? 1) - 1;
        if (c <= 0) this.ipCounts.delete(ip);
        else this.ipCounts.set(ip, c);
      });
      this.options.onConnection(ws, ip);
    });
  }

  private ipOf(req: IncomingMessage): string {
    // X-Forwarded-For 可被客户端伪造：仅在显式声明可信反代（TRUST_PROXY=1）时采用，
    // 否则一律用 TCP 对端地址，防止绕过每 IP 连接/限流配额
    if (this.options.trustProxy) {
      const fwd = req.headers['x-forwarded-for'];
      if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  closeAll(): void {
    for (const client of this.wss.clients) client.terminate();
  }
}
