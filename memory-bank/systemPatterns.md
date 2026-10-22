# 系统模式（System Patterns）

## 架构总览
Monorepo（npm workspaces）+ 三包结构 + 服务端权威：

```
┌────────────────────────── 浏览器 ──────────────────────────┐
│ client (React 19 + Vite + TS)                              │
│  ├─ GameCanvas (Canvas 2D)      ← 60FPS 渲染               │
│  ├─ Zustand stores (ui/net/game)                           │
│  ├─ NetClient (ws, 心跳, 重连, 快照校正)                    │
│  └─ InputSystem ← 本地乐观渲染（零延迟手感）               │
└───────────────△────────────────────────────△───────────────┘
        输入 seq / 心跳      己方快照 20Hz │ 对手板 10Hz
┌───────────────▽────────────────────────────▽───────────────┐
│ server (Node 22 + Fastify + ws)                            │
│  ├─ RoomManager（内存 Map<roomCode, Room>）                │
│  ├─ Room 状态机: WAITING→COUNTDOWN→PLAYING→FINISHED        │
│  ├─ GameLoop 60Hz 固定步长（权威 tick）                     │
│  ├─ BotController（AI 走同一引擎）                          │
│  └─ ChatHub（限流/纯文本）                                  │
└───────────────△────────────────────────────────────────────┘
                │ import
┌───────────────▽────────────────────────────────────────────┐
│ shared (纯 TS，零 DOM/Node 依赖)                            │
│  ├─ engine/（碰撞、SRS、7-bag、锁定、消行、计分）           │
│  ├─ modes/（GameModeStrategy: sprint/survival/timed）       │
│  ├─ rules/（攻击表、重力表、常量）                          │
│  └─ protocol/（Zod schema + 消息类型）                      │
└─────────────────────────────────────────────────────────────┘
```

## 关键模式与决策
0. **单人模式纯本地权威**（技术设计 §5.5，M1 已实现）：客户端以 rAF 固定 60Hz 步长直接驱动 `shared/engine` 的 `TetrisGame`（与服务端权威同一引擎，手感一致）；Esc 暂停冻结步长循环；完赛成绩写 localStorage `bearbricks.best.*`。应用启动即建 WS（大厅需要），单人模式不参与对局。
1. **服务端权威 + 客户端乐观渲染**（ADR-0002，M2 已实现）：客户端输入立即本地应用并渲染，带 `seq` 上行；服务器 60Hz tick（漂移补偿）按 seq 序应用输入；快照（含 `stateHash` 指纹 + 已应用 `seq`）下行，不一致 → `applySnapshotState` 重建 + 重放未确认输入。seed 经 `game.start` 下发保证序列一致。**seq 重连后不重置**，以 `game.state.full.seq` 为基线。
2. **模式策略抽象**（ADR-0005）：三模式实现同一 `GameModeStrategy` 接口（M2 先落了 sprint 排名 `modes/sprint.ts`，M3/M4 补全策略类）。
3. **单一游戏引擎，双端复用**：`shared/engine` 同时驱动客户端本地预演、服务器权威模拟与服务端 AI。确定性：RNG 用带 seed 的 7-bag，`game.start` 下发 per-seat seed。
4. **传输层可替换**（ADR-0003）：原生 ws + JSON（Zod schema 双端复用 `shared/protocol`）；Codec 后备留待需要时引入。
5. **纯内存存储**：房间/会话全内存；WAITING **空房**（有人的等待房不回收）与 FINISHED 房 10 分钟 TTL 回收（解散时向在线成员发 E4090）；`RoomStore` 接口预留。
6. **状态机驱动**：Room（WAITING→COUNTDOWN→PLAYING→FINISHED）与连接（hello→in-room→offline 宽限 30s→resume 轮换 token）显式状态机，非法消息按状态拒绝（E4030/E4031）。**resume 优先于顶号**（旧连接在线也强制接管）；abandoned 座位不可再 resume；**resume 复位 softDrop/pendingInputs**（持续态不跨断线）。**survival 存活两口径**：结束判定/HUD 用 `survivalAliveSeats`（含宽限内离线者，FR-10.3 判淘汰前不算死），攻击目标用 `aliveSeats`（再排除离线，FR-10.2 不收发攻击）；游戏内输入仅 PLAYING 阶段接收。
7. **安全基线**：Zod 全量校验（自有属性查表防原型键；未知类型 E4031）、信封必须是普通对象 + handleRaw try/catch（单条消息不可致进程退出）、4KB（应用层 + ws maxPayload 双层）、**每连接入站消息 ≤120 条/s（超限断开，v1.3）**、输入 ≤60/s、聊天 1/s & 10/10s、建房 `ROOM_CREATE_LIMIT`（默认 3/10min/IP）、加入失败 10/10min/IP、Origin 校验（dev 放行私有网段）、**playerId 不广播（selfSeatId 定位）**、X-Forwarded-For 仅 `TRUST_PROXY=1` 信任、限流 Map 窗口清理、优雅停机广播 E4999、异常退出非零码。

## 关键实现路径
- 一帧的生命周期：`InputMsg(seq) → Room.applyInput → shared/engine.step(tick) → GameModeStrategy 钩子 → 快照 diff → ws.broadcast`
- 一次攻击：`engine.onLinesCleared → attackTable.calc → Room 抵消 pendingGarbage → 广播 attack`
- 一次重连：`resumeToken → RoomManager.findSeat → 30s 宽限窗口内恢复座位与棋局状态`

## 决策记录索引（docs/adr/）
- ADR-0001 技术栈（React19/Vite/Canvas2D/Zustand/Tailwind + Node22/Fastify/ws）
- ADR-0002 服务端权威与乐观渲染
- ADR-0003 传输层选型（原生 ws 自研协议）
- ADR-0004 三种对战模式规则
- ADR-0005 模式策略抽象
