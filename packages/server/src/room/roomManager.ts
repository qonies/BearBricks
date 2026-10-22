// 房间管理：房间码生成（6 位去除 0/O/1/I）、创建/加入/快速匹配、IP 限流、TTL 回收、hello/重连

import type { WebSocket } from 'ws';
import { genRoomCode, genToken, Room, type Seat } from './room';
import { Session } from '../net/session';
import { config } from '../config';

const WINDOW_MS = 10 * 60_000;
const JOIN_FAIL_LIMIT = 10; // 房间码爆破防护（TC-SEC-004）
const SWEEP_INTERVAL_MS = 5000;
const ROOM_TTL_MS = 10 * 60_000;

interface HelloPayload {
  playerId: string;
  nickname: string;
  resumeToken?: string;
  roomCode?: string;
}

export class RoomManager {
  private rooms = new Map<string, Room>();
  private sessions = new Set<Session>();
  private roomCreates = new Map<string, number[]>();
  private joinFails = new Map<string, number[]>();
  private sweep: NodeJS.Timeout | null = null;

  constructor() {
    this.sweep = setInterval(() => this.sweepTick(), SWEEP_INTERVAL_MS);
  }

  createSession(ws: WebSocket, ip: string): void {
    const session = new Session(ws, ip, this);
    this.sessions.add(session);
    session.start();
  }

  sessionCount(): number {
    return this.sessions.size;
  }

  roomCount(): number {
    let count = 0;
    for (const room of this.rooms.values()) if (room.hasHumans()) count += 1;
    return count;
  }

  detach(session: Session): void {
    this.sessions.delete(session);
    if (session.stale) return; // 已被新连接接管：迟到的 close 不再触发断线处理
    if (session.room && session.seatId >= 0) session.room.handleDisconnect(session.seatId, session);
  }

  handleMessage(session: Session, t: string, d: unknown): void {
    if (t !== 'hello' && session.room) session.room.touch();
    switch (t) {
      case 'hello':
        return this.handleHello(session, d as HelloPayload);
      case 'room.create':
        return this.handleCreate(session, d as { visibility: 'public' | 'private' });
      case 'room.join':
        return this.handleJoin(session, d as { roomCode: string });
      case 'room.quickMatch':
        return this.handleQuickMatch(session);
      case 'room.leave':
        return this.handleLeave(session);
      case 'room.updateSettings':
        return session.room?.updateSettings(session, d);
      case 'room.addBot':
        return session.room?.addBot(session, d);
      case 'room.removeSeat':
        return session.room?.removeSeat(session, d);
      case 'game.ready':
        return session.room?.setReady(session, d);
      case 'game.start':
        return session.room?.start(session);
      case 'room.rematch':
        return session.room?.rematch(session);
      case 'game.input':
        return session.room?.handleInput(session, d);
      case 'game.inputBatch':
        return session.room?.handleInputBatch(session, d);
      case 'game.soft':
        return session.room?.handleSoft(session, d);
      case 'chat.send':
        return session.room?.chat(session, d);
      default:
        return session.sendError('E4031', '未实现的消息类型');
    }
  }

  // ===== 握手 / 重连 =====

  private handleHello(session: Session, d: HelloPayload): void {
    if (session.authenticated) return session.sendError('E4031', '重复发送 hello');
    session.playerId = d.playerId;
    session.nickname = d.nickname;
    session.authenticated = true;
    // 先尝试 resume（允许接管仍在线的旧连接，避免"旧连接未断开 → 恢复失败"竞态）
    let resumed: { room: Room; seatId: number } | null = null;
    if (d.resumeToken) resumed = this.findByResume(d.playerId, d.resumeToken);
    if (resumed && resumed.room.resumeSeat(resumed.seatId, session)) {
      session.send('welcome', {
        serverTime: Date.now(),
        session: {
          playerId: session.playerId,
          resumeToken: session.resumeToken ?? '',
          selfSeatId: resumed.seatId,
        },
        room: resumed.room.publicState(),
      });
      // welcome 之后再下发全量棋局（客户端先拿到身份，再重建对局）
      resumed.room.resendFullState(resumed.seatId);
      this.evictOtherSessions(session);
      return;
    }
    // 未恢复：同 playerId 的旧连接顶号下线
    this.evictOtherSessions(session);
    session.resumeToken = genToken();
    session.send('welcome', {
      serverTime: Date.now(),
      session: { playerId: session.playerId, resumeToken: session.resumeToken },
    });
    if (d.roomCode) this.handleJoin(session, { roomCode: d.roomCode });
  }

