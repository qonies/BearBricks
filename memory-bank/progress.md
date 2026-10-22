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
| M5 | AI 机器人（3 难度）+ 聊天 UI | ⬜ 未开始（server 端聊天协议已实现，UI 未做） |
| M6 | 打磨：设置/音效/可访问性/压测/Docker 部署 | ⬜ 未开始 |

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

## 未开始 / 已知事项
- 真实 AI（M5，M2 用临时 bot 占位：新块 0.5s 后硬降）与聊天 UI（聊天 UI 已于 M3.5 落地，剩 AI）
- Playwright E2E（TC-UI-002~007）待装浏览器；带宽/200 房压测（M6）

## 经验教训 / 注意事项
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
- `git init` + 推送 GitHub 已于 2026-10-22 完成（qonies/bearbricks 私有仓库；gh 凭据助手配在 repo 级，因 cygwin git HOME 无效不能用全局配置）；`allowScripts` 不是 npm 官方字段（pnpm 语义），npm 11 会忽略
