# 当前工作上下文（Active Context）

## 当前阶段
**M4 timed 限时赛完成**（2026-10-22：协议升 v1.4 + TimedStrategy/computeTimedRanking/引擎 respawn + Room 复活/免伤/计时归零 + 客户端 HUD；用例 shared 77 + client 13 + server 10 全绿）

## 本轮产出（2026-10-22，M4 timed 限时赛）
### shared
- `modes/timed.ts`：`computeTimedRanking`（总分降序 → 消行降序 → 顶出次数升序；完全同值并列；abandoned 移出排名）
- `modes/strategy.ts`：`TimedStrategy`（攻击 = calcAttack 与 survival 同表；onTopOut = RESPAWN；engineMode = marathon）；工厂注册（原 throw 移除）
- 引擎 `TetrisGame.respawn()`：棋盘清空、score/lines/level/hold 保留、combo/b2b 清零、status 恢复 running、bag 序列延续（双端各自调用保持一致）
- 常量：`TIMED_IMMUNE_MS=3000`、`TIMED_TIME_LIMITS=[120,180,300]`、`TIMED_DEFAULT_TIME_LIMIT=180`
- 协议 v1.4：`modeState.timed {endsAt, respawnAt?, immuneUntil?}`（服务器 epoch ms）；`game.start` 增 `timeLimit`；`room.updateSettings` 放行 timed（timeLimit 字面量联合校验）；`RankingEntry` 增可选 `score`

### server（room.ts）
- `updateSettings` 放行 timed：timeLimit 校验（schema 字面量联合 + Room 兜底），未传时切模式默认 180；非 timed 带 timeLimit → E4031
- 顶出处置 `markSeatGameEnded` timed 分支：topOuts+1、respawnUntilTick = tick+180、immuneUntilTick = +360、pendingGarbage/garbageDueTick 清空、`game.respawn()`、广播 `game.topOut RESPAWN` + `chat.system RESPAWN`
- tickStep：座位循环中先清理过期 immuneUntilTick，再处理 respawnUntilTick（倒计时中 continue = 棋盘/输入/垃圾全冻结，到点复位）
- `attackTargets()`：timed 再排除复活倒计时/免伤窗座位（survival 用原 aliveSeats）
- `insertDueGarbage` guard 改为仅 sprint 跳过（timed 复用攻击/垃圾链路）
- 计时归零：`tick*STEP_MS >= timeLimit*1000 → finishGame('timeout')`；宽限超时 timed 计顶出后 abandoned；`finishGame` timed 排名分支（abandoned 移出、score 下发）
- `selfModeState` timed 分支（loopStart+tick 换算 epoch ms）；self 快照变化 key 增 timed.respawnAt/immuneUntil

### client
- `netGame.ts`：`syncTimed()`（快照 modeState.timed 驱动：respawnAt 出现 = 清空 inputLog + `game.respawn()` + 冻结输入至 respawnAt；消失 = 解冻）；frame loop 与 dispatch 均受 frozen() 约束
- `GameViewMP`：timed HUD（剩余时间 formatClock、最后 10s 变红、得分/消行/等级）、复活倒计时横幅、🛡 免伤横幅、标题"限时赛"；结算屏 timed 显示"分数 · 行数"
- `RoomView`：timed 选项启用 + 120/180/300 秒选择器 + 房间信息标签

### 测试（shared 77 + client 13 + server 10）
- shared `timed.test.ts` 9 用例：策略/排名三键排序/并列/abandoned/引擎 respawn/modeState.timed schema
- server `timed.integration.test.ts` 2 用例：全流程（timeLimit 校验 E4001→默认 180→改 120→攻击→顶出 RESPAWN→冻结期输入丢弃→免伤期内不被攻击→归零结算排名→rematch 无残留）+ abandoned 移出排名；tick 推进用 `room.settings.timeLimit = 1` 测试钩子触发归零
- 修正 survival 测试：timed 拒绝断言 → timed 接受（默认 180）
- **server vitest.config.ts（新）**：`fileParallelism: false`（三个集成测试各带 60Hz loop，并行争用 CPU 使权威 tick 落后墙钟、以 tick 计时的断言不稳）
- 测试等待一律轮询（waitUntil）而非固定 sleep

## 已确认的关键决策（历史 + 本轮新增）
1-10 同前（见 git 历史 / progress.md）
11. **M4**：timed 引擎语义 marathon，顶出后 Room 立即 `respawn()`（棋盘清空）但冻结至 respawnUntilTick（3s 倒计时），免伤 = respawnUntilTick+180；免伤/倒计时内不作攻击目标、输入静默丢弃（客户端清 inputLog 防重放污染）；快照不含 status，客户端复活靠 modeState.timed.respawnAt 驱动本地 `respawn()`；endsAt = loopStart + timeLimit*1000（epoch ms，客户端直接与本地时钟比较）；timed 排名 abandoned 移出（与 sprint 口径一致）；宽限超时 timed 计顶出

## 开发顺序约定（重要）
M4 完成 → AI + 聊天完善（M5：真实 AI 落点评估，聊天 UI 已落地）→ 打磨（M6）

## 下一步（M5：AI 机器人）
1. shared/server：BotController（3 难度落点评估），与真人同一引擎同一输入通道（现临时 bot 每 0.5s 硬降）
2. 验证 timed 下 bot 反复顶出 → topOuts 累计正确
3. Playwright E2E（TC-UI-002~007）

## 待定项 / 风险提醒
- 硬降取消 T-Spin（`hardDrop` 中 `lastActionRotation = false`）：遵循需求 §4.2 字面口径，建议 M6 手感评审定夺
- 集成测试对 tick 时序敏感：机器高负载时 tick 落后墙钟（onTimer steps>10 钳制为 1），断言用轮询 + `fileParallelism: false`
- Dockerfile 未经实际 build 验证；PowerShell 5.1 写文件必须 `[System.IO.File]::ReadAllText/WriteAllText`（UTF-8 无 BOM）
- 已推送 GitHub：**github.com/qonies/BearBricks**；后续改动直接 `git commit` + `git push`（PS 5.1 对 git 中文参数用 `-F 消息文件`）

