// WebSocket 客户端封装（technical-design §5.4）：
// hello（携带 resumeToken）→ welcome；断线指数退避重连（1s→10s）；服务器 ping → pong。
// 所有 S→C 消息按 t 分发到注册的 handler。

import type { Envelope, GameAction } from '@bearbricks/shared';
import { loadIdentity } from './identity';

export type NetStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting';

type Handler = (d: unknown) => void;
/** failures：连续建连失败次数（0 = 本次连接正常）。UI 可据此区分"偶发抖动"与"根本连不上" */
type StatusHandler = (s: NetStatus, failures: number) => void;

const TOKEN_KEY = 'bearbricks.resumeToken';
const BACKOFF_STEP = 1000;
const BACKOFF_MAX = 10000;
/** 心跳看门狗：超过该时长未收到服务器任何消息则主动断开重连（P2-4 / FR-10.1） */
const WATCHDOG_MS = 30_000;

function readStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export class NetClient {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<Handler>>();
  private statusListeners = new Set<StatusHandler>();
  private backoff = BACKOFF_STEP;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private manualClose = false;
  /** rehandshake 中：close 后立即以新身份重连 */
  private pendingRehandshake = false;
  /** 被其他连接接管（E4010）：进入终态，不再排队/重连，等待用户刷新（P2-5） */
  displaced = false;
  /** 断线/重连期间排队的用户动作消息（welcome 后回放；游戏输入类不入队，P2-6） */
  private pendingSends: { t: string; d: unknown }[] = [];
  private lastMessageAt = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;

  status: NetStatus = 'idle';
  resumeToken: string | null = readStoredToken();
  /** 连续建连失败次数（welcome 后清零）：用于区分"偶发抖动"与"根本连不上"（P2-5） */
  connectFailures = 0;
  /** 服务器时钟偏移（server ts - 本地 Date.now()），timed 计时显示用，消除客户端时钟偏差 */
  private clockOffsetMs = 0;

  constructor(private identity: () => { playerId: string; nickname: string }) {}

  /** 以服务器时钟为基准的"当前时刻"（每条 S→C 消息的 ts 持续校正；timed HUD/冻结窗口用它比较） */
  serverNow(): number {
    return Date.now() + this.clockOffsetMs;
  }

  on(type: string, handler: Handler): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusListeners.add(handler);
    return () => this.statusListeners.delete(handler);
  }

  private setStatus(s: NetStatus): void {
    this.status = s;
    this.statusListeners.forEach((h) => h(s, this.connectFailures));
  }

  connect(): void {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    this.manualClose = false;
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${window.location.host}/ws`);
    this.ws = ws;
    this.startWatchdog();
    this.setStatus(this.backoff > BACKOFF_STEP ? 'reconnecting' : 'connecting');
    ws.onopen = () => {
      const id = this.identity();
      this.rawSend('hello', {
        playerId: id.playerId,
        nickname: id.nickname,
        ...(this.resumeToken ? { resumeToken: this.resumeToken } : {}),
      });
    };
    ws.onmessage = (ev) => this.handleMessage(String(ev.data));
    ws.onerror = () => ws.close();
    ws.onclose = () => {
      // 仅当关闭的是"当前"连接时才清引用：旧 socket 迟到的 close 不能吞掉新建的连接
      if (this.ws === ws) {
        this.ws = null;
        this.stopWatchdog();
      }
      if (this.manualClose) {
        this.setStatus('idle');
        if (this.pendingRehandshake) {
          this.pendingRehandshake = false;
          this.connect(); // 以最新身份重新 hello（排队的用户动作随新 welcome 回放）
        } else {
          this.pendingSends = [];
        }
        return;
      }
      // 异常断线：保留排队消息，重连 welcome 后回放
      this.connectFailures += 1;
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    this.setStatus('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX);
      this.connect();
    }, this.backoff);
  }

  private handleMessage(raw: string): void {
    this.lastMessageAt = Date.now();
    let msg: Envelope;
    try {
      msg = JSON.parse(raw) as Envelope;
    } catch {
      return;
    }
    if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return;
    const { t, d } = msg;
    // 服务器时钟偏移校正（忽略单向下行延迟，误差 ≤ RTT，远小于时钟偏差本身）
    if (typeof msg.ts === 'number' && Number.isFinite(msg.ts)) {
      this.clockOffsetMs = msg.ts - Date.now();
    }
    if (t === 'ping') {
      const id = (d as { id?: number } | null)?.id ?? 0;
      this.rawSend('pong', { id });
      return;
    }
    if (t === 'welcome') {
      this.backoff = BACKOFF_STEP;
      this.connectFailures = 0;
      const session = (d as { session?: { resumeToken?: string } } | null)?.session;
      if (session?.resumeToken) {
        this.resumeToken = session.resumeToken;
        try {
          localStorage.setItem(TOKEN_KEY, session.resumeToken);
        } catch {
          // 存储不可用（隐私模式）：token 仅本次会话有效，断线后走新会话
        }
      }
      this.displaced = false;
      this.setStatus('connected');
      this.flushQueue();
    }
    if (t === 'error' && (d as { code?: string } | null)?.code === 'E4010') {
      // 已在别处登录/被接管：清 token、进入终态并停止自动重连，
      // 避免同身份多标签互相顶号的死循环；UI 提示后由用户刷新/重开（P2-5）
      this.clearResumeToken();
      this.displaced = true;
      this.pendingSends = [];
      this.stopWatchdog();
      this.manualClose = true;
    }
    this.emit(t, d);
  }

  private emit(t: string, d: unknown): void {
    this.handlers.get(t)?.forEach((h) => h(d));
  }

  /** 游戏输入类消息不入队：断线期间服务端棋盘冻结，重放陈旧输入没有意义 */
  private queueable(t: string): boolean {
    return (
      t !== 'pong' &&
      t !== 'hello' &&
      t !== 'game.input' &&
      t !== 'game.inputBatch' &&
      t !== 'game.soft'
    );
  }

  rawSend(t: string, d: unknown): void {
    const open = !!this.ws && this.ws.readyState === WebSocket.OPEN;
    // hello/pong 在 welcome 之前也必须发；其它动作等 welcome 后再发，避免“未 hello”竞态
    if (open && (t === 'hello' || t === 'pong' || this.status === 'connected')) {
      this.ws!.send(JSON.stringify({ t, ts: Date.now(), d }));
      return;
    }
    if (this.queueable(t) && !this.displaced && this.pendingSends.length < 50) {
      this.pendingSends.push({ t, d });
    }
  }

  /** 连接建立（welcome）后回放排队的用户动作 */
  private flushQueue(): void {
    const queued = this.pendingSends;
    this.pendingSends = [];
    for (const m of queued) this.rawSend(m.t, m.d);
  }

  private startWatchdog(): void {
    this.lastMessageAt = Date.now();
    if (this.watchdog) return;
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastMessageAt > WATCHDOG_MS) {
        this.lastMessageAt = Date.now();
        this.ws?.close(); // 触发 onclose → 指数退避重连
      }
    }, 5000);
  }

  private stopWatchdog(): void {
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  /** 主动离开房间时清除 resumeToken：避免断线重连后被 resume 拉回已退出的对局（P2-7） */
  clearResumeToken(): void {
    this.resumeToken = null;
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      // ignore
    }
  }

  send(t: string, d: unknown): void {
    this.rawSend(t, d);
  }

  /**
   * 立即重连（iPad/Safari 回前台、bfcache 恢复、网络恢复时调用）：
   * 后台期间定时器被节流/挂起，指数退避可能让用户白等最多 10s。
   * 仍有新鲜流量时不做任何事（避免打断正常握手）；连接已陈旧则关闭等待 onclose 走 1s 重连。
   */
  reconnectNow(): void {
    if (this.displaced || this.manualClose) return;
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.CONNECTING) return;
    // 打开且最近 20s 内收到过服务器消息 → 连接健康，不打断
    if (ws && ws.readyState === WebSocket.OPEN && Date.now() - this.lastMessageAt < 20_000) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.backoff = BACKOFF_STEP;
    if (ws && ws.readyState <= WebSocket.OPEN) {
      ws.close(); // onclose → scheduleReconnect（backoff 已复位为 1s）
      return;
    }
    this.connect();
  }

  input(seq: number, action: GameAction): void {
    this.rawSend('game.input', { seq, action });
  }

  inputBatch(actions: { seq: number; action: GameAction }[]): void {
    this.rawSend('game.inputBatch', { actions });
  }

  soft(on: boolean): void {
    this.rawSend('game.soft', { on });
  }

  close(): void {
    this.manualClose = true;
    this.pendingRehandshake = false;
    this.pendingSends = [];
    this.stopWatchdog();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
    this.setStatus('idle');
  }

  /** 身份变更（如改昵称）后重建握手：断开当前连接并以最新身份重新 hello（仅大厅场景调用） */
  rehandshake(): void {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) {
      this.pendingRehandshake = true;
      this.manualClose = true;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.ws.close();
      return;
    }
    this.connect();
  }
}

export const net = new NetClient(loadIdentity);
