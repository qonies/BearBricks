// 房间（M3）：WAITING→COUNTDOWN→PLAYING→FINISHED 状态机、60Hz GameLoop（漂移补偿）、
// 快照节流（己方 20Hz / 对手 10Hz，变化才发）、断线宽限 30s（sprint 超时移出排名 / survival 判淘汰）、
// 模式策略（ADR-0005）：sprint 无攻击；survival 攻击/垃圾行/淘汰

import { randomUUID, randomInt } from 'node:crypto';
import {
  Rng,
  RESPAWN_DELAY_MS,
  SPRINT_TIMEOUT_MS,
  BotController,
  TetrisGame,
  TIMED_DEFAULT_TIME_LIMIT,
  TIMED_IMMUNE_MS,
  buildOtherSeatSnapshot,
  buildSelfSnapshot,
  computeSprintRanking,
  computeSurvivalRanking,
  computeTimedRanking,
  createModeStrategy,
  otherSeatHash,
  pickHoleColumn,
  type Difficulty,
  type GameAttackPayload,
  type GameInputPayload,
  type GameModeName,
  type GameModeStrategy,
  type GameResultPayload,
  type LastClear,
  type OtherSeatSnapshot,
  type RoomState,
  type Seat as PublicSeat,
  type SeatPlayStatus,
  type SelfSnapshot,
} from '@bearbricks/shared';
import type { Session } from '../net/session';

const STEP_MS = 1000 / 60;
const SELF_SNAPSHOT_EVERY = 3; // 20Hz
const OTHERS_SNAPSHOT_EVERY = 6; // 10Hz
const GRACE_MS = 30_000;
const COUNTDOWN_MS = 3_000;
const INPUT_RATE_LIMIT = 60; // action/s
const CHAT_PER_10S = 10;
const GARBAGE_BUFFER_TICKS = 30; // 500ms 缓冲（requirements §4.3，60Hz tick）
const GARBAGE_BATCH_MAX = 8; // 单批插入上限，超出留下批

export interface Seat {
  seatId: number;
  kind: 'human' | 'bot' | 'empty';
  nickname: string | null;
  playerId: string | null;
  difficulty: Difficulty | null;
  ready: boolean;
  online: boolean;
  session: Session | null;
  resumeToken: string | null;
  game: TetrisGame | null;
  seed: string | null;
  pendingInputs: GameInputPayload[];
  softDrop: boolean;
  lastSeq: number;
  actionTimes: number[];
  chatTimes: number[];
  lastSelfKey: string;
  seenOthers: Map<number, string>;
  finished: boolean;
  finishTimeMs: number | null;
  abandoned: boolean;
  lines: number;
  disconnectedAt: number | null;
  /** M5：AI 控制器（一局一个，beginGame 创建）；null = 非 bot 座位 */
  bot: BotController | null;
  /** survival：待接收垃圾行数（offset 目标 / 红色预警条） */
  pendingGarbage: number;
  /** 到期插入 tick（500ms 缓冲）；null = 无待插入 */
  garbageDueTick: number | null;
  /** 垃圾行洞列 RNG（独立种子，不污染方块序列的 bag RNG） */
  garbageRng: Rng | null;
  /** survival：已淘汰（转观战） */
  eliminated: boolean;
  eliminatedAtMs: number | null;
  /** 顶出次数（timed 排名用；survival 记账） */
  topOuts: number;
  /** timed：复活倒计时截止 tick（期间棋盘冻结/输入丢弃/不收发攻击）；null = 不在倒计时 */
  respawnUntilTick: number | null;
  /** timed：免伤截止 tick（复活后 3s 不收发攻击）；null = 无免伤 */
  immuneUntilTick: number | null;
}

function emptySeat(seatId: number): Seat {
  return {
    seatId,
    kind: 'empty',
    nickname: null,
    playerId: null,
    difficulty: null,
    ready: false,
    online: false,
    session: null,
    resumeToken: null,
    game: null,
    seed: null,
    pendingInputs: [],
    softDrop: false,
    lastSeq: 0,
    actionTimes: [],
    chatTimes: [],
    lastSelfKey: '',
    seenOthers: new Map(),
    finished: false,
    finishTimeMs: null,
    abandoned: false,
    lines: 0,
    disconnectedAt: null,
    bot: null,
    pendingGarbage: 0,
    garbageDueTick: null,
    garbageRng: null,
    eliminated: false,
    eliminatedAtMs: null,
    topOuts: 0,
    respawnUntilTick: null,
    immuneUntilTick: null,
  };
}

export function genToken(): string {
  return `rt_${randomUUID().replace(/-/g, '')}`;
}

