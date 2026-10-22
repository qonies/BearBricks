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
});
