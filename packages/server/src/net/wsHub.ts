// wsHub：升级握手（/ws 路径 + Origin 校验 + 每 IP 并发/全服并发上限）、消息分发入口
// 拒绝一律回 HTTP 状态码后断开（浏览器拿不到握手状态码，但反代/探针/日志可区分原因）。

import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { config } from '../config';
import { noopLogger, type Logger } from '../log';

// 与 session 的 4KB 上限一致；maxPayload 在 ws 层拒收超大帧，避免先缓冲再检查的内存 DoS
const MAX_PAYLOAD_BYTES = 4096;

export interface WsHubOptions {
  allowOrigin(origin: string | undefined): boolean;
  /** 仅在可信反代后开启：信任 x-forwarded-for 获取真实客户端 IP（限流维度） */
  trustProxy?: boolean;
  onConnection(socket: WebSocket, ip: string): void;
  log?: Logger;
}

export class WsHub {
  private wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  private ipCounts = new Map<string, number>();
  private total = 0;
  private log: Logger;

  constructor(
    server: HttpServer,
    private options: WsHubOptions,
  ) {
    this.log = options.log ?? noopLogger;
    server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    if (!this.options.allowOrigin(req.headers.origin)) {
      this.reject(socket, 403, 'Forbidden');
      return;
    }
    const ip = this.ipOf(req);
    const count = this.ipCounts.get(ip) ?? 0;
    const perIp = config.maxIpConnections;
    const totalCap = config.maxConnections;
    if (perIp > 0 && count >= perIp) {
      // 同 NAT 出口（办公室/宿舍）最容易撞这条：默认已放宽到 20，可用 MAX_CONN_PER_IP 覆盖
      this.log.warn({ event: 'ws.reject', reason: 'ip-limit', count }, 'ws upgrade rejected');
      this.reject(socket, 429, 'Too Many Connections');
      return;
    }
    if (totalCap > 0 && this.total >= totalCap) {
      this.log.warn({ event: 'ws.reject', reason: 'total-limit', total: this.total }, 'ws upgrade rejected');
      this.reject(socket, 503, 'Server Busy');
      return;
    }
    this.ipCounts.set(ip, count + 1);
    this.total += 1;
    this.wss.handleUpgrade(req, socket as never, head, (ws) => {
      ws.once('close', () => {
        const c = (this.ipCounts.get(ip) ?? 1) - 1;
        if (c <= 0) this.ipCounts.delete(ip);
        else this.ipCounts.set(ip, c);
        this.total = Math.max(0, this.total - 1);
      });
      this.options.onConnection(ws, ip);
    });
  }

  /** 回明确 HTTP 状态码再断开（裸 destroy 会让客户端/反代只能看到"连接被重置"） */
  private reject(socket: Duplex, code: number, text: string): void {
    if (socket.writable) {
      // end() 会在 flush 响应后关闭；write 后立即 destroy 可能丢掉 429/503 状态行
      socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    } else {
      socket.destroy();
    }
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
