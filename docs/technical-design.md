# BearBricks 技术设计文档（技术路线）

| 项 | 内容 |
|---|---|
| 版本 | v1.2 |
| 日期 | 2026-10-25 |
| 关联 | `requirements.md`、`protocol.md`、`test-plan.md`、`adr/0001~0005` |
| v1.1 变更 | M4/M4.5 同步：`modes/` 补 `timed.ts`；协议升至 v1.5（self 快照 `status`、timed `pendingGarbage`）；§2.1 目录为 M4 实际状态；§5.2 快照/store 字段更新 |
| v1.2 变更 | M6 同步：协议 v1.7（`spawnCount` 7-bag 对齐、E4031/E4010 口径、PLAYING 广播 room.state、survival `rankBottom`）；AI 难度下调 + 半程逐格软降硬降门槛；iPad 320px 触控自适应；设置弹层单人自动暂停；安全头/压缩/Docker 非 root + HEALTHCHECK/PWA 图标 |

## 1. 架构总览

Monorepo（npm workspaces）+ 服务端权威 + 客户端乐观渲染：

```
┌────────────────────────── 浏览器 ──────────────────────────┐
│ client (React 19 + Vite + TS + Tailwind v4)                │
│  ├─ GameCanvas（Canvas 2D，60FPS rAF 渲染循环）             │
│  ├─ stores：useRoomStore / useSettings（Zustand）          │
│  ├─ NetClient（ws 封装：心跳/重连/seq/快照校正/看门狗）     │
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

### 2.1 目录结构（M6 实际状态）
```
packages/
  shared/src/
    engine/{board.ts, srs.ts, bag.ts, rng.ts, score.ts, garbage.ts, game.ts}
    modes/{strategy.ts, sprint.ts, survival.ts, timed.ts}
                                     策略抽象（ADR-0005 落地）+ 各模式排名
    rules/{constants.ts, attackTable.ts}
    ai/bot.ts                             BotController（M5：落点评估 AI，服务端驱动）
    protocol/{messages.ts, snapshot.ts}   Zod schema + 快照编解码（v1.7 全量）
  server/src/
    {index.ts, app.ts, config.ts, log.ts}  Fastify + 静态托管 + /healthz + 优雅停机；环境变量集中配置；结构化日志接口
    net/{wsHub.ts, session.ts}     升级握手/Origin/每 IP·全服并发限流；会话心跳/校验/入站限流/背压/错误限速
    room/{roomManager.ts, room.ts} 房间码/大厅/限流/回收；状态机+GameLoop+快照+策略接入
  client/src/
    net/{netClient.ts, identity.ts}   ws 封装（重连/握手/分发/服务器时钟校正/回前台立即重连）+ 访客身份
    input/{commands.ts, router.ts, gestures.ts, keymap.ts, useGameInput.ts, touchLayout.ts}
                                     三源输入（键盘/触屏/手势）→ GameCommands；键位映射与改键；手势识别
    game/{engineRunner.ts, netGame.ts, autoshift.ts, render.ts, clearFx.ts, fitCell.ts, viewport.ts}
                                     单人/联机执行器（乐观渲染+校正）、DAS/ARR、绘制、消行三闪、
                                     视口自适应（格子尺寸/粗指针检测）
    store/{settings.ts, room.ts}      room store 含聊天记录（chatLog）；settings 含键位/触控/音量
    components/{Lobby.tsx, RoomView.tsx, GameView.tsx, GameViewMP.tsx, ChatPanel.tsx,
                SettingsPanel.tsx, TouchControls.tsx}
    i18n.ts / App.tsx / main.tsx / theme.ts / index.css
    public/{manifest.webmanifest, icon-192.png, icon-512.png, apple-touch-icon.png}
                                     添加到主屏幕（standalone；不注册 SW）
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
- **wsHub**：连接生命周期（upgrade → session），Origin 校验（归一化比较），每 IP 并发限制（`MAX_CONN_PER_IP`，默认 20）与全服并发上限（`MAX_CONNECTIONS`，默认 512），超限回 429/503（`socket.end` 保证状态行 flush）后断开；拒绝事件写结构化日志
- **session**：`playerId + resumeToken` 绑定；心跳 ping/pong（`HEARTBEAT_MS`，默认 15s），2 次未响应判定断线；下行背压保护（`bufferedAmount > MAX_SOCKET_BUFFER_BYTES` 断开慢客户端）；错误回包限速（`MAX_ERRORS_PER_SEC`）；顶号错误先 flush 再断开（`closeAfterFlush`）；未 hello 的消息回 E4031（v1.7）
- **roomManager**：创建/加入/快速匹配/房间码生成（6 位，去除 0/O/1/I 易混字符，冲突重试）；WAITING 空房 / FINISHED 房 `ROOM_TTL_MS`（默认 10 分钟）自动回收（有人的等待房保留）
- **room**：座位管理（4 席，含 AI）、房主权限校验、准备状态、模式与参数（Zod 校验）、聊天限流
- **gameLoop**：每房间独立 60Hz 定时器（`setInterval` + 执行时间累加补偿，漂移自校正）；PLAYING 时驱动引擎 step 与策略钩子；FINISHED 后停止
- **snapshotter**：快照生成与节流（己方 20Hz / 对手 10Hz，仅变化发送）；棋盘行编码（protocol.md §5）
- **botController**：见 §6

