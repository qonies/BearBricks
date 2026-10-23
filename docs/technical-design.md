# BearBricks 技术设计文档（技术路线）

| 项 | 内容 |
|---|---|
| 版本 | v1.1 |
| 日期 | 2026-10-22 |
| 关联 | `requirements.md`、`protocol.md`、`test-plan.md`、`adr/0001~0005` |
| v1.1 变更 | M4/M4.5 同步：`modes/` 补 `timed.ts`；协议升至 v1.5（self 快照 `status`、timed `pendingGarbage`）；§2.1 目录为 M4 实际状态；§5.2 快照/store 字段更新 |

## 1. 架构总览

Monorepo（npm workspaces）+ 服务端权威 + 客户端乐观渲染：

```
┌────────────────────────── 浏览器 ──────────────────────────┐
│ client (React 19 + Vite + TS + Tailwind v4)                │
│  ├─ GameCanvas（Canvas 2D，60FPS rAF 渲染循环）             │
│  ├─ stores：useGameStore / useRoomStore / useUiStore       │
│  ├─ NetClient（ws 封装：心跳/重连/seq/快照校正/Codec）      │
│  └─ InputSystem（键盘 + DAS/ARR，本地乐观应用）             │
└──────────△──────────────────────────────────△───────────────┘
     输入(seq) / 心跳 / 聊天        己方快照20Hz │ 对手板10Hz
┌──────────▽──────────────────────────────────▽───────────────┐
│ server (Node 22 + Fastify + ws)                             │
│  ├─ RoomManager：Map<roomCode, Room>；快速匹配索引          │
│  ├─ Room：连接状态机 + 房间状态机（见 §3.2）                │
│  ├─ GameLoop：60Hz 固定步长（tick 权威）                     │
│  ├─ BotController：AI 策略，走同一 shared 引擎              │
│  └─ ChatHub：限流/清洗/系统消息                              │
└──────────△───────────────────────────────────────────────────┘
           │ import（唯一规则来源）
┌──────────▽───────────────────────────────────────────────────┐
│ shared（纯 TS，零 DOM / 零 Node 依赖，双端复用）             │
│  ├─ engine/：SRS 表、7-bag(xorshift128+seed)、碰撞/锁定/     │
│  │            消行/计分/垃圾行插入                            │
│  ├─ modes/：GameModeStrategy —— sprint / survival / timed    │
│  ├─ rules/：攻击表、重力表、常量（DAS/ARR/锁定延迟默认值）   │
│  └─ protocol/：Zod schema + 消息类型 + 快照编解码            │
└───────────────────────────────────────────────────────────────┘
```

## 2. 包结构与技术选型

### 2.1 目录结构（M4 实际状态）
```
packages/
  shared/src/
    engine/{board.ts, srs.ts, bag.ts, rng.ts, score.ts, garbage.ts, game.ts}
    modes/{strategy.ts, sprint.ts, survival.ts, timed.ts}
                                     策略抽象（ADR-0005 落地）+ 各模式排名
    rules/{constants.ts, attackTable.ts}
    protocol/{messages.ts, snapshot.ts}   Zod schema + 快照编解码（v1.5 全量）
  server/src/
    {index.ts, app.ts, config.ts}  Fastify + 静态托管 + /healthz + 优雅停机
    net/{wsHub.ts, session.ts}     升级握手/Origin/IP 限流；会话心跳/校验/入站限流
    room/{roomManager.ts, room.ts} 房间码/大厅/限流/回收；状态机+GameLoop+快照+策略接入
  client/src/
    net/{netClient.ts, identity.ts}   ws 封装（重连/握手/分发）+ 访客身份
    game/{engineRunner.ts, netGame.ts, autoshift.ts, render.ts}
    store/{settings.ts, room.ts}      room store 含聊天记录（chatLog）
    components/{Lobby.tsx, RoomView.tsx, GameView.tsx, GameViewMP.tsx, ChatPanel.tsx}
    i18n.ts / App.tsx / main.tsx / theme.ts / index.css
```

