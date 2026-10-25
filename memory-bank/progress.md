# 项目进度（Progress）

## 总体状态
| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 | 需求/技术/协议/测试文档 + Memory Bank + ADR + 文档问题修复 | ✅ 完成 |
| M1 | 单人可玩（shared 引擎 + Canvas 渲染 + 手感） | ✅ 完成（2026-10-22） |
| M2 | sprint 竞速赛联机（4 人，网络层打通 + 乐观渲染校正） | ✅ 完成（2026-10-22） |
| M2.5 | 安全加固（信封/原型链/maxPayload/XFF）+ 重连闭环 + 行为一致性修复 | ✅ 完成（2026-10-22） |
| M3 | survival 生存淘汰（攻击/垃圾行/淘汰观战） | ✅ 完成（2026-10-22） |
| M3.5 | 全量代码审查修复（27 项）+ 协议 v1.3 + 聊天 UI | ✅ 完成（2026-10-22） |
| M4 | timed 限时赛（计时同步/复活/免伤） | ✅ 完成（2026-10-22） |
| M4.5 | 全量审查修复（P0×2 + P1×9 + 文档同步，协议 v1.5） | ✅ 完成（2026-10-22） |
| M5 | AI 机器人（3 难度，替换临时 bot） | ✅ 完成（2026-10-23） |
| M5.5 | 全量审查修复（P1×4 + P2 多项 + 文档同步，client 19 / server 21 用例） | ✅ 完成（2026-10-23） |
| M6 | 打磨：设置/音效/可访问性/压测/Docker 部署 | 🚧 进行中（2026-10-25 第四轮：P1/P2 审计修复 + AI 下调/直降门槛 ✅；**shared 98 / client 57 / server 29**；设置屏 + 改键 + 触屏 + iPad 自适应 ✅；音效本体 / 色盲 / 压测 / E2E / Docker 实测仍缺） |

## 已完成
- [x] 需求澄清（三模式、无登录、聊天、AI 混战）
- [x] 技术路线确定（ADR-0001~0005）+ 文档交叉审查修复
- [x] monorepo 脚手架（npm workspaces：shared/client/server）
- [x] M1：shared 引擎（SRS/7-bag/消行/计分/T-Spin/攻击表/TetrisGame）+ 单人 Marathon/Sprint40 + 本地最佳成绩
- [x] **代码审查 13 项问题修复**（引擎手感/输入调度/协议缺口/文档一致性/工程化）
- [x] M2：协议 v1.1（seed/soft/inputBatch/state.full/rematch/addBot difficulty/error/ping）+ server（房间状态机/60Hz GameLoop/快照节流/心跳/宽限/限流/Origin/优雅停机/静态托管）+ client（NetClient/大厅/房间/联机对战屏/乐观渲染校正）
- [x] 工程化：ESLint flat config + Prettier + GitHub Actions CI + README + coverage（shared 92.2%，目标 ≥85%）+ git 仓库
- [x] 测试：shared 54 + client 7 + server 集成 5 全绿；`npm run build`（client vite + server esbuild）通过；构建产物 /healthz 与 / 200 烟测通过
- [x] **M2.5 修复**（P0×5 + P1×13 + 文档一致性 15 项）：协议鲁棒性（null/原型链键/超大帧不崩服，集成测试回归）、playerId 不下发 + selfSeatId、resume 接管语义、宽限期冻结、结算排除放弃者、ARR=0 闩锁、终局停发输入、心跳 30s、Dockerfile/CI/覆盖率阈值；测试需 `ROOM_CREATE_LIMIT=20`
- [x] **M3 survival**（2026-10-22）：
  - shared：`modes/strategy.ts`（GameModeStrategy 抽象 + Sprint/Survival 策略 + 工厂，ADR-0005 落地）+ `modes/survival.ts`（computeSurvivalRanking）+ 引擎 `takeLastClear()`/`validateActiveAfterBoardChange()` + 协议 v1.2（`game.attack`、`modeState.survival`、对手快照 `eliminated`/`pendingGarbage`）
  - server：Room 接入策略实例（updateSettings 切换）；攻击链路 onLinesCleared→offset→转发存活对手→`game.attack`；pendingGarbage + 500ms(30 tick) 缓冲 + 单批 ≤8 行插入（独立 `${seed}:garbage` Rng，不污染方块 bag）；顶出 ELIMINATE + `game.topOut` + TOP_OUT 系统消息；存活数 ≤1 结束；survival 排名结算；淘汰者保留座位可聊天（输入静默丢弃）；timed 仍 E4031（M4）
  - client：NetGameRunner 由 mode 驱动引擎（survival→marathon 语义）；GameViewMP 红色攻击预警条 + 存活数 HUD + 自淘汰观战提示 + 对手淘汰/预警显示；RoomView 启用 survival 选项；结算屏 survival 显示
  - 测试：shared `survival.test.ts`（TC-MD-B-001/002/003 等 12 用例）+ server `survival.integration.test.ts`（真实 ws 全流程：模式切换→攻击→垃圾行→淘汰→结算→rematch 无残留）；全量 shared 66 + client 8 + server 6 全绿；typecheck/lint/coverage（modes 100%）/build 通过；protocol.md 升 v1.2
