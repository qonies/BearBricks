// BearBricks WebSocket 协议（protocol.md v1.4）：Zod schema 双端复用
// 信封：{ t, ts, seq?(上行输入), sseq?(下行序号), d }
// 坐标约定：board/active 均为数组 top-down（index 0 = 顶部隐藏行），与引擎一致

import { z } from 'zod';

// ===== 基础 =====

export const PIECE_TYPE_SCHEMA = z.enum(['I', 'O', 'T', 'S', 'Z', 'J', 'L']);
export const GAME_ACTION_SCHEMA = z.enum([
  'moveL',
  'moveR',
  'rotCW',
  'rotCCW',
  'soft',
  'hard',
  'hold',
]);
export const ROOM_CODE_SCHEMA = z
  .string()
  .regex(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/, 'invalid room code');
export const NICKNAME_SCHEMA = z.string().trim().min(1).max(12);
export const SEAT_ID_SCHEMA = z.number().int().min(0).max(3);
export const DIFFICULTY_SCHEMA = z.enum(['EASY', 'NORMAL', 'HARD']);
export const MODE_SCHEMA = z.enum(['sprint', 'survival', 'timed']);

export const ACTIVE_PIECE_SCHEMA = z.object({
  type: PIECE_TYPE_SCHEMA,
  x: z.number().int(),
  y: z.number().int(),
  rot: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
});

export const SEAT_SCHEMA = z.object({
  seatId: SEAT_ID_SCHEMA,
  kind: z.enum(['human', 'bot', 'empty']),
  nickname: z.string().max(12).optional(),
  // 注意：不下发 playerId（防同房间成员伪造身份顶号）；客户端以 welcome/room.state 的 selfSeatId 定位自己
  difficulty: DIFFICULTY_SCHEMA.optional(),
  ready: z.boolean().optional(),
  online: z.boolean().optional(),
});

export const ROOM_SETTINGS_SCHEMA = z.object({
  mode: MODE_SCHEMA,
  targetLines: z.union([z.literal(20), z.literal(40)]).optional(),
  /** timed 限时赛时长（秒）：120/180/300（FR-2.6） */
  timeLimit: z.union([z.literal(120), z.literal(180), z.literal(300)]).optional(),
});

export const ROOM_STATE_SCHEMA = z.object({
  roomCode: ROOM_CODE_SCHEMA,
  visibility: z.enum(['public', 'private']),
  phase: z.enum(['WAITING', 'COUNTDOWN', 'PLAYING', 'FINISHED']),
  hostSeat: SEAT_ID_SCHEMA,
  settings: ROOM_SETTINGS_SCHEMA,
  seats: z.array(SEAT_SCHEMA).length(4),
});

// ===== 快照（§5，行编码 220 字符，无分隔符，top-down） =====

export const SELF_SNAPSHOT_SCHEMA = z.object({
  tick: z.number().int().nonnegative(),
  /** 服务器已应用的最大输入 seq（客户端据此重放未确认输入） */
  seq: z.number().int().nonnegative(),
  /** 状态指纹（变化才发 + 客户端一致性比较） */
  h: z.string(),
  board: z.string().length(220),
  active: ACTIVE_PIECE_SCHEMA.nullable(),
  queue: z.array(PIECE_TYPE_SCHEMA).max(8),
  hold: PIECE_TYPE_SCHEMA.nullable(),
  canHold: z.boolean(),
  score: z.number().int(),
  lines: z.number().int(),
  level: z.number().int(),
  combo: z.number().int(),
  b2b: z.boolean(),
  elapsedMs: z.number(),
  /** 模式状态：sprint 目标行数；survival 存活数 + 自己待接收垃圾行（红色预警条）；
   *  timed（v1.4）：endsAt 归零时刻（服务器 epoch ms）；respawnAt 复活倒计时截止；immuneUntil 免伤截止 */
  modeState: z.object({
    sprint: z.object({ target: z.number().int() }).optional(),
    survival: z
      .object({
        aliveCount: z.number().int().nonnegative(),
        pendingGarbage: z.number().int().nonnegative(),
      })
      .optional(),
    timed: z
      .object({
        endsAt: z.number(),
        respawnAt: z.number().optional(),
        immuneUntil: z.number().optional(),
      })
      .optional(),
  }),
});

export const OTHER_SEAT_SNAPSHOT_SCHEMA = z.object({
  seatId: SEAT_ID_SCHEMA,
  board: z.string().length(220),
  active: ACTIVE_PIECE_SCHEMA.nullable(),
  score: z.number().int(),
  lines: z.number().int(),
  /** eliminated：survival 淘汰（转观战，M3） */
  status: z.enum(['playing', 'finished', 'eliminated', 'abandoned']),
  /** survival：该对手待接收垃圾行数（攻击预警可视化，M3） */
  pendingGarbage: z.number().int().nonnegative().optional(),
});

// ===== C→S 载荷 =====