### 2.2 选型与权衡（详见 ADR-0001 / 0003）
| 决策点 | 采用 | 主要备选 | 不选理由 |
|---|---|---|---|
| 传输 | 原生 `ws` + JSON | Socket.IO / uWS / Colyseus | 黑盒语义重、体积大；容量目标（800 连接）远未触及 ws 瓶颈；Codec 抽象保留后路 |
| 渲染 | Canvas 2D | DOM Grid / PixiJS | DOM 60FPS 有风险；WebGL 过度设计 |
| 前端状态 | Zustand | Redux Toolkit / Jotai | 高频更新下样板最少 |
| 样式 | Tailwind CSS v4（Vite 插件） | CSS Modules | 统一设计 token、速度快 |
| 校验 | Zod | class-validator | 同一 schema 双端复用类型 + 运行时校验 |
| 服务端框架 | Fastify | Express / Hono | 内置 schema 校验与日志，性能好，生态成熟 |
| 存储 | 内存 Map | Redis / SQLite | 无持久化需求（需求 §7）；`RoomStore` 接口预留 |
| 游戏 UI 框架 | 不用 Phaser | — | 引擎自研于 shared，渲染层很薄 |

### 2.3 核心抽象（ADR-0005：模式策略，M3 落地后实际接口）
```ts
interface GameModeStrategy {
  readonly id: 'sprint' | 'survival' | 'timed';
  /** 消行 → 攻击计划（含 B2B/Combo/PC 加成）；攻击关闭（sprint）返回 null */
  onLinesCleared(clear: AttackInput): AttackPlan | null;
  /** 顶出处置动作 */
  onTopOut(): TopOutAction; // 'ELIMINATE' | 'RESPAWN' | 'RESET_BOARD'
  /** TetrisGame 引擎模式：sprint（引擎内 300s 超时 + 顶出清盘）| marathon（顶出即终局，Room 层处置） */
  engineMode(): GameMode;
}
```
- 与初稿的差异（M3 落地时简化）：`createInitialState/onTick/isFinished/computeRanking/hudDescriptor` 未进入接口——排名由各模式模块提供（`modes/sprint.ts`、`modes/survival.ts` 的 `compute*Ranking`），ModeState 由 Room 层 `selfModeState()` 组装，HUD 由客户端按 `mode` 切换；timed（M4）复用本接口，复活逻辑经 `onTopOut → RESPAWN` 扩展
- `AttackPlan = { lines }`（抵消 offset 与目标转发在 Room 层完成，策略只拿净攻击值）
- Room 生命周期（等待/开局/结算）不属于策略职责，策略只管"游戏中"的规则差异

## 3. 服务端设计

### 3.1 模块职责
- **wsHub**：连接生命周期（upgrade → session），Origin 校验，每 IP 连接数限制（≤5），消息分发到 Room
- **session**：`playerId + resumeToken` 绑定；心跳 ping/pong 15s，2 次未响应判定断线
- **roomManager**：创建/加入/快速匹配/房间码生成（6 位，去除 0/O/1/I 易混字符，冲突重试）；房间空闲 10 分钟自动回收
- **room**：座位管理（4 席，含 AI）、房主权限校验、准备状态、模式与参数（Zod 校验）、聊天限流
- **gameLoop**：每房间独立 60Hz 定时器（`setInterval` + 执行时间累加补偿，漂移自校正）；PLAYING 时驱动引擎 step 与策略钩子；FINISHED 后停止
- **snapshotter**：快照生成与节流（己方 20Hz / 对手 10Hz，仅变化发送）；棋盘行编码（protocol.md §5）
- **botController**：见 §6

### 3.2 状态机
```
房间：WAITING → COUNTDOWN(3s) → PLAYING → FINISHED → (再来一局) WAITING
连接：CONNECTING → HELLO(身份) → IN_ROOM ↔ PLAYING → (断线) DISCONNECTED
                                                     └─(30s 宽限内 resume)→ 原状态
连接断线超时 / 主动离开 → 座位释放（PLAYING 中触发对应模式的 onTopOut/移除逻辑）
```
非法状态下的消息一律拒绝并回错误码（protocol.md §8）。