- [x] **全量代码审查修复（2026-10-22，M3.5）**（覆盖 27 项问题）：
  - **规则正确性**：survival 不再被 Room 层 300s 强制结算（超时限定 sprint）；survival 结束判定改用 `survivalAliveSeats()`（宽限内离线不提前终局，掉线者不再"断线保平局"）；垃圾行插入统一走 `TetrisGame.receiveGarbage()`（active 随棋盘上移 + 无条件顶出校验，修复方块被埋进垃圾行）；`resumeSeat` 复位 softDrop/pendingInputs（修复重连后棋盘自己下冲）；`handleInput`/`handleSoft` 增加 `phase === 'PLAYING'` 守卫（FINISHED 后输入回 E4031，不再堆积）
  - **协议 v1.3**：`RankingEntry.status` 增加 `eliminated`（survival 淘汰不再混用 finished）；`game.topOut` 口径明确（sprint 顶出引擎内部处置、不下发）；新增每连接入站消息限流 120 条/s（Session 滑动窗口，超限断开，防房间外 CPU DoS）
  - **客户端**：修复"建房/加入后停留大厅"缺陷（room.state → 导航房间屏）；resume 失败/服务器重启（welcome 无 room）回大厅；重连横幅（net.onStatus）；聊天侧栏 `ChatPanel` + `chatLog` store + `i18n.ts` 骨架（chat.message/chat.system 接入、聊天框聚焦时游戏键让路）；改昵称后 `net.rehandshake()` 重建握手；大厅 Toast 去重；`game.attack` 攻击闪烁提示；结算屏 abandoned 显示"放弃"
  - **服务端健壮性**：uncaughtException/unhandledRejection 以非零码退出（NFR-4）；dev Origin 放行私有网段（局域网联机主场景）；静态目录 path 前缀加固 + 指纹资源缓存头；`transferHost` 不再转让给 AI/无真人时保持空位；VICTORY 平局逐人播报；心跳计时修正（连续 2 个 ping 无 pong ≈30s 判断线）；删除死代码 `destroyRoom`；昵称去重后缀不超 12 字符
  - **文档同步**：README（M3 状态/v1.3/聊天/NAT 注意）、technical-design §2.1（M3 目录）§2.3（实际策略接口）、ADR-0005（接口修订记录）、techContext（环境实测 Node 24/npm 11、`.git` 未初始化、用例数）、test-plan（M3 集成测试）、过时注释（room/GameViewMP/garbage/board/srs）
  - **测试**：+2 shared（receiveGarbage 随动上移/no-op）+3 server（宽限不提前终局+resume 复位、FINISHED E4031、入站限流；TestClient 回应心跳）+1 client（i18n/chatLog，5 用例）；**shared 68 + client 13 + server 8**
