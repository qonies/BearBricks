# 当前工作上下文（Active Context）

## 当前阶段
**M4.5 全量代码审查修复完成**（2026-10-22：协议升 v1.5；修复对手快照客户端缺失、乐观渲染 status 卡死、timed 宽限口径、垃圾溢出、Hold 双重下移等 13 项 + 文档/记忆库同步；用例 shared 83 + client 16 + server 11 全绿）

## 本轮产出（2026-10-22，M4.5 修复，起因 = 全量文档+代码审查）

### P0（多人核心功能）
- **客户端从未订阅 `game.snapshot.others`** → 对手小板/分数/淘汰状态/预警全部不显示。修复：`App.tsx` 注册 handler → `applyOthers`（服务端本来就 10Hz 下发，纯客户端缺陷；无组件/E2E 测试所以一直没暴露）
- **`applySnapshotState` 不恢复 status → 本地预测顶出后客户端永久卡死**（快照无 status 字段，resync 无法解除 finished）。修复：协议 v1.5 给 self 快照（含 game.state.full.self）加可选 `status`；`NetGameRunner` 把权威 playing→引擎 running、eliminated/abandoned/finished→finished（hash 一致时也同步）；`GameViewMP` 改用服务端 status 驱动观战显示 + `game.topOut` 即时反馈

### P1（规则/一致性）
- **timed 断线宽限超时改为"计一次顶出并继续复活循环"**（用户确认按需求 FR-10.3 改代码，不再 abandoned）：`checkGrace` 按模式处置（sprint=abandoned+token 作废 / survival=eliminated+ELIMINATE 播报 / timed=markSeatGameEnded 复活循环，座位与 resumeToken 保留、迟到 resume 可恢复）；`disconnectedAt` 处置后清空防重复触发；新增 timed 集成用例验证（不 abandoned、仍在排名、迟到 resume、计时归零仍在排名）
- timed 顶出处置清空 `pendingInputs`/`softDrop`（复活后不得重放旧输入）；客户端 `syncTimed` 同步 `setSoft(false)`
- **垃圾行溢出 → 顶出**：`receiveGarbage` 使用 `insertGarbage` 的 discarded 信号（此前被忽略 → 满盘插垃圾方块凭空消失且不判负）；marathon→finished/topOut，sprint→清盘重来
- **Hold 双重出生下移**：`holdSwap` 空 Hold 分支 `spawnActive()` 已含 postSpawnDrop，末尾又调一次 → 出生块多降一格；修复后 Hold 出生与正常出生 y 一致
- timed 计时改用**服务器校正时钟**：`NetClient.serverNow()`（每条 S→C 消息 ts 持续校正偏移），HUD 剩余时间/复活/免伤与 `NetGameRunner.now`（冻结窗口）全部改用
- 房主补位/转让：`join` 时 hostSeat 已无人（房主离开仅剩 AI）→ 加入者自动成为房主；`transferHost` 优先在线真人（protocol §7 口径）
- FR-4.3 落地：无空位但有 AI 座位时真人加入可替换 AI（仅 WAITING）
- FINISHED 重连补发缓存的 `game.result`（Room.lastResult）；客户端收到 result → `runner.paused`（停引擎停输入，消除 E4031 Toast 刷屏）
- VICTORY 系统消息补 `nickname` 参数（此前渲染为" 获得胜利！"）
- 开局倒计时本地每秒递减（此前恒显"3"）
- timed 快照 modeState 增加 `pendingGarbage` → 预警条对 timed 生效 + HUD 增加实时排名（按 opponents 分数即时比较）
- 聊天服务端 trim + 空白消息不广播

### P2/P3
- Hold/Next 小窗 HiDPI（`render.hiDpiCanvas` + `drawMini` 逻辑尺寸参数，单人/多人两屏）；Lobby 文案去"M2 sprint"；快照去重 key 增加 timed.pendingGarbage/status

### 测试（shared 83 + client 16 + server 11）
- shared：+6（applySnapshotState status 恢复/落地、Hold 出生一致性 ×2、垃圾溢出顶出/正常回归）
- client：+3（resync 恢复 running、权威 eliminated→finished 观战、hash 一致也同步 status）
- server：+1（timed 宽限超时复活循环全流程）

### 文档同步（本轮）
- protocol.md **v1.5**（变更行 + §5 status/pendingGarbage + §7 timed 宽限/房主转让 + §9 固定窗口措辞）
- technical-design.md v1.1（§2.1 目录 M4 实际状态、§4.3 status 校正、§5.2 store 现状）
- ADR-0004 sprint 参数行措辞；README 协议版本 v1.5
- techContext（用例数）/progress（M5 行、M4.5 条目）修正

## 已确认的关键决策（历史 + 本轮新增）
1-11 同前（见 git 历史 / progress.md）
12. **M4.5**：断线宽限超时三模式口径 = sprint 移出排名（abandoned）/ survival 判淘汰（eliminated）/ timed 计顶出并继续复活循环（座位保留，可迟到 resume）；self 快照带 status，客户端以服务端状态为准（本地预测只影响显示流畅性，不决定生死）；垃圾溢出=顶出；timed 计时显示用服务器校正时钟（offset = msg.ts - Date.now()，逐消息更新）

## 开发顺序约定（重要）
M4.5 修复完成 → M5：AI 机器人（真实 BotController 3 难度落点评估，替换临时 bot）→ Playwright E2E（TC-UI-002~007，本轮再次证明 L3 缺失会让"服务端发了客户端没接"的 P0 漏网）→ M6 打磨

## 下一步（M5：AI 机器人）
1. shared/server：BotController（3 难度落点评估），与真人同一引擎同一输入通道（现临时 bot 每 0.5s 硬降）
2. 验证 timed 下 bot 反复顶出 → topOuts 累计正确
3. Playwright E2E（TC-UI-002~007）

## 待定项 / 风险提醒
- 硬降保留 T-Spin（`hardDrop` 中仅 d>0 清 `lastActionRotation`）：**代码现状 = 原地硬降保留 T-Spin**，activeContext 旧记录"硬降取消 T-Spin"已过期（本轮核实并在此勘误）；仍建议 M6 手感评审定夺
- 集成测试对 tick 时序敏感：机器高负载时 tick 落后墙钟（onTimer steps>10 钳制为 1），断言用轮询 + `fileParallelism: false`
- Dockerfile 未经实际 build 验证；PowerShell 5.1 写文件必须 `[System.IO.File]::ReadAllText/WriteAllText`（UTF-8 无 BOM）
- 已推送 GitHub：**github.com/qonies/BearBricks**；后续改动直接 `git commit` + `git push`（PS 5.1 对 git 中文参数用 `-F 消息文件`，消息文件放 TEMP）

