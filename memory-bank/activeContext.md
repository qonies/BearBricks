# 当前工作上下文（Active Context）

## 当前阶段
**M5 AI 机器人完成**（2026-10-23：shared `ai/bot.ts` BotController 三难度落点评估，替换 M2 临时 bot；server 接入同一 applyInput 通道；shared 92 + client 16 + server 13 全绿；typecheck/lint/build 通过）

## 本轮产出（2026-10-23，M5）

### shared：`src/ai/bot.ts`（新增，index.ts 导出；纯 TS 零依赖）
- `BOT_DIFFICULTY_PARAMS`：EASY 300ms 思考/15% 误操作、NORMAL 150ms/5%、HARD 60ms/0%（技术设计 §6）
- 落点评估：`enumeratePlacements`（旋转×列全枚举，出生位碰撞剪枝、同形态同列去重）+ `evaluateBoard`（聚合高度/空洞/凹凸度/累计井深）；cost = 0.510066·聚合 + 0.35663·空洞 + 0.184483·凹凸 + 0.1·井深 − 0.760666·消行（经典调优权重，12 seed×4000 tick 实测 HARD 149 行 / NORMAL 94 / EASY 27，EASY 顶出 8/12、HARD 0）
- 攻击模式（survival/timed）：4 消额外 −0.8 代价（替代"高度低于均值优先攻击"的复杂判定）
- `BotController.decide(game)`：每权威 tick 调用一次，返回 ≤1 个 GameAction（新块身份检测 → 思考延迟 → Hold 权衡[margin 0.3] → 误操作扰动 → 旋转→平移→硬降）；卡住 3 tick（踢墙失败/垃圾堵路）兜底硬降，永不挂死；误操作 RNG 由 `${seed}:bot` 派生（独立于 bag/garbage RNG，同 seed 可复现）
- `simulateBotGame`：无头对局模拟（TC-BOT-001 批量回归/调参用）；调参脚本 `scripts/bot-tune.ts`

### server：`room/room.ts` 接入
- Seat 用 `bot: BotController | null` 替换临时 bot 字段（lastBotPiece/botPieceTicks 删除）；beginGame 按 difficulty+seed 创建（attackMode = mode !== 'sprint'），rematch 清空
- `botTick`：decide → `game.applyInput(action)`（与真人同一输入通道）→ finished 时 markSeatGameEnded

### 测试（+9 shared / +2 server）
- shared `bot.test.ts` 9 用例：难度参数、候选枚举升序、堆到顶空数组、空洞/井深特征、填洞消行、Hold 换块、timed 顶出→respawn→继续对局（topOuts 场景验证）、确定性、TC-BOT-001 批量回归（HARD>EASY×2 且顶出率更低）
- server `bot.integration.test.ts` 2 用例：TC-BOT-002（WAITING 移除 AI 座位立即空出）+ TC-BOT-001 服务端路径（HARD bot 经同一 GameLoop 落子推进 + 对手快照下发）

### 文档同步
- README AI 行 → ✅ 已上线；technical-design §6 补 M5 实现注记（权重/执行模型/RNG 派生）；test-plan 补 TC-BOT 实现状态说明

## 已确认的关键决策（历史 + 本轮新增）
1-12 同前（见 git 历史 / progress.md）
13. **M5 BotController**：AI 不直接改棋盘，每 tick `decide()` 产出 ≤1 动作由 Room 经 `game.applyInput` 执行（FR-4.2 同一输入通道）；评估 = 单层全落点枚举 + 启发式（无前瞻搜索，性能足够）；Hold 权衡按 cost margin 0.3；卡住兜底硬降；难度差异 = 思考延迟 + 误操作率（误操作 RNG 从对局 seed 派生保证可复现/可重放）

## 开发顺序约定（重要）
M5 完成 → 剩余：Playwright E2E（TC-UI-002~007，需先安装浏览器；M4.5 的 P0 缺陷正是 L3 缺失漏网的实例）→ M6 打磨（设置/音效/可访问性/压测/Docker 部署）

## 下一步
1. Playwright E2E（TC-UI-002~007）
2. M6 打磨（含硬降 T-Spin 口径评审：代码现状 = 原地硬降保留 T-Spin）

## 待定项 / 风险提醒
- 硬降保留 T-Spin（`hardDrop` 中仅 d>0 清 `lastActionRotation`）：**代码现状 = 原地硬降保留 T-Spin**，仍建议 M6 手感评审定夺
- 集成测试对 tick 时序敏感：机器高负载时 tick 落后墙钟（onTimer steps>10 钳制为 1），断言用轮询 + `fileParallelism: false`
- bot 单元测试中 HARD 思考延迟 = 首调建计划 + 4 tick 递减（共 5 次 null 后才出动作）；批量回归用 maxTicks=4000（区分度最佳且 ~6.5s 可接受）
- Dockerfile 未经实际 build 验证；PowerShell 5.1 写文件必须 `[System.IO.File]::ReadAllText/WriteAllText`（UTF-8 无 BOM）
- 已推送 GitHub：**github.com/qonies/BearBricks**；后续改动直接 `git commit` + `git push`（PS 5.1 对 git 中文参数用 `-F 消息文件`，消息文件放 TEMP）
