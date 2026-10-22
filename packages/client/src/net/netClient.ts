// WebSocket 客户端封装（technical-design §5.4）：
// hello（携带 resumeToken）→ welcome；断线指数退避重连（1s→10s）；服务器 ping → pong。
// 所有 S→C 消息按 t 分发到注册的 handler。

import type { Envelope, GameAction } from '@bearbricks/shared';
import { loadIdentity } from './identity';

export type NetStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting';

type Handler = (d: unknown) => void;
type StatusHandler = (s: NetStatus) => void;

const TOKEN_KEY = 'bearbricks.resumeToken';
const BACKOFF_STEP = 1000;
const BACKOFF_MAX = 10000;

export class NetClient {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<Handler>>();
  private statusListeners = new Set<StatusHandler>();
  private backoff = BACKOFF_STEP;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private manualClose = false;
  /** rehandshake 中：close 后立即以新身份重连 */
  private pendingRehandshake = false;

  status: NetStatus = 'idle';
  resumeToken: string | null = localStorage.getItem(TOKEN_KEY);

  constructor(private identity: () => { playerId: string; nickname: string }) {}

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
    this.statusListeners.forEach((h) => h(s));
  }

  connect(): void {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    this.manualClose = false;
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${window.location.host}/ws`);
    this.ws = ws;
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
      if (this.ws === ws) this.ws = null;
      if (this.manualClose) {
        this.setStatus('idle');
        if (this.pendingRehandshake) {
          this.pendingRehandshake = false;
          this.connect(); // 以最新身份重新 hello
        }
        return;
      }
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
    let msg: Envelope;
    try {
      msg = JSON.parse(raw) as Envelope;
    } catch {
      return;
    }
    const { t, d } = msg;
    if (t === 'ping') {
      const id = (d as { id?: number } | null)?.id ?? 0;
      this.rawSend('pong', { id });
      return;
    }
    if (t === 'welcome') {
      this.backoff = BACKOFF_STEP;
      const session = (d as { session?: { resumeToken?: string } } | null)?.session;
      if (session?.resumeToken) {
        this.resumeToken = session.resumeToken;
        localStorage.setItem(TOKEN_KEY, session.resumeToken);
      }
      this.setStatus('connected');
    }
    if (t === 'error' && (d as { code?: string } | null)?.code === 'E4010') {
      // 已在别处登录/被接管：清 token 并停止自动重连，避免同身份多标签互相顶号的死循环
      this.resumeToken = null;
      localStorage.removeItem(TOKEN_KEY);
      this.manualClose = true;
    }
    this.emit(t, d);
  }

  private emit(t: string, d: unknown): void {
    this.handlers.get(t)?.forEach((h) => h(d));
  }

  rawSend(t: string, d: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ t, ts: Date.now(), d }));
    }
  }

  send(t: string, d: unknown): void {
    this.rawSend(t, d);
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