### 3.2 状态机
```
房间：WAITING → COUNTDOWN(3s) → PLAYING → FINISHED → (再来一局) WAITING
连接：CONNECTING → HELLO(身份) → IN_ROOM ↔ PLAYING → (断线) DISCONNECTED
                                                     └─(30s 宽限内 resume)→ 原状态
断线超时 → 按模式处置（FR-10.3）：survival 判淘汰（座位保留垫底）/ timed 计一次顶出并继续复活循环 / sprint 移出排名；
主动离开 → survival 判淘汰并标记 `rankBottom` 垫底（与宽限超时同口径；已淘汰观战者离开保留原名次）、sprint/timed 释放座位并移出排名
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

输入速率上限：单座位 ≤ `INPUT_RATE_LIMIT`（默认 60）action/s，超出丢弃并告警（防脚本刷包）；被丢弃的 seq 同样计入已确认（v1.6），避免客户端 inputLog 残留永久未确认输入。

### 4.2 下行（服务器 → 客户端）
| 消息 | 频率 | 内容 |
|---|---|---|
| `game.snapshot.self` | 20Hz（含 `seq` 变化即发，≈50ms 内确认输入） | 自己棋盘权威态（tick、board、piece、queue、score、spawnCount、pendingGarbage） |
| `game.snapshot.others` | 10Hz，变化才发 | 各对手压缩棋盘 + 分数/行数/状态 |
| `game.attack` | 事件 | 攻击来源/目标/行数（驱动预警条动画） |
| `game.result` | 事件一次 | 排名表 + 各模式统计 |
| `chat.message` / `system` | 事件 | 聊天与系统消息 |
| `ping`/`pong` | 15s | 心跳 + RTT 统计 |

### 4.3 校正策略
- 客户端维护本地预测棋盘；收到权威快照后比较 `stateHash` 指纹：
  - 一致 → 仅确认 `seq`（快照携带服务器已应用的最大输入 seq）
  - 不一致 → `applySnapshotState` 直接覆盖为权威态，**保留未确认输入并按 seq 升序重放**（俄罗斯方块动作可重放，代价低）
- **7-bag 对齐（v1.7）**：自快照携带 `spawnCount`（已从队列取块数）；客户端 `applySnapshotState` 用 `seed + spawnCount + queue.length` 重建 `SevenBag` 游标。否则重连/校正后客户端从 bag 起点取块，Next 预览与实际出块会偏离服务器（已用 9 块回归用例覆盖）
- 快照携带 `seed`（开局 `game.start` 按座位单独下发 / 重连 `game.state.full` 再次确认），保证客户端预测引擎与服务端同一方块序列
- **防窥探（v1.6）**：`game.start.seeds` 只含接收者本人座位。seed 决定整局 7-bag 队列，广播全部座位等于公开对手未来方块；对手快照已省略 `queue/hold`，seed 必须同口径收敛
- 快照携带座位 `status`（v1.5）：权威 `playing` 映射回引擎 `running`（本地预测顶出但权威仍在打的场景必须解除 finished，否则客户端永久卡死）；`eliminated/abandoned/finished` → 引擎 `finished`（观战/终局）
- 重连恢复：服务器发送 `game.state.full`（全量快照 + modeState + 房间态），客户端重建场景；FINISHED 阶段重连会补发缓存的 `game.result`

### 4.4 性能预算
- 单客户端下行预算 < 10KB/s（4 人房间，**按"变化才发"优化后**；未压缩理论上界 ≈ 20Hz×~400B + 3×10Hz×~300B ≈ 17KB/s，依赖快照指纹去重与对手板变化率收敛；M6 压测 TC-PERF-001 实测修正）；快照用行编码（22 行 × 10 格 → 220 字符，无分隔符）
- 目标：同区域 RTT≤50ms 时输入端到端 p95 < 100ms（乐观渲染使本地感知延迟 ≈ 0，该项为权威校正收敛时间）

## 5. 客户端设计

### 5.1 渲染
- **渲染组件**：`GameView` / `GameViewMP` 各自持有 rAF 循环；己方板、Hold/Next、每个对手小板为独立 `<canvas>`（对手板侧栏 80×160 / 窄屏条 50×100 小图）；绘制单元：格子 → 行 → 板 → HUD 元素
- 块配色集中在 `theme.ts`（含色盲方案），未来可换 sprite
- 帧循环只读 store 状态渲染，不做逻辑（逻辑在引擎 step，由 tick 驱动）
- **消行三闪动画（纯表现层，M5.5 已实现：`packages/client/src/game/clearFx.ts`，单测 `clearFx.test.ts`）**：引擎 `lock()` 时留存 `clearVisual`（消行前棋盘快照 + 待消失行号 + 自增 `id`），**不进 `stateHash`、不进协议快照，也不参与攻击/垃圾行判定**；客户端 `game/clearFx.ts` 的 `ClearFxTracker` 按 40ms/相位闪烁 3 次（亮-暗共 240ms）绘制该快照与行号，动画期间不绘制新块/Ghost，结束后切回实时棋盘（此时行已塌下）。对手小板不做动画（10Hz 快照更新，避免额外带宽）
- 服务端攻击结算：`Room.tickStep` / `botTick` 用 `for (let c = game.takeLastClear(); c; c = game.takeLastClear())` 逐个结算——同一 tick 内可能发生多次锁定（输入积压 / `game.inputBatch` / 补帧），只取一次会让前一次消行的攻击丢失

### 5.2 状态（Zustand）
| store | 内容 |
|---|---|
| `useRoomStore` | RoomState、selfSeatId、对手板视图（opponents，来自 `game.snapshot.others`）、mpStart（seed/快照基线）、countdown、result、toast、chatLog |
| `useSettings` | 手感（DAS/ARR/Ghost）、**键位映射（改键）**、**触控（输入形态/布局/尺寸/透明度/手势）**、音量；localStorage 持久化，`merge` 为旧版本存储补默认字段 |
| 已落地（M3/M4） | pendingGarbage（survival/timed 预警条）、攻击预警、淘汰观战状态、timed 计时/复活/免伤 HUD |

### 5.3 输入系统（三源合并，M6）
- 三个输入源：键盘（keydown/keyup）、屏上触控键（Pointer Events 的 press/release）、棋盘手势（指针轨迹 → 离散动作）
- 三者统一进 `input/router.ts` 的 `InputRouter`：按来源分别记录按住态再合成——方向「最近按下且仍按住者生效，任一来源未释放则不释放」，软降按「或」合成；只向 `GameCommands`（`apply/pressDirection/releaseDirection/setSoft`）发命令，**执行器（EngineRunner / NetGameRunner）完全不知道输入来自哪里**
- 键盘键位来自 `input/keymap.ts`（默认键位 + 用户改键；事件发生时读 store → 改键立即生效）；单字符键名统一小写归一
- 自动重复仍由 `AutoShiftScheduler` 负责（DAS/ARR/ARR=0 撞墙闩锁），触屏按住 ← / → 与键盘走同一条调度路径，不另写定时器
- 手势（`input/gestures.ts`）：轻点=旋转、横滑=逐格移动（阈值 0.8 格宽）、下滑=硬降或逐格软降、上滑=Hold；只跟踪第一根手指（多指忽略），默认关闭（`settings.gestures`）
- 生命周期清理：`pointercancel` / `lostpointercapture` / `window.blur` / `visibilitychange(hidden)` / 打开设置面板 / 断线 / 组件卸载 → `releaseAll()`，避免回前台后方向键"卡住"或棋子自己下滑
- 动作同时做两件事：① 本地 `apply`（乐观渲染）② `netClient.input(seq, action)` 上行（**触屏不新增任何协议消息**）
- `seq` 单调递增、**重连后不重置**；权威快照携带服务器已应用的最大 `seq` 作为确认位；收到权威快照不一致 → 覆盖 + 从快照 `seq` 重放未确认动作（俄罗斯方块动作可重放，代价低）
- 组合键保护：Ctrl/Cmd/Alt + 其它键不当作游戏键（避免 Ctrl+C 触发 Hold）；Ctrl 单独按下仍按默认逆旋处理

### 5.4 网络层 NetClient
- 状态机：`idle → connecting → hello → ready`；断线自动重连（指数退避 1s/2s/4s…上限 10s），携带 resumeToken
- 心跳应答服务器 ping；以服务器 `ts` 持续校正本地时钟偏移（timed 计时用），无 RTT 统计
- 用户动作消息在断线/重连期间排队、welcome 后回放（游戏输入类除外——服务端冻结棋盘，重放无意义）
- 所有入站消息按 `t` 分发到 handler；C→S 方向由 shared Zod schema 校验，S→C 信任同仓库服务端

### 5.5 单人模式执行模型（Marathon / Sprint 40）
- **纯本地权威**：单人模式不依赖服务器权威，客户端直接实例化 `shared/engine`，以 rAF 固定步长（60Hz）本地驱动——与服务端权威共用同一引擎代码，保证手感一致
- 大厅层在应用启动时即建立 WebSocket（联机房间/聊天需要）；单人模式下该连接仅维持心跳，不参与对局
- 暂停（Esc）即冻结本地步长循环（重力与锁定延迟同时冻结，FR-3.3）
- Sprint 40 完赛 / Marathon 顶出结束由客户端结算，最佳成绩写入 localStorage（`bearbricks.best.*`）
- 不涉及 protocol.md 游戏内消息；进入多人房间后才启用输入上行/快照校正

### 5.6 iPad / 触屏适配（M6）

**布局**
- 格子尺寸不再写死（原 `CELL=30/26`），改由 `game/fitCell.ts` 的 `computeCell(可用宽, 可用高, {cols:10, rows:20, min, max})` 反推：iPad 横屏受高度约束、竖屏受宽度约束、Split View / Stage Manager 可压到 ~320px
- `useFitCell` 用 `ResizeObserver` 观察棋盘容器 + `orientationchange` 重算；**尺寸只经 ref 传给 rAF，绝不进 GameView/GameViewMP 的 effect 依赖**（否则旋转屏幕会重建 runner、直接丢棋局）
- 布局：≥1024px 三栏（棋盘 + HUD + 对手 + 聊天）；<1024px 单栏（Hold/Next 压成横向条、对手横向缩略条 + 聊天抽屉、HUD 收进顶部）；单人对局用 640px 断点显示侧栏
- 高度统一 `100dvh`（Safari 工具栏伸缩），顶部/底部留 `env(safe-area-inset-*)`

**触控输入**
- `components/TouchControls.tsx`：左右两簇（← → 软降 / ⟲ ⟳ Hold ⤓），命中区基准 58px（设置可调 0.9/1/1.15 与不透明度）；`input/touchLayout.ts` 按容器宽度反算尺寸（5 键 + 3 内间距 + 外间距 + padding → 320px 时约 51px，<284px 换行兜底），`setPointerCapture` + `pointercancel` 释放，`touch-action:none` + 禁选择/长按菜单
- 显示条件：`(any-pointer: coarse)` 自动 + 设置项强制（`inputMode: auto|touch|keyboard`，妙控键盘/触控板场景可手动覆盖）
- 单人模式补屏上「暂停」按钮与「设置」入口（iPad 无 Esc）；联机 Esc = 设置面板**不暂停**（FR-12.2），打开面板即 `releaseAll()`

**iOS / Safari 运行时**
- `index.html`：`viewport-fit=cover`、`theme-color`、`apple-mobile-web-app-*`、`manifest.webmanifest`（standalone 启动；**不注册 Service Worker**——局域网 http 属非安全上下文）
- 输入控件字号 ≥16px（`index.css` 对 `(any-pointer: coarse)` 统一生效），否则 iOS 聚焦会强制放大整页；全局按钮 `min-height: 44px`
- 输入框补 `enterKeyHint` / `autoCapitalize` / `autoCorrect` / `spellCheck`（房间码 `characters`、聊天 `send`、昵称 `done`）
- 回前台恢复：Safari 后台会节流定时器/挂起 WS；`NetClient.reconnectNow()` + `visibilitychange(visible)` / `pageshow`（bfcache） / `online` 立即重连（先复位退避），重连走 resume → 服务端补发 `game.state.full`，客户端按 `mpStart.initial` 重建（不新增协议）
- 局域网 http 限制：`navigator.clipboard` 不可用 → 房间码复制回退为「手动抄写」提示；`wakeLock` / SW / 安装提示不可用
- 服务端无改动；建议部署时把 `GRACE_MS` 调到 45–60s（iPad 切后台更常见），并把局域网地址加入 `ORIGIN`

**设置屏（FR-11.1 第五屏，M6）**
- `components/SettingsPanel.tsx` 一份内容两种外壳：`SettingsView`（大厅入口的独立屏）与 `SettingsOverlay`（对局内模态）
- 分区：操作（改键：捕获式绑定 + 冲突提示 + 恢复默认）、触控（形态/布局/尺寸/透明度/手势）、手感（DAS/ARR/Ghost）、音效（音量已持久化，音效本体随 M6）
- 单人打开设置弹层时自动暂停（关闭只恢复由设置触发的暂停）；联机不暂停但 `releaseAll()`

## 6. AI 设计（BotController）
- 位置：服务端；每 tick 为 bot 生成输入事件，走与真人相同的 `game.input` 路径
- 评估：枚举当前块（含 Hold 权衡）的所有旋转 × 落点，模拟硬降后评估：
  `score = w1·聚合高度 + w2·空洞数 + w3·凹凸度 + w4·消行数 + w5·井深`
  （权重经 TC-BOT-001 批量对局回归调优）
- 难度参数：
| 难度 | 思考延迟 | 误操作率 | 说明 |
|---|---|---|---|
| EASY | 450ms | 30% | 全候选随机（明显更弱） |
| NORMAL | 300ms | 18% | 最优解但常失误 |
| HARD | 180ms | 6% | 最优解 + 攻击模式保留 Tetris |
- survival/timed 攻击模式对所有难度启用 4 消（Tetris）额外奖励（实现取"简单可解释"口径，未按难度区分；HARD 额外的时机压制留待调参）
- **M5 实现注记**（`packages/shared/src/ai/bot.ts`，纯 TS 零依赖）：
  - 评估权重：`cost = 0.510066·聚合高度 + 0.35663·空洞 + 0.184483·凹凸度 + 0.1·累计井深 − 0.760666·消行`（经典调优组合；M6 参数下调后固定 12 seed × 4000 tick：HARD 52.8 / NORMAL 39.8 / EASY 9.3 行，EASY 顶出 7/12、HARD/NORMAL 0）
  - 攻击模式（survival/timed）：4 消（Tetris）额外减 `0.8` 代价，替代「高度低于均值时优先攻击」的复杂判定
  - 执行模型：每权威 tick `decide()` 产出 ≤1 个动作（思考延迟 → 旋转 → 平移 → **逐格 soft** → 硬降），由 Room 走与真人相同的 `game.applyInput`；踢墙/垃圾行堵路卡住 3 tick 兜底也只 soft/等待锁定，保证永不挂死
  - **硬降门槛（M6）**：`BOT_MIN_HARD_DROP_ROWS = ceil(VISIBLE_HEIGHT/2) = 10`；每个方块必须从出生位置起逐格 soft 下降 ≥10 行后才允许 hard；提前落地则返回 null 交给锁定延迟（不直降抢跑）
  - 确定性：误操作 RNG 以 `${seed}:bot` 派生（独立于方块 bag 与垃圾行洞列 RNG）

## 7. 安全设计
- 输入即权限：未知消息类型、未 hello、或绕过 `game.input` 的伪造状态类消息一律回 E4031 并计数，累计 10 次断开（与 protocol §8、TC-SEC-001 一致）；E4010 只用于顶号/身份失效
- 限流（protocol §9）+ Zod 校验 + 4KB 上限
- 聊天：服务端清洗 + React 文本渲染
- 无 PII：playerId 为随机 UUID，不收集 IP 存储（仅限流内存窗口）
- Origin 校验（先 `new URL().origin` 归一化，容忍结尾 `/` 与路径）+ 生产强制 WSS；生产未配置 ORIGIN 时无 Origin 客户端也被拒
- 响应安全头（生产）：CSP、`X-Content-Type-Options`、`X-Frame-Options`、`Referrer-Policy`；静态资源 gzip/deflate（`@fastify/compress`）

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
USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "dist/index.mjs"]
```
- server bundle 中 shared 源码已打进 `dist/index.mjs`（esbuild --bundle），运行时需要 fastify/ws/zod/@fastify/compress（均 external）
- 静态目录定位：`app.ts` 默认按 `../../../packages/client/dist` 向上三级定位（兼容 tsx 源码运行），
  **容器/自定义布局用 `CLIENT_DIST` 环境变量覆盖**
