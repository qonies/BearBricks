// NetGameRunner：确定性镜像 + 快照校正（重放未确认输入）

import { describe, expect, it } from 'vitest';
import { TetrisGame, buildSelfSnapshot, type GameAction } from '@bearbricks/shared';
import { NetGameRunner } from '../src/game/netGame';

describe('NetGameRunner.resync', () => {
  it('同 seed 同输入序列：状态一致，resync 仅确认', () => {
    const seed = 'resync-ok';
    const client = new NetGameRunner(seed, 'sprint', 40);
    client.apply('moveR');
    client.apply('hard');
    const server = new TetrisGame({ mode: 'sprint', targetLines: 40, seed });
    server.applyInput('moveR');
    server.applyInput('hard');
    const snap = buildSelfSnapshot(server, 10, 2, { sprint: { target: 40 } });
    expect(client.resync(snap)).toBe(false);
    expect(client.game.stateHash()).toBe(server.stateHash());
  });

  it('不一致 → 重建 + 重放未确认输入后收敛', () => {
    const seed = 'resync-fix';
    const client = new NetGameRunner(seed, 'sprint', 40);
    client.apply('moveR');
    client.apply('hard');
    const server = new TetrisGame({ mode: 'sprint', targetLines: 40, seed });
    server.applyInput('moveR');
    server.applyInput('hard');
    // 服务器多应用了一个客户端尚未发送的输入（模拟时序差）
    server.applyInput('rotCW');
    const diverged = buildSelfSnapshot(server, 12, 3, { sprint: { target: 40 } });
    expect(client.resync(diverged)).toBe(true);
    expect(client.game.stateHash()).toBe(server.stateHash());
  });

  it('未确认输入（seq > 快照 seq）在重建后重放', () => {
    const seed = 'replay';
    const client = new NetGameRunner(seed, 'sprint', 40);
    client.apply('moveR');
    client.apply('hard');
    client.apply('moveR'); // seq=3，尚未被服务器确认
    const server = new TetrisGame({ mode: 'sprint', targetLines: 40, seed });
    server.applyInput('moveR');
    server.applyInput('hard'); // seq=2 已确认
    const snap = buildSelfSnapshot(server, 14, 2, { sprint: { target: 40 } });
    expect(client.resync(snap)).toBe(true); // 本地 seq=3 已应用 → hash 不同
    // 重放 seq=3 后与「服务器 + 该输入」一致
    server.applyInput('moveR');
    expect(client.game.stateHash()).toBe(server.stateHash());
  });

  it('survival 模式：引擎用 marathon 语义（顶出即终局，无引擎内超时）', () => {
    const client = new NetGameRunner('survival-mode', 'survival', 0);
    expect(client.game.mode).toBe('marathon');
    const sprint = new NetGameRunner('sprint-mode', 'sprint', 40);
    expect(sprint.game.mode).toBe('sprint');
  });

  it('本地预测顶出卡死：权威快照 status=playing → resync 恢复 running 并可继续输入', () => {
    const seed = 'resync-status';
    const client = new NetGameRunner(seed, 'survival', 0);
    // 本地预测：连续硬降顶出（乐观渲染的悲观分支）
    for (let i = 0; i < 40 && client.game.status === 'running'; i++) client.apply('hard');
    expect(client.game.status).toBe('finished');
    // 权威：该座位仍在进行（服务端输入次序略有差异，未顶出）
    const server = new TetrisGame({ mode: 'marathon', seed });
    server.applyInput('moveR');
    const snap = buildSelfSnapshot(server, 10, 1, { survival: { aliveCount: 2, pendingGarbage: 0 } }, 'playing');
    expect(client.resync(snap)).toBe(true);
    expect(client.game.status).toBe('running');
    expect(client.apply('hard')).toBe(true); // 输入通道恢复
  });

  it('权威淘汰（status=eliminated）→ 本地停引擎停输入（观战）', () => {
    const client = new NetGameRunner('resync-elim', 'survival', 0);
    const server = new TetrisGame({ mode: 'marathon', seed: 'resync-elim' });
    const snap = buildSelfSnapshot(server, 5, 0, { survival: { aliveCount: 1, pendingGarbage: 0 } }, 'eliminated');
    client.resync(snap);
    expect(client.game.status).toBe('finished');
    expect(client.apply('hard')).toBe(false);
  });

  it('hash 一致但座位状态变化（如顶出复活后仍在打）也会同步 status', () => {
    const client = new NetGameRunner('resync-same-hash', 'survival', 0);
    for (let i = 0; i < 40 && client.game.status === 'running'; i++) client.apply('hard');
    expect(client.game.status).toBe('finished');
    // 构造与本地一致的状态（hash 相同）：直接取本地快照字段，但 status=playing
    const snap = buildSelfSnapshot(
      client.game,
      10,
      0,
      { survival: { aliveCount: 2, pendingGarbage: 0 } },
      'playing',
    );
    expect(client.resync(snap)).toBe(false); // hash 一致，仅确认
    expect(client.game.status).toBe('running'); // status 仍被同步恢复
  });

  it('本地失败的动作不产生 seq、不上行（P1-1 回归）', () => {
    const client = new NetGameRunner('no-send', 'sprint', 40);
    const sent: { seq: number; action: GameAction }[] = [];
    client.onInput = (seq, action) => sent.push({ seq, action });
    expect(client.apply('hold')).toBe(true);
    expect(client.apply('hold')).toBe(false); // canHold=false → 本地失败
    expect(sent).toHaveLength(1);
    expect(client.apply('hard')).toBe(true);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.seq).toBe(2); // seq 连续无空洞
  });

  it('timed 复活：先 syncTimed 再 resync，active/queue 与服务器一致（P1-2 回归）', () => {
    const server = new TetrisGame({ mode: 'marathon', seed: 'respawn-sync' });
    server.respawn(); // 模拟服务端顶出后已复活的权威状态
    const at = Date.now() + 3000;
    const snap = buildSelfSnapshot(server, 3, 0, {
      timed: { endsAt: at + 100_000, respawnAt: at },
    });
    const client = new NetGameRunner('respawn-sync', 'timed', 0);
    client.syncTimed({ respawnAt: at });
    client.resync(snap);
    expect(client.game.active).toEqual(server.active);
    expect(client.game.queue).toEqual(server.queue);
    expect(client.game.stateHash()).toBe(server.stateHash());
  });

  it('重连恢复：spawnCount 对齐 7-bag，连续 9 块后 queue 与服务端一致', () => {
    const seed = 'bag-align';
    const server = new TetrisGame({ mode: 'marathon', seed });
    for (let i = 0; i < 5; i++) server.applyInput('hard');
    const snap = buildSelfSnapshot(server, 100, 0, { sprint: { target: 40 } });
    const client = new NetGameRunner(seed, 'survival', 0);
    expect(client.resync(snap)).toBe(true);
    expect(client.game.stateHash()).toBe(server.stateHash());
    for (let i = 0; i < 9; i++) {
      server.applyInput('hard');
      client.apply('hard');
    }
    expect(client.game.queue).toEqual(server.queue);
    expect(client.game.active?.type).toBe(server.active?.type);
  });
});