export const HELLO_SCHEMA = z.object({
  playerId: z.string().uuid(),
  nickname: NICKNAME_SCHEMA,
  resumeToken: z.string().min(8).max(64).optional(),
  roomCode: ROOM_CODE_SCHEMA.optional(),
});
export const ROOM_CREATE_SCHEMA = z.object({ visibility: z.enum(['public', 'private']) });
export const ROOM_JOIN_SCHEMA = z.object({ roomCode: ROOM_CODE_SCHEMA });
export const ROOM_QUICK_MATCH_SCHEMA = z.object({});
export const ROOM_LEAVE_SCHEMA = z.object({});
export const ROOM_UPDATE_SETTINGS_SCHEMA = z.object({
  mode: MODE_SCHEMA,
  targetLines: z.union([z.literal(20), z.literal(40)]).optional(),
  timeLimit: z.union([z.literal(120), z.literal(180), z.literal(300)]).optional(),
});
export const ROOM_ADD_BOT_SCHEMA = z.object({
  seatId: SEAT_ID_SCHEMA,
  difficulty: DIFFICULTY_SCHEMA,
});
export const ROOM_REMOVE_SEAT_SCHEMA = z.object({ seatId: SEAT_ID_SCHEMA });
export const GAME_READY_SCHEMA = z.object({ ready: z.boolean() });
export const GAME_START_SCHEMA = z.object({});
export const ROOM_REMATCH_SCHEMA = z.object({});
export const GAME_INPUT_SCHEMA = z.object({
  seq: z.number().int().positive(),
  action: GAME_ACTION_SCHEMA,
});
export const GAME_INPUT_BATCH_SCHEMA = z.object({
  actions: z.array(GAME_INPUT_SCHEMA).min(1).max(32),
});
export const GAME_SOFT_SCHEMA = z.object({ on: z.boolean() });
export const CHAT_SEND_SCHEMA = z.object({ text: z.string().min(1).max(200) });
export const PONG_SCHEMA = z.object({ id: z.number().int() });

/** C→S 消息注册表：t → 载荷 schema */
export const C2S_SCHEMAS = {
  hello: HELLO_SCHEMA,
  'room.create': ROOM_CREATE_SCHEMA,
  'room.join': ROOM_JOIN_SCHEMA,
  'room.quickMatch': ROOM_QUICK_MATCH_SCHEMA,
  'room.leave': ROOM_LEAVE_SCHEMA,
  'room.updateSettings': ROOM_UPDATE_SETTINGS_SCHEMA,
  'room.addBot': ROOM_ADD_BOT_SCHEMA,
  'room.removeSeat': ROOM_REMOVE_SEAT_SCHEMA,
  'game.ready': GAME_READY_SCHEMA,
  'game.start': GAME_START_SCHEMA,
  'room.rematch': ROOM_REMATCH_SCHEMA,
  'game.input': GAME_INPUT_SCHEMA,
  'game.inputBatch': GAME_INPUT_BATCH_SCHEMA,
  'game.soft': GAME_SOFT_SCHEMA,
  'chat.send': CHAT_SEND_SCHEMA,
  pong: PONG_SCHEMA,
} as const;

export type C2SType = keyof typeof C2S_SCHEMAS;
export type GameInputPayload = z.infer<typeof GAME_INPUT_SCHEMA>;

/** 校验 C→S 载荷；未知类型或校验失败返回 ok:false（由调用方决定 E4001/E4031）。
 *  查表必须用自有属性判断：普通对象上 '__proto__'/'toString' 等键会命中原型链，
 *  取到非 schema 值后调用 safeParse 会抛 TypeError（可被单条消息打挂进程）。 */
export function validateC2S(
  t: string,
  d: unknown,
): { ok: true; data: unknown } | { ok: false; known: boolean } {
  if (!Object.hasOwn(C2S_SCHEMAS, t)) return { ok: false, known: false };
  const schema = (C2S_SCHEMAS as Record<string, z.ZodTypeAny>)[t];
  const result = schema.safeParse(d);
  return result.success ? { ok: true, data: result.data } : { ok: false, known: true };
}

// ===== S→C 载荷 =====

export const WELCOME_SCHEMA = z.object({
  serverTime: z.number(),
  session: z.object({
    playerId: z.string(),
    resumeToken: z.string(),
    /** resume 成功时的座位号（客户端据此定位自己，替代原先广播的 playerId） */
    selfSeatId: SEAT_ID_SCHEMA.optional(),
  }),
  room: ROOM_STATE_SCHEMA.optional(),
});

export const ERROR_SCHEMA = z.object({
  code: z.enum(['E4001', 'E4010', 'E4030', 'E4031', 'E4040', 'E4090', 'E4290', 'E5000', 'E4999']),
  message: z.string(),
  reason: z.string().optional(),
});