- 环境变量：`PORT`、`ORIGIN`、`NODE_ENV`、`TRUST_PROXY`（可信反代后取真实 IP 做限流）、`LOG_LEVEL`，以及全部限额/节奏项 `MAX_CONN_PER_IP`、`MAX_CONNECTIONS`、`ROOM_CREATE_LIMIT`、`ROOM_CREATE_WINDOW_MS`、`JOIN_FAIL_LIMIT`、`ROOM_TTL_MS`、`GRACE_MS`、`HEARTBEAT_MS`、`MAX_MSG_PER_SEC`、`INPUT_RATE_LIMIT`、`CHAT_MSG_PER_10S`、`MAX_SOCKET_BUFFER_BYTES`、`MAX_ERRORS_PER_SEC`（默认值见 README「环境」表；全部集中在 `packages/server/src/config.ts`，非法值回退默认）
- **静态资源（v1.2）**：`/assets/*`（Vite 指纹）长缓存 immutable；`index.html`、`manifest.webmanifest`、图标用 no-cache；`.webmanifest` MIME = `application/manifest+json`
- **结构化日志（NFR-6/NFR-7）**：房间/座位/对局事件统一 `{ event, room, ... }` JSON（`room.create` / `seat.join` / `seat.leave` / `seat.eliminated` / `seat.finished` / `game.start` / `game.finish` / `room.rematch` / `room.destroy` / `ws.reject`），由 Fastify pino logger 输出；`LOG_LEVEL=silent` 可静默
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
- Vitest：shared 98 / client 57 / server 29（真实 ws 端口，随机高位端口，afterAll 关闭）
- Playwright：多 browser context 模拟 4 玩家（见 test-plan.md）
- 压测：M6 待补（bench 脚本未落地）
- ESLint flat config + Prettier + tsc --noEmit；GitHub Actions：lint → typecheck → test → coverage → build（E2E 待 M6 接入）