function genSeed(): string {
  return `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function uniqueNickname(base: string, seats: Seat[]): string {
  const name = base.trim().slice(0, 12) || '玩家';
  const taken = new Set(seats.filter((s) => s.kind === 'human').map((s) => s.nickname));
  if (!taken.has(name)) return name;
  // 冲突加后缀，但整体不得超过昵称上限 12 字符
  for (let i = 2; ; i++) {
    const suffix = `-${i}`;
    const candidate = name.slice(0, 12 - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}

export class Room {
  phase: 'WAITING' | 'COUNTDOWN' | 'PLAYING' | 'FINISHED' = 'WAITING';
  readonly seats: Seat[];
  hostSeat = 0;
  settings: { mode: GameModeName; targetLines: 20 | 40; timeLimit: number } = {
    mode: 'sprint',
    targetLines: 40,
    timeLimit: TIMED_DEFAULT_TIME_LIMIT,
  };
  tick = 0;
  lastActivity = Date.now();

  /** 模式策略（ADR-0005）：跟随 settings.mode 更新，Room 不写模式分支 */
  private strategy: GameModeStrategy;
  private loop: NodeJS.Timeout | null = null;
  private loopStart = 0;
  private countdownTimer: NodeJS.Timeout | null = null;
  /** 最近一次对局结果（FINISHED 阶段断线重连时补发，客户端才能显示结算屏） */
  private lastResult: GameResultPayload | null = null;

  constructor(
    readonly code: string,
    readonly visibility: 'public' | 'private',
  ) {
    this.seats = [0, 1, 2, 3].map(emptySeat);
    this.strategy = createModeStrategy(this.settings.mode);
  }

  // ===== 状态与广播 =====

  publicState(): RoomState {
    return {
      roomCode: this.code,
      visibility: this.visibility,
      phase: this.phase,
      hostSeat: this.hostSeat,
      settings: {
        mode: this.settings.mode,
        targetLines: this.settings.mode === 'sprint' ? this.settings.targetLines : undefined,
        timeLimit:
          this.settings.mode === 'timed' ? (this.settings.timeLimit as 120 | 180 | 300) : undefined,
      },
      seats: this.seats.map((s): PublicSeat => {
        if (s.kind === 'empty') return { seatId: s.seatId, kind: 'empty' };
        if (s.kind === 'bot') {
          return {
            seatId: s.seatId,
            kind: 'bot',
            nickname: s.nickname ?? undefined,
            difficulty: s.difficulty ?? undefined,
          };
        }
        return {
          seatId: s.seatId,
          kind: 'human',
          nickname: s.nickname ?? undefined,
          // 安全：不下发 playerId（防同房间成员伪造 hello 顶号）；客户端以 selfSeatId 定位自己
          ready: s.ready,
          online: s.online,
        };
      }),
    };
  }

  broadcast(t: string, d: unknown): void {
    for (const s of this.seats) {
      if (s.kind === 'human' && s.session) s.session.send(t, d);
    }
  }

  /** room.state 广播：载荷携带接收者自身的 selfSeatId（playerId 不再下发，客户端据此定位自己） */
  private broadcastRoomState(): void {
    const room = this.publicState();
    for (const s of this.seats) {
      if (s.kind === 'human' && s.session)
        s.session.send('room.state', { room, selfSeatId: s.seatId });
    }
  }

  private sendToSeat(seat: Seat, t: string, d: unknown): void {
    seat.session?.send(t, d);
  }

  touch(): void {
    this.lastActivity = Date.now();
  }

  hasHumans(): boolean {
    return this.seats.some((s) => s.kind === 'human');
  }

  hasEmptySeat(): boolean {
    return this.seats.some((s) => s.kind === 'empty');
  }

  // ===== 座位生命周期 =====

  join(session: Session): boolean {
    if (this.phase !== 'WAITING') return false;
    // FR-4.3：优先空位；无空位但有 AI 座位时真人可替换（仅 WAITING）
    let seat = this.seats.find((s) => s.kind === 'empty');
    if (!seat) {
      seat = this.seats.find((s) => s.kind === 'bot');
      if (!seat) return false;
    }
    seat.kind = 'human';
    seat.nickname = uniqueNickname(session.nickname, this.seats);
    seat.playerId = session.playerId;
    seat.difficulty = null;
    // 房主补位：hostSeat 若已无人（房主离开且仅剩 AI 的房间），加入者自动成为房主（FR-2.3）
    if (this.seats[this.hostSeat].kind !== 'human') this.hostSeat = seat.seatId;
    seat.ready = seat.seatId === this.hostSeat; // 房主默认已准备（FR-2.5）
    seat.online = true;
    seat.session = session;
    seat.resumeToken = session.resumeToken;
    session.room = this;
    session.seatId = seat.seatId;
    this.touch();
    this.broadcast('chat.system', { code: 'JOIN', params: { nickname: seat.nickname } });
    this.broadcastRoomState();
    return true;
  }

  leaveSeat(seatId: number, opts: { kicked?: boolean } = {}): void {
    const seat = this.seats[seatId];
    if (!seat || seat.kind === 'empty') return;
    const nickname = seat.nickname;
    if (seat.session) {
      seat.session.room = null;
      seat.session.seatId = -1;
    }
    const wasPlaying = this.phase === 'PLAYING' && !seat.abandoned;
    this.seats[seatId] = emptySeat(seatId);
    if (this.hostSeat === seatId) this.transferHost();
    if (wasPlaying) this.maybeFinish();
    this.touch();
    this.broadcast('chat.system', {
      code: opts.kicked ? 'KICKED' : 'LEAVE',
      params: { nickname: nickname ?? '' },
    });
    this.broadcastRoomState();
  }

  /** 断线处理：session 身份校验防止"旧连接迟到的 close 误清新会话已接管的座位" */
  handleDisconnect(seatId: number, session?: Session): void {
    const seat = this.seats[seatId];
    if (!seat || seat.kind !== 'human' || !seat.online) return;
    if (session && seat.session !== session) return; // 座位已被其他连接接管
    seat.online = false;
    seat.session = null;
    seat.disconnectedAt = Date.now();
    this.touch();
    this.broadcastRoomState();
  }

  /**
   * 断线宽限（FR-10）：由 roomManager 定时扫描调用。
   * PLAYING 中宽限超时按模式处置（FR-10.3）：
   * - sprint → 移出排名（abandoned，resumeToken 作废）
   * - survival → 判淘汰（转观战，仍可聊天）
   * - timed → 计一次顶出并继续复活循环（座位与 resumeToken 保留，可迟到的 resume 恢复）
   */
  checkGrace(now: number): void {
    for (const seat of this.seats) {
      if (seat.kind !== 'human' || seat.online || !seat.disconnectedAt) continue;
      if (now - seat.disconnectedAt <= GRACE_MS) continue;
      if (this.phase !== 'PLAYING') {
        this.leaveSeat(seat.seatId);
        continue;
      }
      // 每个座位只处置一次
      seat.disconnectedAt = null;
      if (this.settings.mode === 'timed') {
        // timed：计顶出并继续复活循环（不 abandoned，仍参与排名）
        this.markSeatGameEnded(seat);
      } else if (this.settings.mode === 'survival') {
        seat.eliminated = true;
        seat.eliminatedAtMs = seat.game?.finishTimeMs ?? seat.game?.elapsedMs ?? 0;
        seat.topOuts += 1;
        this.broadcast('game.topOut', { seatId: seat.seatId, action: 'ELIMINATE' });
        this.broadcast('chat.system', {
          code: 'TOP_OUT',
          params: { seatId: seat.seatId, nickname: seat.nickname ?? '' },
        });
      } else {
        // sprint：移出排名，同时作废 resumeToken（不可再恢复）
        seat.abandoned = true;
        seat.resumeToken = null;
        this.broadcast('chat.system', { code: 'LEAVE', params: { nickname: seat.nickname ?? '' } });
      }
      if (this.hostSeat === seat.seatId) this.transferHost();
      this.maybeFinish();
      this.broadcastRoomState();
    }
  }

  /** 断线重连/接管：允许对仍在线的旧连接强制接管（先 resume 后顶号，避免竞态导致恢复失败） */
  resumeSeat(seatId: number, session: Session): boolean {
    const seat = this.seats[seatId];
    if (!seat || seat.kind !== 'human' || seat.playerId !== session.playerId) return false;
    if (seat.abandoned || !seat.resumeToken) return false; // 已判放弃/已作废 → 按新会话处理
    if (seat.session && seat.session !== session) {
      // 旧连接顶号下线：清引用并标记 stale，其迟到的 close 不会误清本座位
      const stale = seat.session;
      stale.stale = true;
      stale.room = null;
      stale.seatId = -1;
      stale.sendError('E4010', '该身份已在其他连接登录');
      stale.close();
    }
    const token = genToken(); // resumeToken 一次性轮换
    seat.resumeToken = token;
    session.resumeToken = token;
    seat.session = session;
    seat.online = true;
    seat.disconnectedAt = null;
    // 断线前的持续态/未消费输入不应跨断线生效：软降复位（否则恢复后棋盘自己下冲）、
    // 陈旧输入清空（客户端会按 seq 基线重放未确认输入）
    seat.softDrop = false;
    seat.pendingInputs = [];
    session.room = this;
    session.seatId = seatId;
    // 重连后快照去重缓存失效：确保己方/对手板立即重发，否则要等下一次变化
    seat.seenOthers.clear();
    seat.lastSelfKey = '';
    this.touch();
    this.broadcastRoomState();
    return true;
  }

  /** 座位对局状态（protocol v1.5：self 快照与对手快照同一口径） */
  private seatPlayStatus(seat: Seat): SeatPlayStatus {
    return seat.abandoned
      ? 'abandoned'
      : seat.eliminated
        ? 'eliminated'
        : seat.finished
          ? 'finished'
          : 'playing';
  }

  /** 重连恢复（PLAYING）：下发全量态（welcome 之后调用，保证客户端先拿到身份） */
  resendFullState(seatId: number): void {
    const seat = this.seats[seatId];
    if (!seat || seat.kind !== 'human' || !seat.game || !seat.seed) return;
    this.sendToSeat(seat, 'game.state.full', {
      seatId,
      tick: this.tick,
      seq: seat.lastSeq,
      seed: seat.seed,
      self: buildSelfSnapshot(seat.game, this.tick, seat.lastSeq, this.selfModeState(seat), this.seatPlayStatus(seat)),
      room: this.publicState(),
    });
    // FINISHED 阶段重连：game.result 是"过去时"，必须补发，否则客户端没有结算屏/再来一局
    if (this.phase === 'FINISHED' && this.lastResult) {
      this.sendToSeat(seat, 'game.result', this.lastResult);
    }
  }

  private transferHost(): void {
    // 房主转让优先给在线真人（protocol §7"最早加入的在线玩家"，座位序近似加入顺序）；
    // 全部离线时退而求其次给宽限中的真人（恢复后成为房主）；绝不转让给 AI；
    // 无其他真人时保持原值（空座位加入者由 join 补位为房主）
    const next =
      this.seats.find((s) => s.kind === 'human' && s.online && s.seatId !== this.hostSeat) ??
      this.seats.find((s) => s.kind === 'human' && s.seatId !== this.hostSeat);
    if (next) {
      this.hostSeat = next.seatId;
      next.ready = true;
    }
  }

  private maybeFinish(): void {
    const occupied = this.seats.filter((s) => s.kind !== 'empty');
    if (occupied.length === 0) return;
    if (this.settings.mode === 'survival') {
      // ADR-0004：仅剩 1 人（或全员同刻顶出 → 0 人）存活 → 结束。
      // 口径用 survivalAliveSeats：宽限期内的离线真人尚未判淘汰（FR-10.3），不能提前终局
      if (this.survivalAliveSeats().length <= 1) this.finishGame('finished');
      return;
    }
    if (occupied.every((s) => s.finished || s.abandoned)) this.finishGame('finished');
  }

  /**
   * survival 结束判定/存活数口径（FR-10.2/10.3）：已淘汰、已放弃、已完赛者不计；
   * 宽限期内的离线真人仍算存活（棋盘冻结但未判负），避免断线瞬间提前终局。
   */
  private survivalAliveSeats(): Seat[] {
    return this.seats.filter(
      (s) => s.kind !== 'empty' && s.game != null && !s.eliminated && !s.finished && !s.abandoned,
    );
  }

  /** 攻击目标口径（survival/timed）：在 survivalAliveSeats 基础上再排除离线宽限者（FR-10.2：宽限期不收发攻击） */
  private aliveSeats(): Seat[] {
    return this.survivalAliveSeats().filter((s) => !(s.kind === 'human' && !s.online));
  }

  /** 攻击目标最终口径（§4.3）：survival 用 aliveSeats；timed 再排除复活倒计时/免伤窗内的座位（§4.5） */
  private attackTargets(): Seat[] {
    const base = this.aliveSeats();
    if (this.settings.mode !== 'timed') return base;
    return base.filter(
      (s) => s.respawnUntilTick == null && (s.immuneUntilTick == null || this.tick >= s.immuneUntilTick),
    );
  }

  /** 当前模式下的己方快照 modeState（protocol §5） */
  private selfModeState(seat: Seat): SelfSnapshot['modeState'] {
    if (this.settings.mode === 'survival') {
      // 存活数用结束判定口径（宽限期内的离线真人仍计入，FR-10.3 判淘汰前不算死）
      return {
        survival: { aliveCount: this.survivalAliveSeats().length, pendingGarbage: seat.pendingGarbage },
      };
    }
    if (this.settings.mode === 'timed') {
      // 时刻统一换算为服务器 epoch ms（loopStart + tick 基准），客户端直接与本地时钟比较
      const timed: NonNullable<SelfSnapshot['modeState']['timed']> = {
        endsAt: this.loopStart + this.settings.timeLimit * 1000,
        // v1.5：timed 与 survival 同口径的攻击预警（红色预警条数据源）
        ...(seat.pendingGarbage > 0 ? { pendingGarbage: seat.pendingGarbage } : {}),
      };
      if (seat.respawnUntilTick != null)
        timed.respawnAt = this.loopStart + seat.respawnUntilTick * STEP_MS;
      if (seat.immuneUntilTick != null)
        timed.immuneUntil = this.loopStart + seat.immuneUntilTick * STEP_MS;
      return { timed };
    }
    return { sprint: { target: this.settings.targetLines } };
  }

  // ===== 房主控制（仅 WAITING） =====

  updateSettings(session: Session, d: unknown): void {
    const p = d as { mode: GameModeName; targetLines?: 20 | 40; timeLimit?: 120 | 180 | 300 };
    if (session.seatId !== this.hostSeat) return session.sendError('E4030', '仅房主可修改设置');
    if (this.phase !== 'WAITING') return session.sendError('E4031', '仅等待中可修改设置');
    // 防御性二次校验（schema 已限 120/180/300，此处兜底非 timed 模式携带 timeLimit）
    if (p.timeLimit != null && p.mode !== 'timed')
      return session.sendError('E4031', 'timeLimit 仅限时赛支持');
    if (p.mode === 'timed') {
      if (p.timeLimit != null) this.settings.timeLimit = p.timeLimit;
      else if (this.settings.mode !== 'timed') this.settings.timeLimit = TIMED_DEFAULT_TIME_LIMIT;
    }
    this.settings.mode = p.mode;
    this.strategy = createModeStrategy(p.mode);
    if (p.targetLines === 20 || p.targetLines === 40) this.settings.targetLines = p.targetLines;
    this.touch();
    this.broadcastRoomState();
  }

  addBot(session: Session, d: unknown): void {
    const p = d as { seatId: number; difficulty: Difficulty };
    if (session.seatId !== this.hostSeat) return session.sendError('E4030', '仅房主可添加 AI');
    if (this.phase !== 'WAITING') return session.sendError('E4031', '仅等待中可添加 AI');
    const seat = this.seats[p.seatId];
    if (!seat || seat.kind !== 'empty') return session.sendError('E4031', '目标座位不可用');
    seat.kind = 'bot';
    seat.nickname = `Bot-${p.difficulty}`;
    seat.difficulty = p.difficulty;
    seat.ready = true;
    this.touch();
    this.broadcastRoomState();
  }

  removeSeat(session: Session, d: unknown): void {
    const p = d as { seatId: number };
    if (session.seatId !== this.hostSeat) return session.sendError('E4030', '仅房主可移除玩家');
    if (this.phase !== 'WAITING') return session.sendError('E4031', '仅等待中可移除');
    const seat = this.seats[p.seatId];
    if (!seat || seat.kind === 'empty' || p.seatId === this.hostSeat) {
      return session.sendError('E4031', '目标座位不可移除');
    }
    if (seat.kind === 'human' && seat.session) {
      seat.session.sendError('E4030', '你已被房主移出房间', 'kicked');
    }
    this.leaveSeat(p.seatId, { kicked: true });
  }

  setReady(session: Session, d: unknown): void {
    const p = d as { ready: boolean };
    const seat = this.seats[session.seatId];
    if (!seat || seat.kind !== 'human' || seat.session !== session) {
      return session.sendError('E4031', '无效座位');
    }
    if (this.phase !== 'WAITING') return session.sendError('E4031', '仅等待中可准备');
    seat.ready = p.ready;
    this.touch();
    this.broadcastRoomState();
  }

  start(session: Session): void {
    if (session.seatId !== this.hostSeat) return session.sendError('E4030', '仅房主可开始');
    if (this.phase !== 'WAITING') return session.sendError('E4031', '当前状态不可开始');
    const occupied = this.seats.filter((s) => s.kind !== 'empty');
    if (occupied.length < 2)
      return session.sendError('E4031', '至少需要 2 个占用座位（真人或 AI）');
    const allReady = this.seats
      .filter((s) => s.kind === 'human')
      .every((s) => s.ready || s.seatId === this.hostSeat);
    if (!allReady) return session.sendError('E4031', '存在未准备的真人玩家');
    this.phase = 'COUNTDOWN';
    this.broadcast('room.countdown', { seconds: 3, startAt: Date.now() + COUNTDOWN_MS });
    this.broadcastRoomState();
    this.countdownTimer = setTimeout(() => this.beginGame(), COUNTDOWN_MS);
  }

  rematch(session: Session): void {
    if (session.seatId !== this.hostSeat) return session.sendError('E4030', '仅房主可再来一局');
    if (this.phase !== 'FINISHED') return session.sendError('E4031', '当前状态不可再来一局');
    this.phase = 'WAITING';
    for (const seat of this.seats) {
      if (seat.kind === 'empty') continue;
      seat.game = null;
      seat.seed = null;
      seat.pendingInputs = [];
      seat.softDrop = false;
      seat.lastSeq = 0;
      seat.finished = false;
      seat.finishTimeMs = null;
      seat.abandoned = false;
      seat.lines = 0;
      seat.pendingGarbage = 0;
      seat.garbageDueTick = null;
      seat.garbageRng = null;
      seat.eliminated = false;
      seat.eliminatedAtMs = null;
      seat.topOuts = 0;
      seat.respawnUntilTick = null;
      seat.immuneUntilTick = null;
      seat.bot = null;
      seat.seenOthers.clear();
      seat.lastSelfKey = '';
      if (seat.kind === 'human') seat.ready = seat.seatId === this.hostSeat;
    }
    this.tick = 0;
    this.lastResult = null;
    this.touch();
    this.broadcastRoomState();
  }

  // ===== GameLoop（60Hz 固定步长 + 漂移补偿） =====

  private beginGame(): void {
    if (this.phase !== 'COUNTDOWN') return;
    // 倒计时期间座位可能变化：重新校验开局条件，不满足则回 WAITING
    const occupiedNow = this.seats.filter((s) => s.kind !== 'empty');
    if (occupiedNow.length < 2) {
      this.phase = 'WAITING';
      this.broadcastRoomState();
      return;
    }
    this.phase = 'PLAYING';
    const seeds: Record<string, string> = {};
    const engineMode = this.strategy.engineMode(); // sprint：引擎内超时/清盘；survival：marathon 语义 + Room 层淘汰
    for (const seat of this.seats) {
      if (seat.kind === 'empty') continue;
      const seed = genSeed();
      seat.seed = seed;
      seeds[String(seat.seatId)] = seed;
      seat.game = new TetrisGame({ mode: engineMode, targetLines: this.settings.targetLines, seed });
      seat.pendingInputs = [];
      seat.softDrop = false;
      seat.lastSeq = 0;
      seat.actionTimes = [];
      seat.lastSelfKey = '';
      seat.seenOthers.clear();
      seat.finished = false;
      seat.finishTimeMs = null;
      seat.abandoned = seat.kind === 'human' && !seat.online;
      seat.lines = 0;
      seat.bot =
        seat.kind === 'bot'
          ? new BotController(seat.difficulty ?? 'NORMAL', {
              // 误操作 RNG 从对局 seed 派生：同 seed 同难度 bot 行为可复现（服务端权威可重放）
              rng: new Rng(`${seed}:bot`),
              // survival/timed 为攻击模式：评估对 4 消（Tetris）加分（技术设计 §6 HARD 压制策略）
              attackMode: this.settings.mode !== 'sprint',
            })
          : null;
      seat.pendingGarbage = 0;
      seat.garbageDueTick = null;
      seat.garbageRng = new Rng(`${seed}:garbage`);
      seat.eliminated = false;
      seat.eliminatedAtMs = null;
      seat.topOuts = 0;
      seat.respawnUntilTick = null;
      seat.immuneUntilTick = null;
    }
    this.tick = 0;
    this.loopStart = Date.now();
    this.broadcast('chat.system', { code: 'START' });
    this.broadcast('game.start', {
      mode: this.settings.mode,
      targetLines: this.settings.targetLines,
      timeLimit: this.settings.mode === 'timed' ? this.settings.timeLimit : undefined,
      seeds,
      startTs: this.loopStart,
    });
    this.loop = setInterval(() => this.onTimer(), STEP_MS);
  }

  private onTimer(): void {
    const target = Math.floor((Date.now() - this.loopStart) / STEP_MS);
    let steps = target - this.tick;
    if (steps <= 0) return;
    if (steps > 10) {
      // 事件循环阻塞较久：直接对齐起点，避免追赶风暴
      this.loopStart = Date.now() - this.tick * STEP_MS;
      steps = 1;
    }
    for (let i = 0; i < steps; i++) this.tickStep();
  }

  private tickStep(): void {
    this.tick += 1;
    for (const seat of this.seats) {
      if (seat.kind === 'empty' || !seat.game || seat.abandoned || seat.eliminated || seat.finished) continue;
      if (seat.kind === 'human' && !seat.online) continue; // 断线宽限期：棋盘冻结（FR-10.2），不推进重力/锁定、不收垃圾
      // timed 免伤窗到期清理（attackTargets 已按 tick 判断生效，此处复位字段以同步快照 modeState）
      if (seat.immuneUntilTick != null && this.tick >= seat.immuneUntilTick) seat.immuneUntilTick = null;
      // timed 复活倒计时：棋盘已清但冻结（不推进重力/输入/垃圾），到点自动恢复对局（免伤窗另计）
      if (seat.respawnUntilTick != null) {
        if (this.tick >= seat.respawnUntilTick) seat.respawnUntilTick = null;
        else continue;
      }
      const game = seat.game;
      this.insertDueGarbage(seat, game); // 500ms 缓冲到期的垃圾行先插入，本 tick 输入在其上结算
      seat.pendingInputs.sort((a, b) => a.seq - b.seq);
      while (seat.pendingInputs.length > 0) {
        const input = seat.pendingInputs[0];
        seat.pendingInputs.shift();
        if (input.seq <= seat.lastSeq) continue;
        game.applyInput(input.action);
        seat.lastSeq = input.seq;
      }
      game.setSoftDrop(seat.softDrop);
      game.update(STEP_MS);
      seat.lines = game.lines;
      // 消行 → 策略层攻击（sprint 返回 null）→ offset/转发（每次锁定只结算一次）
      const clear = game.takeLastClear();
      if (clear) this.forwardAttack(seat, clear);
      if (game.status === 'finished') {
        this.markSeatGameEnded(seat);
      } else if (seat.kind === 'bot') {
        this.botTick(seat);
      }
    }
    // sprint 专有 300s 超时（requirements §4.4）；survival 无超时（最后存活者胜）；
    // timed 计时归零结束（endsAt 以服务器 tick 为准，requirements §4.4 §C）
    if (this.settings.mode === 'sprint' && this.tick * STEP_MS >= SPRINT_TIMEOUT_MS)
      return this.finishGame('timeout');
    if (this.settings.mode === 'timed' && this.tick * STEP_MS >= this.settings.timeLimit * 1000)
      return this.finishGame('timeout');
    this.maybeFinish();
    if (this.phase !== 'PLAYING') return;
    if (this.tick % SELF_SNAPSHOT_EVERY === 0) this.sendSelfSnapshots();
    if (this.tick % OTHERS_SNAPSHOT_EVERY === 0) this.sendOtherSnapshots();
  }

  /** 到期垃圾行插入（survival/timed）：单批 ≤8 行，同批同洞列；顶出方块被挤压时按模式处置 */
  private insertDueGarbage(seat: Seat, game: TetrisGame): void {
    if (this.settings.mode === 'sprint') return; // sprint 攻击关闭，无垃圾行
    if (seat.garbageDueTick == null || this.tick < seat.garbageDueTick) return;
    const rows = Math.min(GARBAGE_BATCH_MAX, seat.pendingGarbage);
    if (rows <= 0) {
      seat.garbageDueTick = null;
      return;
    }
    seat.pendingGarbage -= rows;
    seat.garbageDueTick = seat.pendingGarbage > 0 ? this.tick + GARBAGE_BUFFER_TICKS : null;
    const holeCol = seat.garbageRng ? pickHoleColumn(seat.garbageRng) : 0;
    // 引擎统一入口：棋盘上移 + active 随动上移 + 顶出/冲突校验（Guideline：垃圾推着当前块上升）
    game.receiveGarbage(rows, holeCol);
  }

  /** 消行攻击：先 1:1 抵消自己 pending 垃圾，剩余转发给其他存活对手（requirements §4.3） */
  private forwardAttack(from: Seat, clear: LastClear): void {
    const plan = this.strategy.onLinesCleared({
      lines: clear.lines,
      tspin: clear.tspin,
      combo: clear.combo,
      b2b: clear.b2b,
      perfectClear: clear.perfectClear,
    });
    if (!plan || plan.lines <= 0) return;
    const offset = Math.min(from.pendingGarbage, plan.lines);
    from.pendingGarbage -= offset;
    if (from.pendingGarbage <= 0) {
      from.pendingGarbage = 0;
      from.garbageDueTick = null;
    }
    const forwarded = plan.lines - offset;
    const targets = this.attackTargets().filter((s) => s.seatId !== from.seatId);
    if (forwarded <= 0 || targets.length === 0) return;
    for (const t of targets) {
      t.pendingGarbage += forwarded;
      t.garbageDueTick ??= this.tick + GARBAGE_BUFFER_TICKS;
    }
    const payload: GameAttackPayload = {
      fromSeat: from.seatId,
      lines: forwarded,
      targets: targets.map((t) => t.seatId),
    };
    this.broadcast('game.attack', payload);
  }

  /** 引擎对局结束的按模式处置：sprint 完赛 / survival 顶出淘汰（转观战）/ timed 顶出复活 */
  private markSeatGameEnded(seat: Seat): void {
    const game = seat.game;
    if (!game) return;
    if (this.settings.mode === 'timed') {
      // timed（requirements §4.4 §C / §4.5）：3s 复活倒计时（棋盘冻结）→ 棋盘清空、
      // 分数/消行保留、复活后 3s 免伤；待收垃圾随棋盘一并清空（免伤期内不接收攻击）；
      // 顶出前排队/按住的输入一并清空（复活后不得重放到新棋盘上）
      seat.topOuts += 1;
      seat.respawnUntilTick = this.tick + RESPAWN_DELAY_MS / STEP_MS;
      seat.immuneUntilTick = seat.respawnUntilTick + TIMED_IMMUNE_MS / STEP_MS;
      seat.pendingGarbage = 0;
      seat.garbageDueTick = null;
      seat.pendingInputs = [];
      seat.softDrop = false;
      game.respawn();
      this.broadcast('game.topOut', { seatId: seat.seatId, action: 'RESPAWN' });
      this.broadcast('chat.system', {
        code: 'RESPAWN',
        params: { seatId: seat.seatId, nickname: seat.nickname ?? '' },
      });
      return;
    }
    if (this.settings.mode !== 'survival') {
      seat.finished = true;
      seat.finishTimeMs = game.finishTimeMs;
      return;
    }
    seat.eliminated = true;
    seat.eliminatedAtMs = game.finishTimeMs ?? game.elapsedMs;
    seat.topOuts += 1;
    this.broadcast('game.topOut', { seatId: seat.seatId, action: 'ELIMINATE' });
    this.broadcast('chat.system', {
      code: 'TOP_OUT',
      params: { seatId: seat.seatId, nickname: seat.nickname ?? '' },
    });
  }

  /** M5 BotController（技术设计 §6）：每 tick decide() 产出 ≤1 个动作，经与真人相同的 game.applyInput 通道执行 */
  private botTick(seat: Seat): void {
    const game = seat.game;
    if (!game) return;
    const action = seat.bot?.decide(game);
    if (!action) return;
    game.applyInput(action);
    seat.lines = game.lines;
    if (game.status === 'finished') this.markSeatGameEnded(seat);
  }

  // ===== 快照（己方 20Hz / 对手 10Hz，变化才发） =====

  private sendSelfSnapshots(): void {
    for (const seat of this.seats) {
      if (seat.kind !== 'human' || !seat.game || !seat.session || seat.abandoned) continue;
      const snap = buildSelfSnapshot(
        seat.game,
        this.tick,
        seat.lastSeq,
        this.selfModeState(seat),
        this.seatPlayStatus(seat),
      );
      const timed = snap.modeState.timed;
      const key = `${snap.seq}:${snap.h}:${snap.modeState.survival?.pendingGarbage ?? 0}:${timed?.pendingGarbage ?? 0}:${timed?.respawnAt ?? 0}:${timed?.immuneUntil ?? 0}:${snap.status ?? ''}`;
      if (key === seat.lastSelfKey) continue;
      seat.lastSelfKey = key;
      this.sendToSeat(seat, 'game.snapshot.self', snap);
    }
  }

  private sendOtherSnapshots(): void {
    const snapshots = new Map<number, OtherSeatSnapshot>();
    const hashes = new Map<number, string>();
    const survival = this.settings.mode === 'survival';
    for (const seat of this.seats) {
      if (seat.kind === 'empty' || !seat.game) continue;
      const snap = buildOtherSeatSnapshot(
        seat.game,
        seat.seatId,
        this.seatPlayStatus(seat),
        survival ? seat.pendingGarbage : undefined,
      );
      snapshots.set(seat.seatId, snap);
      hashes.set(seat.seatId, otherSeatHash(snap));
    }
    for (const viewer of this.seats) {
      if (viewer.kind !== 'human' || !viewer.session) continue;
      const seats: OtherSeatSnapshot[] = [];
      for (const [seatId, snap] of snapshots) {
        if (seatId === viewer.seatId) continue;
        const hash = hashes.get(seatId) as string;
        if (hash !== viewer.seenOthers.get(seatId)) {
          viewer.seenOthers.set(seatId, hash);
          seats.push(snap);
        }
      }
      if (seats.length > 0)
        this.sendToSeat(viewer, 'game.snapshot.others', { tick: this.tick, seats });
    }
  }

  // ===== 输入 =====

  handleInput(session: Session, d: unknown): void {
    const p = d as GameInputPayload;
    const seat = this.seats[session.seatId];
    if (!seat || seat.session !== session || !seat.game) {
      return session.sendError('E4031', '当前不可接收输入');
    }
    if (this.phase !== 'PLAYING') {
      // FINISHED/COUNTDOWN 等阶段一律拒绝（否则结算后输入会无限堆积在 pendingInputs）
      return session.sendError('E4031', '当前不在对局中');
    }
    if (seat.abandoned || seat.finished || seat.eliminated) return; // 已放弃/已完赛/已淘汰：静默丢弃（客户端会在终局停止发送）
    if (seat.respawnUntilTick != null) return; // timed 复活倒计时：输入静默丢弃（客户端冻结输入；重放日志由复活事件清空）
    if (p.seq <= seat.lastSeq) return; // 重复/过期输入静默丢弃
    const now = Date.now();
    seat.actionTimes = seat.actionTimes.filter((t) => now - t < 1000);
    if (seat.actionTimes.length >= INPUT_RATE_LIMIT) {
      return session.rateLimitNotice('输入过于频繁（>60/s），已丢弃');
    }
    seat.actionTimes.push(now);
    seat.pendingInputs.push(p);
  }

  handleInputBatch(session: Session, d: unknown): void {
    const p = d as { actions: GameInputPayload[] };
    for (const item of p.actions) this.handleInput(session, item);
  }

  handleSoft(session: Session, d: unknown): void {
    const p = d as { on: boolean };
    if (this.phase !== 'PLAYING') return;
    const seat = this.seats[session.seatId];
    if (!seat || seat.session !== session || !seat.game) return;
    seat.softDrop = p.on;
  }

  // ===== 结束与结算 =====

  private finishGame(reason: 'finished' | 'timeout'): void {
    if (this.phase !== 'PLAYING') return;
    this.stopTimers();
    this.phase = 'FINISHED';
    const occupied = this.seats.filter((s) => s.kind !== 'empty');
    let ranking: GameResultPayload['ranking'];
    if (this.settings.mode === 'survival') {
      // survival 排名：存活者并列第 1，淘汰顺序倒序；abandoned（宽限超时判淘汰，FR-10.3）垫底
      const ranks = computeSurvivalRanking(
        occupied.map((s) => ({
          seatId: s.seatId,
          eliminatedAtMs: s.eliminatedAtMs,
          abandoned: s.abandoned,
        })),
      );
      ranking = occupied.map((s) => ({
        seatId: s.seatId,
        nickname: s.nickname ?? `座位${s.seatId}`,
        rank: ranks.get(s.seatId) ?? 0,
        timeMs: s.eliminatedAtMs,
        lines: s.lines,
        // v1.3：eliminated 单列（不再混用 finished）；abandoned = 宽限超时判淘汰垫底
        status: (s.abandoned ? 'abandoned' : s.eliminated ? 'eliminated' : 'finished') as
          | 'abandoned'
          | 'eliminated'
          | 'finished',
      }));
    } else if (this.settings.mode === 'timed') {
      // timed 排名（requirements §4.4 §C）：总分 → 消行数 → 顶出次数；abandoned 移出排名（与 sprint 一致）
      const ranked = occupied.filter((s) => !s.abandoned);
      const ranks = computeTimedRanking(
        ranked.map((s) => ({
          seatId: s.seatId,
          score: s.game?.score ?? 0,
          lines: s.lines,
          topOuts: s.topOuts,
        })),
      );
      ranking = ranked.map((s) => ({
        seatId: s.seatId,
        nickname: s.nickname ?? `座位${s.seatId}`,
        rank: ranks.get(s.seatId) ?? 0,
        timeMs: null,
        lines: s.lines,
        score: s.game?.score ?? 0,
        status: 'finished' as const,
      }));
    } else {
      // sprint：放弃者移出排名（protocol §3），避免出现 rank 0 的“第0名”
      const ranked = occupied.filter((s) => !s.abandoned);
      const ranks = computeSprintRanking(
        ranked.map((s) => ({
          seatId: s.seatId,
          finishTimeMs: s.finishTimeMs,
          lines: s.lines,
          abandoned: false,
        })),
      );
      ranking = ranked.map((s) => ({
        seatId: s.seatId,
        nickname: s.nickname ?? `座位${s.seatId}`,
        rank: ranks.get(s.seatId) ?? 0,
        timeMs: s.finishTimeMs,
        lines: s.lines,
        status: (s.finishTimeMs != null ? 'finished' : 'timeout') as 'finished' | 'timeout',
      }));
    }
    // 平局并列第 1 时逐个播报（system 消息不漏人；i18n 模板需要 nickname 占位）
    for (const winner of ranking.filter((r) => r.rank === 1))
      this.broadcast('chat.system', {
        code: 'VICTORY',
        params: { seatId: winner.seatId, nickname: winner.nickname },
      });
    this.lastResult = { mode: this.settings.mode, reason, ranking };
    this.broadcast('game.result', this.lastResult);
    this.touch();
    this.broadcastRoomState();
  }

  // ===== 聊天（FR-9：≤200 字符、1 条/s 且 10 条/10s、清洗控制字符） =====

  chat(session: Session, d: unknown): void {
    const p = d as { text: string };
    const seat = this.seats[session.seatId];
    if (!seat || seat.kind !== 'human' || seat.session !== session) {
      return session.sendError('E4031', '无效座位');
    }
    const now = Date.now();
    seat.chatTimes = seat.chatTimes.filter((t) => now - t < 10_000);
    if (seat.chatTimes.length >= CHAT_PER_10S)
      return session.rateLimitNotice('发言过于频繁（10 条/10 秒）');
    const last = seat.chatTimes[seat.chatTimes.length - 1];
    if (last != null && now - last < 1000)
      return session.rateLimitNotice('发言过于频繁（1 条/秒）');
    seat.chatTimes.push(now);
    // FR-9.3 清洗：去控制字符 + 截断；纯空白消息不广播
    const text = p.text.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
    if (!text) return;
    this.broadcast('chat.message', {
      seatId: seat.seatId,
      nickname: seat.nickname ?? '',
      text,
      ts: now,
    });
  }

  // ===== 清理 =====

  stopTimers(): void {
    if (this.loop) {
      clearInterval(this.loop);
      this.loop = null;
    }
    if (this.countdownTimer) {
      clearTimeout(this.countdownTimer);
      this.countdownTimer = null;
    }
  }

  destroy(): void {
    this.stopTimers();
  }
}

export function genRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[randomInt(chars.length)];
  return code;
}