export const ROOM_COUNTDOWN_SCHEMA = z.object({
  seconds: z.number().int(),
  /** 服务器计划开局的毫秒时间戳（客户端显示用，权威以 tick 为准） */
  startAt: z.number(),
});

export const GAME_START_S2C_SCHEMA = z.object({
  mode: MODE_SCHEMA,
  targetLines: z.number().int(),
  /** timed 限时赛时长（秒，v1.4）；其他模式省略 */
  timeLimit: z.number().int().optional(),
  /** 各座位方块序列种子（seatId → seed）；对手板本就可见，无窥探增益 */
  seeds: z.record(z.string()),
  startTs: z.number(),
});

export const RANKING_ENTRY_SCHEMA = z.object({
  seatId: SEAT_ID_SCHEMA,
  nickname: z.string(),
  rank: z.number().int(),
  timeMs: z.number().nullable(),
  lines: z.number().int(),
  /** v1.4：timed 排名展示总分 */
  score: z.number().int().optional(),
  /** eliminated = survival 淘汰；abandoned = 断线宽限超时/主动放弃 */
  status: z.enum(['finished', 'timeout', 'eliminated', 'abandoned']),
});

export const GAME_RESULT_SCHEMA = z.object({
  mode: MODE_SCHEMA,
  reason: z.enum(['finished', 'timeout']),
  ranking: z.array(RANKING_ENTRY_SCHEMA),
});

export const GAME_TOP_OUT_SCHEMA = z.object({
  seatId: SEAT_ID_SCHEMA,
  action: z.enum(['ELIMINATE', 'RESPAWN', 'RESET_BOARD']),
});

/** M3 survival：一次消行攻击（offset 后实际转发的行数），全房间广播用于攻击指示 */
export const GAME_ATTACK_SCHEMA = z.object({
  fromSeat: SEAT_ID_SCHEMA,
  lines: z.number().int().min(1),
  targets: z.array(SEAT_ID_SCHEMA).min(1),
});

export const PING_SCHEMA = z.object({ id: z.number().int() });

export const CHAT_MESSAGE_SCHEMA = z.object({
  seatId: SEAT_ID_SCHEMA,
  nickname: z.string(),
  text: z.string().max(200),
  ts: z.number(),
});

export const CHAT_SYSTEM_SCHEMA = z.object({
  code: z.enum(['JOIN', 'LEAVE', 'KICKED', 'TOP_OUT', 'RESPAWN', 'VICTORY', 'START']),
  params: z.record(z.union([z.string(), z.number()])).optional(),
});

export const GAME_STATE_FULL_SCHEMA = z.object({
  seatId: SEAT_ID_SCHEMA,
  tick: z.number().int().nonnegative(),
  seq: z.number().int().nonnegative(),
  seed: z.string(),
  self: SELF_SNAPSHOT_SCHEMA,
  room: ROOM_STATE_SCHEMA,
});

// ===== 信封 =====

export const ENVELOPE_SCHEMA = z.object({
  t: z.string().min(1).max(32),
  ts: z.number().optional(),
  seq: z.number().optional(),
  sseq: z.number().optional(),
  d: z.unknown(),
});

export interface Envelope {
  t: string;
  ts?: number;
  seq?: number;
  sseq?: number;
  d: unknown;
}

// ===== 类型导出 =====
// （PieceType / GameAction 以 engine 导出为准，此处不重复导出避免冲突）

export type Difficulty = z.infer<typeof DIFFICULTY_SCHEMA>;
export type GameModeName = z.infer<typeof MODE_SCHEMA>;
export type ActivePieceData = z.infer<typeof ACTIVE_PIECE_SCHEMA>;
export type Seat = z.infer<typeof SEAT_SCHEMA>;
export type RoomSettings = z.infer<typeof ROOM_SETTINGS_SCHEMA>;
export type RoomState = z.infer<typeof ROOM_STATE_SCHEMA>;
export type SelfSnapshot = z.infer<typeof SELF_SNAPSHOT_SCHEMA>;
export type OtherSeatSnapshot = z.infer<typeof OTHER_SEAT_SNAPSHOT_SCHEMA>;
export type WelcomePayload = z.infer<typeof WELCOME_SCHEMA>;
export type ErrorPayload = z.infer<typeof ERROR_SCHEMA>;
export type RoomCountdownPayload = z.infer<typeof ROOM_COUNTDOWN_SCHEMA>;
export type GameStartPayload = z.infer<typeof GAME_START_S2C_SCHEMA>;
export type GameResultPayload = z.infer<typeof GAME_RESULT_SCHEMA>;
export type GameStateFullPayload = z.infer<typeof GAME_STATE_FULL_SCHEMA>;
export type GameAttackPayload = z.infer<typeof GAME_ATTACK_SCHEMA>;
export type RankingEntry = z.infer<typeof RANKING_ENTRY_SCHEMA>;
export type ChatMessagePayload = z.infer<typeof CHAT_MESSAGE_SCHEMA>;