### 3.3 公平与确定性
- 方块序列：服务器开局生成 `seed`，7-bag 从 seed 派生；所有真人/AI 棋盘各自独立序列（互不共享 bag）
- 所有规则计算只在服务器 `shared/engine` 中发生；客户端引擎仅用于本地乐观预演
- AI 输入与真人输入同一条路径进入 GameLoop，不做特权调用

## 4. 网络模型（ADR-0002）

### 4.1 上行（客户端 → 服务器）
| 消息 | 频率 | 说明 |
|---|---|---|
| `game.input` | 事件驱动 | `{ seq, action }`，action ∈ move/rotate/soft/hard/hold；服务器按 seq 序应用 |
| `game.inputBatch` | 网络合并时 | 多个 action 合包（可选优化） |
| `chat.send` | 限流 1/s & 10/10s | 纯文本 ≤200 字符 |
| `room.*` / `game.ready` 等 | 低频 | 见 protocol.md |

输入速率上限：单座位 ≤ 60 action/s，超出丢弃并告警（防脚本刷包）。

### 4.2 下行（服务器 → 客户端）
| 消息 | 频率 | 内容 |
|---|---|---|
| `game.snapshot.self` | 20Hz 或输入回执即时 | 自己棋盘权威态（tick、board、piece、queue、score、pendingGarbage） |
| `game.snapshot.others` | 10Hz，变化才发 | 各对手压缩棋盘 + 分数/行数/状态 |
| `game.attack` | 事件 | 攻击来源/目标/行数（驱动预警条动画） |
| `game.result` | 事件一次 | 排名表 + 各模式统计 |
| `chat.message` / `system` | 事件 | 聊天与系统消息 |
| `ping`/`pong` | 15s | 心跳 + RTT 统计 |

### 4.3 校正策略
- 客户端维护本地预测棋盘；收到权威快照后比较 `stateHash` 指纹：
  - 一致 → 仅确认 `seq`（快照携带服务器已应用的最大输入 seq）
  - 不一致 → `applySnapshotState` 直接覆盖为权威态，**保留未确认输入并按 seq 升序重放**（俄罗斯方块动作可重放，代价低）
- 快照携带 `seed`（开局 `game.start` 下发 / 重连 `game.state.full` 再次确认），保证客户端预测引擎与服务端同一方块序列
- 快照携带座位 `status`（v1.5）：权威 `playing` 映射回引擎 `running`（本地预测顶出但权威仍在打的场景必须解除 finished，否则客户端永久卡死）；`eliminated/abandoned/finished` → 引擎 `finished`（观战/终局）
- 重连恢复：服务器发送 `game.state.full`（全量快照 + modeState + 房间态），客户端重建场景；FINISHED 阶段重连会补发缓存的 `game.result`

### 4.4 性能预算
- 单客户端下行预算 < 10KB/s（4 人房间，**按"变化才发"优化后**；未压缩理论上界 ≈ 20Hz×~400B + 3×10Hz×~300B ≈ 17KB/s，依赖快照指纹去重与对手板变化率收敛；M6 压测 TC-PERF-001 实测修正）；快照用行编码（22 行 × 10 格 → 220 字符，无分隔符）
- 目标：同区域 RTT≤50ms 时输入端到端 p95 < 100ms（乐观渲染使本地感知延迟 ≈ 0，该项为权威校正收敛时间）

## 5. 客户端设计

### 5.1 渲染
- **GameCanvas**：单个 `<canvas>`，rAF 循环；己方板 + 对手小板统一在一个 canvas 上绘制（避免多 canvas 合成开销）；绘制单元：格子 → 行 → 板 → HUD 元素
- 块配色集中在 `theme.ts`（含色盲方案），未来可换 sprite
- 帧循环只读 store 状态渲染，不做逻辑（逻辑在引擎 step，由 tick 驱动）