## 11. 风险与缓解（技术侧）
| 风险 | 缓解 |
|---|---|
| setInterval 漂移 | 累加器补偿：每次回调按真实时间补 tick |
| JSON 快照体积增长 | 行编码 + 变化才发 + MessagePack 后备（Codec） |
| TCP 队头阻塞造成对手板延迟 | 对手板 10Hz 且仅变化发送，可容忍；不为此引入 UDP |
| AI 体验突兀（瞬移决策） | 思考延迟 + 移动动作拆分为逐格 move 上行 |
| 浏览器标签页后台 rAF 暂停 | 权威在服务器；回前台用全量快照重建 |
| iPad/Safari 后台挂起、bfcache 恢复 | 回前台 / `pageshow` / `online` 调 `reconnectNow()`；resume + `game.state.full` 全量重建 |
| 旋转/分屏导致执行器重建、棋局丢失 | 格子尺寸只经 ref 传入 rAF，**不进 effect 依赖**（编码约定 + 代码注释） |
| iOS 输入聚焦放大 / `100vh` 溢出 | 输入控件字号 ≥16px + `100dvh` + `viewport-fit=cover` + 安全区 |
| 局域网 http 非安全上下文 | 不做 SW/离线；剪贴板回退手动抄写；文档建议需要 PWA 时改 HTTPS |
| 触屏与键盘同时按住互相取消 | `InputRouter` 按来源记录并合成（单测：键盘+触屏同向、软降或合成） |