  /** 同 playerId 的其他旧连接顶号下线（resumeSeat 内部已处理座位持有者，这里兜底清剩余） */
  private evictOtherSessions(session: Session): void {
    for (const other of [...this.sessions]) {
      if (other === session || !other.authenticated || other.playerId !== session.playerId)
        continue;
      other.stale = true;
      if (other.room && other.seatId >= 0) other.room.handleDisconnect(other.seatId, other);
      other.room = null;
      other.seatId = -1;
      other.sendError('E4010', '该身份已在其他连接登录');
      other.close();
    }
  }

  /** resumeToken 匹配即视为可恢复座位；是否仍在线由 resumeSeat 接管处理 */
  private findByResume(playerId: string, token: string): { room: Room; seatId: number } | null {
    for (const room of this.rooms.values()) {
      for (const seat of room.seats) {
        if (seat.kind === 'human' && seat.playerId === playerId && seat.resumeToken === token) {
          return { room, seatId: seat.seatId };
        }
      }
    }
    return null;
  }

  // ===== 大厅 =====

  private handleCreate(session: Session, d: { visibility: 'public' | 'private' }): void {
    if (session.room) return session.sendError('E4031', '已在房间中，请先离开');
    const now = Date.now();
    const list = (this.roomCreates.get(session.ip) ?? []).filter((t) => now - t < WINDOW_MS);
    if (list.length >= config.roomCreateLimit)
      return session.rateLimitNotice('创建房间过于频繁（3 个/10 分钟）');
    list.push(now);
    this.roomCreates.set(session.ip, list);
    let code = genRoomCode();
    while (this.rooms.has(code)) code = genRoomCode();
    const room = new Room(code, d.visibility);
    this.rooms.set(code, room);
    if (!room.join(session)) {
      this.rooms.delete(code);
      return session.sendError('E4090', '房间创建失败');
    }
  }

  private handleJoin(session: Session, d: { roomCode: string }): void {
    if (session.room) return session.sendError('E4031', '已在房间中，请先离开');
    const room = this.rooms.get(d.roomCode);
    if (!room) return this.joinFail(session, 'E4040', '房间不存在');
    if (room.phase !== 'WAITING') return this.joinFail(session, 'E4090', '对局已开始，无法加入');
    if (!room.join(session)) return this.joinFail(session, 'E4090', '房间已满');
  }

  private joinFail(session: Session, code: 'E4040' | 'E4090', message: string): void {
    const now = Date.now();
    const list = (this.joinFails.get(session.ip) ?? []).filter((t) => now - t < WINDOW_MS);
    list.push(now);
    this.joinFails.set(session.ip, list);
    if (list.length > JOIN_FAIL_LIMIT) return session.rateLimitNotice('尝试过于频繁，请稍后再试');
    session.sendError(code, message);
  }

  private handleQuickMatch(session: Session): void {
    if (session.room) return session.sendError('E4031', '已在房间中，请先离开');
    for (const room of this.rooms.values()) {
      if (room.visibility === 'public' && room.phase === 'WAITING' && room.hasEmptySeat()) {
        if (room.join(session)) return;
      }
    }
    this.handleCreate(session, { visibility: 'public' });
  }

  private handleLeave(session: Session): void {
    if (!session.room) return;
    session.room.leaveSeat(session.seatId);
  }

  // ===== 定时清理 =====

  private sweepTick(): void {
    const now = Date.now();
    for (const room of [...this.rooms.values()]) {
      room.checkGrace(now);
      if (room.phase !== 'PLAYING' && now - room.lastActivity > ROOM_TTL_MS) {
        // 有人在等待的 WAITING 房不回收（protocol §9：回收对象是"WAITING 空房"与 FINISHED 房）
        if (room.phase === 'WAITING' && room.hasHumans()) continue;
        for (const seat of room.seats as Seat[]) {
          if (seat.session) {
            // 明确通知客户端房间已解散（客户端收 E4090 回大厅），避免静默孤儿会话
            seat.session.sendError('E4090', '房间已解散');
            seat.session.room = null;
            seat.session.seatId = -1;
          }
        }
        room.destroy();
        this.rooms.delete(room.code);
      }
    }
    this.pruneRateLimitMaps(now);
  }

  /** 限流窗口清理：防止以伪造 IP 无限增长键（内存 DoS） */
  private pruneRateLimitMaps(now: number): void {
    for (const [ip, list] of this.roomCreates) {
      const kept = list.filter((t) => now - t < WINDOW_MS);
      if (kept.length === 0) this.roomCreates.delete(ip);
      else this.roomCreates.set(ip, kept);
    }
    for (const [ip, list] of this.joinFails) {
      const kept = list.filter((t) => now - t < WINDOW_MS);
      if (kept.length === 0) this.joinFails.delete(ip);
      else this.joinFails.set(ip, kept);
    }
  }

  getRoom(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  shutdown(): void {
    if (this.sweep) clearInterval(this.sweep);
    for (const room of this.rooms.values()) room.destroy();
    for (const session of this.sessions) session.shutdown();
  }
}
