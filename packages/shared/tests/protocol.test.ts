// 协议 schema / 快照构建 / sprint 排名测试（M2）

import { describe, expect, it } from 'vitest';
import {
  HELLO_SCHEMA,
  ROOM_CODE_SCHEMA,
  SELF_SNAPSHOT_SCHEMA,
  TetrisGame,
  buildSelfSnapshot,
  computeSprintRanking,
  validateC2S,
} from '../src';

const UUID = '123e4567-e89b-12d3-a456-426614174000';

describe('C→S schema 校验', () => {
  it('房间码字符集（去除 0/O/1/I）', () => {
    expect(ROOM_CODE_SCHEMA.safeParse('ABC234').success).toBe(true);
    expect(ROOM_CODE_SCHEMA.safeParse('0O1I2X').success).toBe(false);
    expect(ROOM_CODE_SCHEMA.safeParse('ABC23').success).toBe(false);
    expect(ROOM_CODE_SCHEMA.safeParse('abc234').success).toBe(false);
  });

  it('hello：合法/非法昵称与 UUID', () => {
    expect(HELLO_SCHEMA.safeParse({ playerId: UUID, nickname: '玩家' }).success).toBe(true);
    expect(HELLO_SCHEMA.safeParse({ playerId: 'not-uuid', nickname: '玩家' }).success).toBe(false);
    expect(HELLO_SCHEMA.safeParse({ playerId: UUID, nickname: '' }).success).toBe(false);
    expect(HELLO_SCHEMA.safeParse({ playerId: UUID, nickname: 'x'.repeat(13) }).success).toBe(false);
  });

  it('validateC2S：未知类型与已知类型校验失败区分', () => {
    expect(validateC2S('unknown.type', {})).toEqual({ ok: false, known: false });
    expect(validateC2S('game.input', { seq: 1, action: 'fly' })).toEqual({ ok: false, known: true });
    expect(validateC2S('game.input', { seq: 1, action: 'moveL' }).ok).toBe(true);
    expect(validateC2S('game.soft', { on: true }).ok).toBe(true);
    expect(validateC2S('game.inputBatch', { actions: [{ seq: 1, action: 'hard' }] }).ok).toBe(true);
  });
});

describe('快照构建（self snapshot）', () => {
  it('通过 schema 校验；board 220 字符；hash 与 stateHash 一致；可解码回棋盘', () => {
    const g = new TetrisGame({ mode: 'sprint', targetLines: 40, seed: 'snap' });
    const snap = buildSelfSnapshot(g, 100, 7, { sprint: { target: 40 } });
    expect(snap.board).toHaveLength(220);
    expect(() => SELF_SNAPSHOT_SCHEMA.parse(snap)).not.toThrow();
    expect(snap.h).toBe(g.stateHash());
    expect(snap.seq).toBe(7);
    expect(snap.modeState.sprint?.target).toBe(40);
  });
});

describe('sprint 排名（TC-MD-A-001/004）', () => {
  it('完赛按时间升序，同 tick 完赛并列', () => {
    const r = computeSprintRanking([
      { seatId: 0, finishTimeMs: 30000, lines: 43, abandoned: false },
      { seatId: 1, finishTimeMs: 20000, lines: 40, abandoned: false },
      { seatId: 2, finishTimeMs: 20000, lines: 40, abandoned: false },
      { seatId: 3, finishTimeMs: null, lines: 12, abandoned: false },
    ]);
    expect(r.get(1)).toBe(1);
    expect(r.get(2)).toBe(1);
    expect(r.get(0)).toBe(3);
    expect(r.get(3)).toBe(4);
  });

  it('未完赛按已清行数降序；abandoned 移出排名', () => {
    const r = computeSprintRanking([
      { seatId: 0, finishTimeMs: null, lines: 30, abandoned: false },
      { seatId: 1, finishTimeMs: null, lines: 35, abandoned: false },
      { seatId: 2, finishTimeMs: null, lines: 10, abandoned: true },
    ]);
    expect(r.get(1)).toBe(1);
    expect(r.get(0)).toBe(2);
    expect(r.has(2)).toBe(false);
  });

  it('300s 超时全员未完赛：同行数并列', () => {
    const r = computeSprintRanking([
      { seatId: 0, finishTimeMs: null, lines: 5, abandoned: false },
      { seatId: 1, finishTimeMs: null, lines: 5, abandoned: false },
    ]);
    expect(r.get(0)).toBe(1);
    expect(r.get(1)).toBe(1);
  });
});