- [x] **M4 timed 限时赛（2026-10-22）**：
  - shared：`modes/timed.ts`（computeTimedRanking：总分→消行→顶出次数，完全同值并列，abandoned 移出）+ `TimedStrategy`（攻击与 survival 同表 / onTopOut RESPAWN / marathon 语义）+ 引擎 `TetrisGame.respawn()`（清盘保分保消行、combo/b2b 清零、bag 延续）+ 常量（TIMED_IMMUNE_MS/TIMED_TIME_LIMITS/TIMED_DEFAULT_TIME_LIMIT）+ 协议 v1.4（modeState.timed{endsAt,respawnAt?,immuneUntil?}、game.start.timeLimit、updateSettings 放行 timed、RankingEntry.score）
  - server：updateSettings 放行 timed（timeLimit 120/180/300 校验、默认 180）；markSeatGameEnded timed 分支（topOuts+1、respawnUntilTick=+180 tick、immuneUntilTick=+360、待收垃圾清空、game.respawn、广播 topOut/RESPAWN + chat.system RESPAWN）；tickStep 复活倒计时冻结 + immuneUntilTick 到期清理；attackTargets() 排除复活/免伤座位；insertDueGarbage 放行 timed；计时归零 finishGame('timeout')；宽限超时计顶出；finishGame timed 排名分支；selfModeState timed（epoch ms）+ 快照 key 增 timed 字段
  - client：NetGameRunner.syncTimed（modeState.timed.respawnAt 驱动本地 respawn + 清 inputLog + 冻结输入）；GameViewMP timed HUD（剩余时间/复活倒计时/免伤横幅/得分）+ 结算屏分数显示；RoomView timed 选项 + 时长选择器
  - 测试：shared `timed.test.ts` 9 用例 + server `timed.integration.test.ts` 2 用例（真实 ws 全流程：校验→攻击→顶出 RESPAWN→冻结→免伤→归零结算→rematch 无残留）+ survival 测试 timed 断言更新；server `vitest.config.ts` `fileParallelism: false`（tick 时序稳定）；**shared 77 + client 13 + server 10 全绿**；protocol.md 升 v1.4、README/test-plan 同步
- [x] **M4.5 全量审查修复（2026-10-22，协议 v1.5）**：
  - **P0**：客户端接入 `game.snapshot.others`（此前从未订阅 → 对手小板/预警全部不显示）；self 快照（含 `game.state.full`）增加可选 `status`，`NetGameRunner` 用权威状态校正本地预测卡死（本地顶出 finished 但权威 playing → 恢复 running；eliminated/abandoned/finished → finished 观战/终局），`GameViewMP` 观战显示 + `game.topOut` 即时反馈 + 收到 result 停引擎
  - **P1**：timed 断线宽限超时按 FR-10.3 改为"计顶出并继续复活循环"（`checkGrace` 三模式分支：sprint abandoned / survival eliminated+播报 / timed 复活循环且保留座位与 resumeToken）；timed 顶出清 `pendingInputs`/`softDrop`（服务端 + 客户端 syncTimed 同步）；`receiveGarbage` 垃圾溢出 → 顶出（此前静默丢方块）；`holdSwap` 修复双重出生下移；timed 计时改用 `NetClient.serverNow()` 服务器校正时钟（HUD + 冻结窗口）；房主补位（hostSeat 空时加入者接任）+ 转让优先在线真人；FR-4.3 真人加入可替换 AI 座位；FINISHED 重连补发 `game.result`；VICTORY 消息补 nickname；倒计时本地每秒递减；timed `modeState.pendingGarbage` 预警条 + 实时排名 HUD；聊天 trim/空白不广播
  - **P2/P3**：Hold/Next 小窗 HiDPI（`render.hiDpiCanvas`）；Lobby 文案；快照去重 key 补 timed.pendingGarbage/status
  - **文档同步**：protocol.md v1.5、technical-design.md v1.1（目录/校正策略/store 现状）、ADR-0004 措辞、README 协议版本、techContext 用例数、本文件 M5 行勘误（聊天 UI 已落地）
  - **测试**：shared 83（+6）/ client 16（+3）/ server 11（+1，timed 宽限复活循环全流程）全绿；typecheck/lint 通过
- [x] **M5 AI 机器人（2026-10-23）**：
  - shared：新增 `ai/bot.ts`（纯 TS 零依赖，index 导出）——`BOT_DIFFICULTY_PARAMS`（EASY 300ms/15%、NORMAL 150ms/5%、HARD 60ms/0%）+ `enumeratePlacements`（旋转×列全枚举硬降模拟）+ `evaluateBoard`（聚合高度/空洞/凹凸度/累计井深）+ `BotController.decide()`（每权威 tick 产出 ≤1 个 GameAction：思考延迟→Hold 权衡 margin 0.3→误操作扰动→旋转→平移→硬降；卡住 3 tick 兜底硬降）+ `simulateBotGame` 无头模拟；误操作 RNG 以 `${seed}:bot` 派生（独立于 bag/garbage RNG，可复现）；攻击模式 4 消额外 −0.8 代价；实测 12 seed×4000 tick：HARD 149 行 / NORMAL 94 / EASY 27（EASY 顶出 8/12、HARD 0）；调参脚本 `scripts/bot-tune.ts`
  - server：Seat 用 `bot: BotController | null` 替换临时 bot 字段；beginGame 按 difficulty+seed 创建（attackMode = mode ≠ sprint）；botTick = decide → `game.applyInput`（与真人同一输入通道）→ finished 走 markSeatGameEnded
  - 测试：shared `bot.test.ts` 9 用例（含 TC-BOT-001 批量回归 HARD≫EASY、timed 顶出→respawn→继续对局）+ server `bot.integration.test.ts` 2 用例（TC-BOT-002 移除 AI、TC-BOT-001 同一 GameLoop 路径）；**shared 92 + client 16 + server 13 全绿**；typecheck/lint/build 通过
  - 文档：README AI 行 ✅、technical-design §6 实现注记、test-plan TC-BOT 实现状态
