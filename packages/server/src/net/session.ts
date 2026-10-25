// 会话：playerId + resumeToken 绑定、心跳 ping/pong（默认 15s 一次，连续 2 个 ping 无响应 ≈30s 判定断线）、
// 入站信封解析与 Zod 校验（未知类型 E4031 / 校验失败 E4001，累计 10 次断开）、
// 每连接入站消息限流（默认 >120 条/s 直接断开，防应用层之外的 CPU DoS）、
// 下行背压保护（bufferedAmount 超限即断开慢客户端）、错误回包限速（防"非法请求 → 错误回包"放大）。
// 防御基线：信封必须是普通对象（防 JSON "null"）、t 查表用自有属性（防原型链键）、
// handleRaw 整体 try/catch——任何单条消息都不得让进程退出。

import type { WebSocket } from 'ws';
import { validateC2S, type Envelope, type ErrorPayload } from '@bearbricks/shared';
import { config } from '../config';
import type { Room } from '../room/room';
import type { RoomManager } from '../room/roomManager';

const MAX_VALIDATION_FAILURES = 10;

export class Session {
  readonly socket: WebSocket;
  readonly ip: string;

  playerId = '';
  nickname = '';
  authenticated = false;
  room: Room | null = null;
  seatId = -1;
  resumeToken: string | null = null;
  /** 被新连接接管/顶号标记：detach 时不再触发 handleDisconnect */
  stale = false;

  private pingId = 0;
  private lastPongId = 0;
  private validationFailures = 0;
  private heartbeat: NodeJS.Timeout | null = null;
  private lastRateLimitNotice = 0;
  /** 下行自增序号（protocol §1：所有 S→C 消息携带 sseq） */
  private sseq = 0;

  constructor(
    socket: WebSocket,
    ip: string,
    private manager: RoomManager,
  ) {
    this.socket = socket;
    this.ip = ip;
  }

  start(): void {
    this.socket.on('message', (data, isBinary) => {
      // 每连接入站限流（先于解析，防 4KB×N 帧 JSON.parse 的 CPU DoS）；超限直接断开
      if (!this.allowInbound()) {
        this.socket.terminate();
        return;
      }
      if (isBinary) {
        this.fail('E4001', '仅支持 JSON 文本帧');
        return;
      }
      const raw = data.toString();
      if (raw.length > 4096) {
        this.fail('E4001', '单消息超过 4KB 上限');
        this.socket.terminate();
        return;
      }
      try {
        this.handleRaw(raw);
      } catch {
        // 兜底：任何解析/处理异常都不允许冒泡成 uncaughtException
        this.fail('E4001', '消息处理失败');
      }
    });
    this.socket.on('close', () => {
      this.stopHeartbeat();
      this.manager.detach(this);
    });
    this.socket.on('error', () => this.socket.terminate());
    this.heartbeat = setInterval(() => {
      this.pingId += 1;
      this.send('ping', { id: this.pingId });
      // 连续 2 个 ping 未收到 pong（≈30s 无响应）→ 判定断线（protocol §7）
      if (this.pingId - this.lastPongId >= 2) {
        this.socket.terminate();
      }
    }, config.heartbeatMs);
  }

  /** 固定 1s 窗口的入站消息计数（protocol v1.5 口径）；false = 超过上限，应断开 */
  private allowInbound(): boolean {
    const now = Date.now();
    if (now - this.msgWindowStart >= 1000) {
      this.msgWindowStart = now;
      this.msgCount = 0;
    }
    this.msgCount += 1;
    return this.msgCount <= config.maxMsgPerSec;
  }

  private msgWindowStart = 0;
  private msgCount = 0;

  private handleRaw(raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.fail('E4001', 'JSON 解析失败');
      return;
    }
    // 信封守卫：JSON "null"/数组/原始值直接拒绝（否则 null.t 抛 TypeError 打挂进程）
    if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
      this.fail('E4001', '非法信封结构');
      return;
    }
    const env = msg as Envelope;
    if (typeof env.t !== 'string' || env.t.length === 0 || env.t.length > 32) {
      this.fail('E4001', '缺少消息类型');
      return;
    }
    if (env.t === 'pong') {
      const id = (env.d as { id?: number } | null)?.id;
      if (typeof id === 'number') this.lastPongId = Math.max(this.lastPongId, id);
      return;
    }
    const result = validateC2S(env.t, env.d);
    if (!result.ok) {
      // 边界：未知消息类型 → E4031（伪造/非法操作）；已知类型校验失败 → E4001
      this.fail(result.known ? 'E4001' : 'E4031', result.known ? '消息校验失败' : '未知的消息类型');
      return;
    }
    if (!this.authenticated && env.t !== 'hello') {
      // 未 hello 属状态错误（E4031），不能与"顶号"E4010 混用：客户端把 E4010 视为终态
      this.sendError('E4031', '请先发送 hello 完成身份握手');
      return;
    }
    this.manager.handleMessage(this, env.t, result.data);
  }

  private fail(code: 'E4001' | 'E4031', message: string): void {
    this.validationFailures += 1;
    this.sendError(code, message);
    if (this.validationFailures >= MAX_VALIDATION_FAILURES) this.socket.terminate();
  }

  send(t: string, d: unknown): void {
    if (this.socket.readyState !== this.socket.OPEN) return;
    // 背压保护（P2-4）：慢客户端积压超过阈值直接断开，重连后走 welcome + game.state.full 恢复，
    // 不让单个卡死的浏览器把服务端内存吃满
    const cap = config.maxSocketBufferBytes;
    if (cap > 0 && this.socket.bufferedAmount > cap) {
      this.socket.terminate();
      return;
    }
    this.socket.send(JSON.stringify({ t, sseq: ++this.sseq, ts: Date.now(), d }));
  }

  sendError(code: ErrorPayload['code'], message: string, reason?: string): void {
    // 错误回包限速（P2-8）：恶意客户端每帧触发一条错误回包会形成放大，
    // 超过上限直接断连（正常客户端不会接近该阈值）
    const now = Date.now();
    if (now - this.errWindowStart >= 1000) {
      this.errWindowStart = now;
      this.errCount = 0;
    }
    this.errCount += 1;
    if (this.errCount > config.maxErrorsPerSec) {
      this.socket.terminate();
      return;
    }
    this.send('error', { code, message, ...(reason ? { reason } : {}) });
  }

  private errWindowStart = 0;
  private errCount = 0;

  rateLimitNotice(message: string): void {
    const now = Date.now();
    if (now - this.lastRateLimitNotice > 1000) {
      this.lastRateLimitNotice = now;
      this.sendError('E4290', message);
    }
  }

  close(): void {
    this.socket.terminate();
  }

  /** 先让错误消息 flush 再断开（E4010 顶号提示不能像 terminate 一样被丢弃） */
  closeAfterFlush(delayMs = 100): void {
    this.stopHeartbeat();
    setTimeout(() => this.socket.terminate(), delayMs).unref();
  }

  stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  shutdown(): void {
    this.stopHeartbeat();
    this.sendError('E4999', '服务器即将关闭，请稍后重连');
    setTimeout(() => this.socket.terminate(), 100).unref();
  }
}
