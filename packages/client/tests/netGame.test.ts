// NetGameRunner：确定性镜像 + 快照校正（重放未确认输入）

import { describe, expect, it } from 'vitest';
import { TetrisGame, buildSelfSnapshot } from '@bearbricks/shared';
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
});