- [x] **M5.5 全量审查修复（2026-10-23）**：
  - **P1**：① ARR=0 高刷新率输入风暴（闩锁静默 + resetWallLatch + 失败动作不上行，240Hz 实测 126→≤11 msg/s）；② timed 复活客户端二次 respawn（syncTimed → resync 顺序，active/queue 与服务器一致）；③ 倒计时离线绕过 30s 宽限（beginGame 不设 abandoned + checkGrace 幂等 + survival 不再开局即终局）；④ 生产 LAN Origin（启动警告 + README/config 测试）
  - **P2**：聊天 handler 上移 App + RoomView 聊天面板；倒计时取消清遮罩；timed pending 归零；断线暂停 + 重连遮罩；handleInput 丢弃确认 seq；NetClient 看门狗/发送队列/clearResumeToken/E4010 终态；房主转让按 joinedAt；bot 消行攻击同 tick 结算；bot 昵称去重；淘汰清 pendingGarbage；handleSoft 守卫；quickMatch 可替换 AI；无真人不开局；快照 key 补字段；结算昵称；新纪录标志；vite host
  - 测试：新增 room.lifecycle（4）/config（3）/bot.attack（1），autoshift +1、netGame +2；timed 复活期断言改 lastSeq=500（新语义）；**shared 92 + client 19 + server 21 全绿**
  - 文档：README / technical-design（§1/§2.1/§3.1/§5.1/§5.4/§6/§10）/ protocol §8 / systemPatterns / techContext / messages.ts 头部 同步
  - 遗留：E2E 仍未接入；压测/日志指标/NFR-7 环境变量化留 M6；survival 主动离开排名口径与 timed 免伤出攻待产品确认
- [x] **消行反馈 + 攻击结算修复（2026-10-25）**：
  - **P1（丢攻击）**：同一 tick 内多次锁定（输入积压 / `game.inputBatch` / 补帧）时，后一次"无消行锁定"会把单槽 `lastClear` 置 null，前一次消行的攻击丢失。修复：引擎改 `clears: LastClear[]` 队列（`lock()` 入队、`takeLastClear()` 队列优先出队、复活/快照校正清空），`Room.tickStep`/`botTick` 循环结算
  - **三闪动画（纯视觉）**：`board.findFullRows()` + `TetrisGame.clearVisual`（`lock()` 消行前留存棋盘快照 + 行号 + 自增 id，不进 `stateHash`/快照）+ client `game/clearFx.ts`（40ms/相位 × 3 次闪烁 = 240ms，`ClearFxTracker`）+ `render.ts` 覆盖层（动画期间不绘制新块/Ghost），接入 `GameView`/`GameViewMP`；对手小板不做动画
  - 测试：**shared 96（+4）/ client 25（+6，新增 clearFx.test.ts）/ server 22（+1，room.attack.test.ts）全绿**；typecheck/lint/coverage（shared 98.05%）通过
  - 文档：technical-design §5.1、requirements FR-11.2a
