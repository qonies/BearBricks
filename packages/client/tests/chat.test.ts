// 聊天/i18n：系统消息模板渲染 + RoomStore chatLog 生命周期（FR-9）

import { beforeEach, describe, expect, it } from 'vitest';
import type { RoomState } from '@bearbricks/shared';
import { formatSystemMessage } from '../src/i18n';
import { useRoomStore } from '../src/store/room';

function makeRoom(code: string): RoomState {
  return {
    roomCode: code,
    visibility: 'public',
    phase: 'WAITING',
    hostSeat: 0,
    settings: { mode: 'sprint', targetLines: 40 },
    seats: [
      { seatId: 0, kind: 'human', nickname: 'Alice', ready: true, online: true },
      { seatId: 1, kind: 'empty' },
      { seatId: 2, kind: 'empty' },
      { seatId: 3, kind: 'empty' },
    ],
  };
}

describe('formatSystemMessage（i18n 骨架，zh-CN）', () => {
  it('按 code 渲染并替换 {key} 参数', () => {
    expect(formatSystemMessage('JOIN', { nickname: 'Alice' })).toBe('Alice 加入了房间');
    expect(formatSystemMessage('LEAVE', { nickname: 'Bob' })).toBe('Bob 离开了房间');
    expect(formatSystemMessage('TOP_OUT', { nickname: 'Carol' })).toContain('Carol');
    expect(formatSystemMessage('VICTORY', { seatId: 1 })).toContain('获得胜利');
    expect(formatSystemMessage('START')).toBe('对局开始，祝你好运！');
  });

  it('缺少参数时占位符替换为空串；未知 code 回退为 code 本身', () => {
    expect(formatSystemMessage('JOIN')).toBe(' 加入了房间');
    expect(formatSystemMessage('UNKNOWN' as never)).toBe('UNKNOWN');
  });
});

describe('RoomStore chatLog', () => {
  beforeEach(() => {
    useRoomStore.getState().resetMp();
  });

  it('appendChat 追加消息并截断到 100 条', () => {
    const s = useRoomStore.getState();
    for (let i = 0; i < 120; i++) {
      s.appendChat({ kind: 'user', seatId: 0, nickname: 'A', text: `m${i}`, ts: i });
    }
    const log = useRoomStore.getState().chatLog;
    expect(log).toHaveLength(100);
    expect(log[0].text).toBe('m20');
    expect(log[99].text).toBe('m119');
  });

  it('resetMp 清空聊天记录', () => {
    const s = useRoomStore.getState();
    s.appendChat({ kind: 'system', text: 'hi', ts: 1 });
    expect(useRoomStore.getState().chatLog).toHaveLength(1);
    s.resetMp();
    expect(useRoomStore.getState().chatLog).toHaveLength(0);
  });

  it('房间码变化（进出房间）时清空聊天记录', () => {
    const s = useRoomStore.getState();
    s.setRoom(makeRoom('ABC234'), 0);
    s.appendChat({ kind: 'user', seatId: 0, nickname: 'A', text: 'hello', ts: 1 });
    expect(useRoomStore.getState().chatLog).toHaveLength(1);
    // 同房间多次 room.state 广播不清空
    s.setRoom(makeRoom('ABC234'), 0);
    expect(useRoomStore.getState().chatLog).toHaveLength(1);
    // 换房间 → 清空
    s.setRoom(makeRoom('XYZ789'), 0);
    expect(useRoomStore.getState().chatLog).toHaveLength(0);
  });
});