### 5.2 状态（Zustand）
| store | 内容 |
|---|---|
| `useRoomStore` | RoomState、selfSeatId、对手板视图（opponents，来自 `game.snapshot.others`）、mpStart（seed/快照基线）、countdown、result、toast、chatLog |
| `useSettings` | DAS/ARR/Ghost 等本地设置（localStorage 持久化） |
| 已落地（M3/M4） | pendingGarbage（survival/timed 预警条）、攻击预警、淘汰观战状态、timed 计时/复活/免伤 HUD |

### 5.3 输入系统
- keydown/keyup 监听 → 按键映射（可改键）→ DAS/ARR 调度器（时间戳驱动）→ 动作队列
- 动作同时做两件事：① 本地 `engineProxy.apply`（乐观渲染）② `netClient.input(seq, action)` 上行
- `seq` 单调递增、**重连后不重置**；权威快照携带服务器已应用的最大 `seq` 作为确认位；收到权威快照不一致 → 覆盖 + 从快照 `seq` 重放未确认动作（俄罗斯方块动作可重放，代价低）

### 5.4 网络层 NetClient
- 状态机：`idle → connecting → hello → ready`；断线自动重连（指数退避 1s/2s/4s…上限 10s），携带 resumeToken
- 心跳应答服务器 ping；RTT 平滑统计用于 UI 显示
- 所有入站消息经 `protocol/snapshot.ts` 解码后分发到 store

### 5.5 单人模式执行模型（Marathon / Sprint 40）
- **纯本地权威**：单人模式不依赖服务器权威，客户端直接实例化 `shared/engine`，以 rAF 固定步长（60Hz）本地驱动——与服务端权威共用同一引擎代码，保证手感一致
- 大厅层在应用启动时即建立 WebSocket（联机房间/聊天需要）；单人模式下该连接仅维持心跳，不参与对局
- 暂停（Esc）即冻结本地步长循环（重力与锁定延迟同时冻结，FR-3.3）
- Sprint 40 完赛 / Marathon 顶出结束由客户端结算，最佳成绩写入 localStorage（`bearbricks.best.*`）
- 不涉及 protocol.md 游戏内消息；进入多人房间后才启用输入上行/快照校正

## 6. AI 设计（BotController）
- 位置：服务端；每 tick 为 bot 生成输入事件，走与真人相同的 `game.input` 路径
- 评估：枚举当前块（含 Hold 权衡）的所有旋转 × 落点，模拟硬降后评估：
  `score = w1·聚合高度 + w2·空洞数 + w3·凹凸度 + w4·消行数 + w5·井深`
  （权重经 TC-BOT-001 批量对局回归调优）
- 难度参数：
| 难度 | 思考延迟 | 误操作率 | 说明 |
|---|---|---|---|
| EASY | 300ms | 15% | 随机选次优、随机多余移动 |
| NORMAL | 150ms | 5% | 最优解但偶发失误 |
| HARD | 60ms | 0% | 最优解 + 考虑攻击时机（保留 Tetris） |
- survival 模式 HARD 追加「压制策略」：高度低于均值时优先攻击
- **M5 实现注记**（`packages/shared/src/ai/bot.ts`，纯 TS 零依赖）：
  - 评估权重：`cost = 0.510066·聚合高度 + 0.35663·空洞 + 0.184483·凹凸度 + 0.1·累计井深 − 0.760666·消行`（经典调优组合，TC-BOT-001 批量对局回归验证：固定 12 seed × 4000 tick 下 HARD 平均 149 行 / NORMAL 94 / EASY 27，EASY 顶出率 8/12、HARD 0）
  - 攻击模式（survival/timed）：4 消（Tetris）额外减 `0.8` 代价，替代「高度低于均值时优先攻击」的复杂判定
  - 执行模型：每权威 tick `decide()` 产出 ≤1 个动作（思考延迟 → 旋转 → 平移 → 硬降），由 Room 走与真人相同的 `game.applyInput`；踢墙/垃圾行堵路卡住 3 tick 兜底硬降，保证永不挂死
  - 确定性：误操作 RNG 以 `${seed}:bot` 派生（独立于方块 bag 与垃圾行洞列 RNG）