- [x] **全量审计修复（2026-10-25，协议 v1.6）**：文档+代码全量审计（4 P1 / 8 P2 / 11 文档偏差），本轮修完 P1 与可安全落地的 P2：
  - **P1-1 对手 seed 泄漏**：`game.start` 改为**按座位单独下发**，`seeds` 只含本人座位（原实现广播全房间 seed，客户端可离线复现对手 7-bag 队列）；`Room.beginGame` 逐座位 `send`，协议/技设/messages.ts 注释同步，新增 `room.rules.test.ts` TC-ROOM-007
  - **P1-2 timed 免伤期仍出攻**：新增 `Room.canAttack`（复活倒计时/免伤窗 → 消行不转发、也不抵消自身待收垃圾），与 requirements §4.5"不收发攻击"对齐；用例 TC-MD-C-004
  - **P1-3 每 IP 限额过紧/硬编码**：`MAX_CONN_PER_IP` 默认 5 → **20**，并全部环境变量化（含新增 `MAX_CONNECTIONS` 全服上限）；建房默认 3 → 5/10min
  - **P2-3 survival 主动离开口径**：与断线宽限超时统一走 `eliminateSurvivalSeat`（判淘汰、座位保留垫底、resumeToken 作废），`rematch` 清理不可恢复的幽灵座位；用例 TC-MD-B-005
  - **P2-1 计时补偿用本地时钟**：`GameViewMP` 的 `elapsedOffsetMs` 改用 `net.serverNow()`（服务器校正时钟）
  - **P2-2 限流丢弃不确认 seq**：丢弃路径同样推进 `lastSeq`，客户端可裁剪 inputLog（TC-NET-006）
  - **P2-4 连接层防护**：`Session.send` 背压断开慢客户端；`sendError` 错误回包限速；`WsHub` 全服并发上限 + 429/503 明确状态码；静态资源改异步 `fs/promises`
  - **P2-5/6/7 客户端健壮性**：建连失败计数 → ≥3 次显示"连不上/ORIGIN"可操作提示；`readBest/writeBest`、`identity.ts` localStorage 全部 try/catch；对手小板 HiDPI
  - **NFR-6/NFR-7**：新增 `server/src/log.ts`（Logger 接口）+ 房间/座位/对局事件结构化日志（`room.create`/`seat.join`/`seat.leave`/`seat.eliminated`/`seat.finished`/`game.start`/`game.finish`/`room.rematch`/`room.destroy`/`ws.reject`）；`config.ts` 统一 env getter（非法值回退默认）
  - 测试：**shared 96 / client 25 / server 28（+6：room.rules 5 + config 1）全绿**；typecheck / lint 通过
  - 文档：README 环境变量表、protocol v1.6（changelog/§3/§4/§9）、technical-design（§2.1/§3.1/§3.2/§4.2/§4.3/§9/§10）、requirements FR-10.4、test-plan（TC-ROOM-007/TC-MD-B-005/TC-MD-C-004/TC-NET-006/007/TC-SEC-009 + §10 时间仿真现状）
- [x] **iPad / 触屏支持（2026-10-25，协议不变、服务端零改动）**：用户决策 1B / 2B / 3B / 4A（iPad 横竖屏+分屏 / 按键+手势 / 独立设置屏 / 局域网 http）
  - 输入层：`src/input/`（`commands` 抽象 + `router` 三源合并 + `gestures` 手势识别 + `keymap` 改键 + `useGameInput` 键盘/手势/清理）
  - 触控 UI：`TouchControls`（pointer capture、58px 基准、左右手布局、透明度）+ `GameView` 屏上「暂停」「设置」
  - 视口：`game/fitCell.ts` + `game/viewport.ts`（ResizeObserver 反推格子尺寸、`100dvh`、三档布局、聊天抽屉、对手横向条）
  - 设置屏：`SettingsPanel/SettingsView/SettingsOverlay`（操作/触控/手感/音效；改键捕获 + 冲突提示 + 恢复默认）；联机 Esc 打开面板**不暂停**（FR-12.2 落地）
  - iOS/Safari：`viewport-fit=cover` + apple-meta + manifest（**不注册 SW**）、输入框 ≥16px、`enterKeyHint`、房间码剪贴板回退、`NetClient.reconnectNow()` + `visibilitychange/pageshow/online`
  - 测试：client 25 → **51**（inputRouter 6 / gestures 9 / keymap 7 / fitCell 4）；typecheck / lint / build 通过；产物烟测 `/healthz` 与 `/manifest.webmanifest` 均 200
  - 文档：README（iPad 章节）、requirements（FR-11.2/FR-12.x/NFR-2/NFR-5）、technical-design（§5.3 重写 + 新增 §5.6 + §11 风险）、protocol §4 输入来源说明、test-plan v1.1

