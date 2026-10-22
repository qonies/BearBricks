// 房间/联机状态（technical-design §5.2 useRoomStore）
// 服务端不下发 playerId：selfSeatId 由 room.state / welcome 载荷携带，用于定位自己

import { create } from 'zustand';
import type {
  ActivePieceData,
  GameModeName,
  GameResultPayload,
  OtherSeatSnapshot,
  RoomState,
  SelfSnapshot,
} from '@bearbricks/shared';

export interface MpStart {
  seed: string;
  /** 对局模式（ADR-0004）：驱动 NetGameRunner 引擎语义与 HUD */
  mode: GameModeName;
  targetLines: number;
  /** 开局服务器时间戳（用于对齐 HUD 计时起点）；断线重连恢复时为 null */
  startTs: number | null;
  /** 断线重连 game.state.full 恢复：挂载前直接应用的权威快照 */
  initial?: SelfSnapshot;
  /** 断线重连恢复：seq 基线（协议规定重连后不重置） */
  initialSeq?: number;
}

export interface OpponentView {
  seatId: number;
  board: string;
  active: ActivePieceData | null;
  score: number;
  lines: number;
  status: 'playing' | 'finished' | 'eliminated' | 'abandoned';
  /** survival：待接收垃圾行数（攻击预警可视化） */
  pendingGarbage?: number;
}

/** 聊天条目（FR-9）：用户消息 / 系统消息（i18n 渲染后的文本） */
export interface ChatEntry {
  kind: 'user' | 'system';
  seatId?: number;
  nickname?: string;
  text: string;
  ts: number;
}

const CHAT_LOG_MAX = 100;

interface RoomStore {
  room: RoomState | null;
  selfSeatId: number | null;
  opponents: Record<number, OpponentView>;
  countdown: number | null;
  result: GameResultPayload | null;
  mpStart: MpStart | null;
  toast: string | null;
  chatLog: ChatEntry[];
  setRoom: (room: RoomState | null, selfSeatId?: number | null) => void;
  setSelfSeatId: (id: number | null) => void;
  applyOthers: (seats: OtherSeatSnapshot[]) => void;
  setCountdown: (n: number | null) => void;
  setResult: (r: GameResultPayload | null) => void;
  setMpStart: (m: MpStart | null) => void;
  setToast: (msg: string | null) => void;
  appendChat: (entry: ChatEntry) => void;
  resetMp: () => void;
}

export const useRoomStore = create<RoomStore>()((set) => ({
  room: null,
  selfSeatId: null,
  opponents: {},
  countdown: null,
  result: null,
  mpStart: null,
  toast: null,
  chatLog: [],
  setRoom: (room, selfSeatId) =>
    set((st) => {
      if (!room) return { room: null, selfSeatId: null, opponents: {}, chatLog: [] };
      const sid = selfSeatId ?? st.selfSeatId;
      // 座位已清空/离开的对手视图同步清理（否则退出者的小板永远残留）
      const valid = new Set(room.seats.filter((s) => s.kind !== 'empty').map((s) => s.seatId));
      const opponents: Record<number, OpponentView> = {};
      for (const [id, view] of Object.entries(st.opponents)) {
        if (valid.has(Number(id))) opponents[Number(id)] = view;
      }
      // 房间码变化（进出房间）→ 聊天记录不跨房间残留
      const chatLog = st.room && st.room.roomCode !== room.roomCode ? [] : st.chatLog;
      return { room, selfSeatId: sid, opponents, chatLog };
    }),
  setSelfSeatId: (selfSeatId) => set({ selfSeatId }),
  applyOthers: (seats) =>
    set((st) => {
      const opponents = { ...st.opponents };
      for (const s of seats) {
        opponents[s.seatId] = {
          seatId: s.seatId,
          board: s.board,
          active: s.active,
          score: s.score,
          lines: s.lines,
          status: s.status,
          ...(s.pendingGarbage != null ? { pendingGarbage: s.pendingGarbage } : {}),
        };
      }
      return { opponents };
    }),
  setCountdown: (countdown) => set({ countdown }),
  setResult: (result) => set({ result }),
  setMpStart: (mpStart) => set({ mpStart }),
  setToast: (toast) => set({ toast }),
  appendChat: (entry) =>
    set((st) => ({ chatLog: [...st.chatLog.slice(-(CHAT_LOG_MAX - 1)), entry] })),
  resetMp: () =>
    set({ opponents: {}, result: null, mpStart: null, countdown: null, chatLog: [] }),
}));