## 7. 安全设计
- 输入即权限：未知消息类型或绕过 `game.input` 的伪造状态类消息一律回 E4031 并计数，累计 10 次断开（与 protocol §8、TC-SEC-001 一致）
- 限流（protocol §9）+ Zod 校验 + 4KB 上限
- 聊天：服务端清洗 + React 文本渲染
- 无 PII：playerId 为随机 UUID，不收集 IP 存储（仅限流内存窗口）
- Origin 校验 + 生产强制 WSS

## 8. 性能与容量估算
- 单房间每 tick（4 座位引擎 step + 策略钩子）预计 < 50µs CPU（shared 纯计算）；60Hz 下单房间 ≈ 3ms CPU/秒，200 房间 ≈ 600ms/秒 ≈ 单核 60%，可承载
- 快照带宽：己方 20Hz×~250B + 对手 10Hz×3×~180B ≈ 10KB/s/客户端（变化才发可降 50%+），在目标内
- GC 压力：复用缓冲对象（快照行编码复用数组），避免每 tick 分配

## 9. 部署
仓库根目录已提供 `Dockerfile`（多阶段构建）与 `.dockerignore`：
```dockerfile
# build 阶段：npm ci → npm run build（client vite + server esbuild）→ npm prune --omit=dev
# 运行阶段：node:22-alpine，仅拷贝 node_modules（fastify/ws/zod 为 external）、
#           packages/server/dist、packages/client/dist（放到 /app/client-dist）
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 CLIENT_DIST=/app/client-dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/server/dist ./dist
COPY --from=build /app/packages/client/dist ./client-dist
EXPOSE 3000
CMD ["node", "dist/index.mjs"]
```
- server bundle 中 shared 源码已打进 `dist/index.mjs`（esbuild --bundle），运行时只需 fastify/ws/zod
- 静态目录定位：`app.ts` 默认按 `../../../packages/client/dist` 向上三级定位（兼容 tsx 源码运行），
  **容器/自定义布局用 `CLIENT_DIST` 环境变量覆盖**
- 环境变量：`PORT`、`ORIGIN`、`NODE_ENV`、`TRUST_PROXY`（可信反代后取真实 IP 做限流）、`ROOM_CREATE_LIMIT`、`LOG_LEVEL`
- 反代（Caddy 示例，注意 Caddyfile 不使用分号分隔）：
  ```caddyfile
  bearbricks.example.com {
    reverse_proxy /ws localhost:3000
    reverse_proxy localhost:3000
  }
  ```
  调大读超时（心跳 15s → 反代空闲超时 ≥ 60s）；并在服务端设 `TRUST_PROXY=1`
- 健康检查 `/healthz`；优雅停机：SIGTERM → 广播 E4999（200ms flush）→ 5s 内关闭

## 10. 测试与质量工具链
- Vitest：shared 单测 + server 集成（真实 ws 端口，随机高位端口，afterAll 关闭）
- Playwright：多 browser context 模拟 4 玩家（见 test-plan.md）
- 压测：`scripts/bench-ws.mjs`（自研，模拟 N 客户端对局）
- ESLint flat config + Prettier + tsc --noEmit；GitHub Actions：lint → typecheck → test → e2e

## 11. 风险与缓解（技术侧）
| 风险 | 缓解 |
|---|---|
| setInterval 漂移 | 累加器补偿：每次回调按真实时间补 tick |
| JSON 快照体积增长 | 行编码 + 变化才发 + MessagePack 后备（Codec） |
| TCP 队头阻塞造成对手板延迟 | 对手板 10Hz 且仅变化发送，可容忍；不为此引入 UDP |
| AI 体验突兀（瞬移决策） | 思考延迟 + 移动动作拆分为逐格 move 上行 |
| 浏览器标签页后台 rAF 暂停 | 权威在服务器；回前台用全量快照重建 |