## 本轮产出（2026-10-25 第四轮：审计修复 + AI）
- 规则：survival `rankBottom`（主动离开/宽限超时垫底、已淘汰观战者离开保留原名次）；timed 复活冻结中掉线不重复计顶出；房主转让优先可用真人；survival 离开不再双播系统消息。
- 联机：协议 v1.7 `spawnCount` + 7-bag 重连对齐（9 块回归）；PLAYING 广播 room.state；tickStep 阶段守卫；E4010 先 flush 再断开、未 hello 改 E4031；welcome 前动作入队；顶号全屏遮罩。
- 客户端：App `applyRoom` 统一 welcome/room.state（修复重连卡旧对局屏）；聊天 IME；手势多指；320px 触控自适应（`touchLayout.ts`）；单人设置自动暂停；MP HUD 仅 sprint 显示目标 + 重连初始 HUD；sprint 完赛等待提示；44px 命中区。
- 部署：manifest MIME/缓存修正、PWA 图标/apple-touch-icon、CSP/安全头、`@fastify/compress`、Docker `USER node` + HEALTHCHECK、Origin 归一化、config getter、昵称清洗、`/healthz` 房间数。
- AI：EASY/NORMAL/HARD = 450/300/180ms、0.30/0.18/0.06；每个方块逐格 soft ≥10 行后才允许 hard（提前落地等待锁定）。
- 测试：shared 98 / client 57 / server 29；typecheck/lint/coverage/build 通过。

## 未开始 / 已知事项
- Playwright E2E（TC-UI-002~007、012~021，含 iPad project）待装浏览器；带宽/200 房压测（M6）
- M6 仍缺：音效本体（iOS 需首次手势解锁 `AudioContext`）、色盲配色（TC-ACC-001）、Perf/ACC/COMPAT 真机专项、Playwright E2E（含 iPad project）、Docker 镜像实测
- 依赖：`npm audit --omit=dev` 仍有 zod <4.6.6 high advisory（4KB 上限降低暴露面；zod 4 迁移单独排期）；本轮新增 `@fastify/compress` 生产依赖（无新增生产审计项）
- 硬降与 T-Spin 口径：代码现状 = 原地硬降（d=0）保留 T-Spin、位移硬降取消；且软降不清理 `lastActionRotation`；建议手感评审定夺
- 审计遗留（P2/P3 可接受项）：对手快照仍含 2 行隐藏区（协议 §5 已声明，属小幅信息冗余）；`E5000` 定义未发送（协议已标"保留"）；`allowScripts` 非 npm 官方字段（npm 11 忽略）；Docker 镜像仍未本机实测
- 工作树状态：本轮改动未提交（`git status` 显示大量 modified/untracked），按项目规则**未获明确指示不 push**

## 经验教训 / 注意事项
- **7-bag 是隐藏状态**：只下发 seed + 8 个 queue 不足以重连对齐；必须带 `spawnCount`（或 bag 剩余）并在 `applySnapshotState` 重建游标。
- **垫底 ≠ abandoned**：survival 需要 `rankBottom` 只影响排名，不能用 `abandoned`（它会阻止 late resume 观战）。
- **E4010 与 E4031 不能混用**：E4010 是客户端终态（顶号），未 hello 是状态错误；错误消息必须先 flush 再断开（`terminate` 会丢弃）。
- **IME**：`keydown` 的 Enter 在 composition 中也会触发，必须查 `nativeEvent.isComposing`。
- **320px 触控**：固定 58px×5 + 间距在 320px 必然溢出；按容器宽度反算并保留 44px 命中区。
- **AI 难度**：调参不只看思考延迟；「逐格软降半程」会显著降低落子速度，需同时看批量回归的消行/顶出率。
- PowerShell 5.1：命令用 `;` 连接；`$env:XXX` 在同一 shell 会话内跨命令残留（烟测端口前先清理）；`Start-Process` 才是后台运行方式（`&` 不是）
- npm 12 拦截安装脚本：esbuild 需 allowScripts（root 已声明 0.25.12；tsx 依赖的 0.28.2 postinstall 被拦但可选二进制可用，tsx 正常）
- server esbuild：`--external:fastify --external:ws --external:zod`，shared 源码打进 bundle（Node ESM 无法加载 extensionless TS）
- 静态目录定位：`app.ts` 以 `../../../packages/client/dist` 向上三级（src 与 dist 同深度），Docker 布局需匹配
- 每轮测试后必须关闭后台进程释放端口（本轮已验证无 node 监听残留）
- Guideline 重力公式指数为 `lv-1`（L1 = 1.0 秒/行）；出生后下移一格是 Guideline 标准行为
- workspace 根 package.json 需 `"type": "module"`（eslint.config.js 为 ESM）
- PowerShell 5.1 文本替换必须用 `[System.IO.File]::ReadAllText/WriteAllText` + `UTF8Encoding($false)`；`Get-Content | Set-Content -Encoding UTF8` 会按 ANSI 误读中文且写入 BOM
- 集成测试同 IP 触发建房限流：beforeAll 设 `process.env.ROOM_CREATE_LIMIT`（config 用 getter 延迟读取）
- ws 层 `maxPayload` 先于应用层 4KB 检查生效：超大帧直接 close、无应用层 error 消息
- **集成测试 TestClient 模式**：client 构造即连接，`open()` 必须处理 `readyState === OPEN` 直接 resolve（否则错过 open 事件永挂）；等待断言用 `nextWhere(pred)` 跳过队列中陈旧消息（否则读到加入时的旧 room.state）；开局前别忘了 `game.ready`；**TestClient 必须回应服务器 ping**（否则 >30s 的用例会被心跳判定断开）
- 心跳语义：15s 一个 ping，"连续 2 个 ping 无 pong" → 断开时刻 ≈ 最后一次 pong 后 30s（发 ping 后立即判 `pingId - lastPongId >= 2`）
- 垃圾行与 active：`insertGarbage`（board 层）只移动棋盘格；active 随动上移与顶出校验必须走 `TetrisGame.receiveGarbage`，否则方块会被埋进垃圾行
- survival 的两个"存活"口径必须分开：结束判定/HUD 用 `survivalAliveSeats`（含宽限内离线者），攻击目标用 `aliveSeats`（再排除离线，FR-10.2 不收发攻击）
- **seed 即隐藏信息**：`game.start` 只下发本人 seed（v1.6）。曾经"对手板可见所以 seed 无风险"的推断是错的——seed 可离线复现对手整局 7-bag 队列
- **限流丢弃也必须确认 seq**：否则客户端 inputLog 永不裁剪，每次快照重建都把陈旧输入重放一遍（服务端已丢弃 → 持续分歧）
- **"主动退出"不能比"掉线"更划算**：survival 主动离开必须与宽限超时同判淘汰（`eliminateSurvivalSeat` 统一入口），否则退出即从排名消失
- 座位保留类改动要顺带检查 rematch：无 session 且 resumeToken 已作废的座位必须在 `rematch()` 里清空，否则永远是"未准备"的幽灵真人卡死开局条件
- 服务端限流/节奏参数一律用 config getter 读 env（每次调用读 → 测试可临时覆盖）；不要再用模块级常量
- 测试里直驱 `Room` 时：`handleInput` 只入队、`lastSeq` 在 tick 应用时才推进（tickStep 才会推进），断言 ack 语义要区分"已入队"与"已应用"
- `git init` + 推送 GitHub 已于 2026-10-22 完成（qonies/bearbricks 私有仓库；gh 凭据助手配在 repo 级，因 cygwin git HOME 无效不能用全局配置）；`allowScripts` 不是 npm 官方字段（pnpm 语义），npm 11 会忽略
- **iPad 适配的四个硬坑**：`100vh` 在 Safari 会溢出 → `100dvh`；输入框字号 <16px 会被 iOS 强制放大整页；`navigator.clipboard` 在 http 局域网下不可用（非安全上下文，需回退）；iPadOS 无可用全屏 API → 只能「添加到主屏幕」standalone
- **格子尺寸只能走 ref**：`useFitCell` 的结果若进 `GameView`/`GameViewMP` 的 effect 依赖，旋转/分屏会重建 runner 直接丢棋局
- **三源输入必须按来源合并**：`AutoShiftScheduler` 只有一个 held 槽，键盘与触屏同按同一方向时 `release` 会互相取消（`InputRouter` 解决，已有单测）
- **StrictMode 下不要在 setState updater 里做副作用**（暂停开关改为先算 next 再 set + 直接改 `runner.paused`）
- **Playwright WebKit ≠ 真机 iPadOS**：`pointercancel`、后台挂起、软键盘行为必须真机验证
- 本机 `npm run build --workspace @bearbricks/server` 在 PowerShell 里会因 esbuild 写 stderr 被判失败（exit 1），直接 `npx esbuild ...` 退出码 0、产物正常；判断构建成功请看 `packages/server/dist/index.mjs` 时间戳
