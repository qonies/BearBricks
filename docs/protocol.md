# BearBricks WebSocket 通信协议

| 项 | 内容 |
|---|---|
| 版本 | v1.5 |
| 日期 | 2026-10-22 |
| 关联 | `technical-design.md` §4、`requirements.md`、实现 `packages/shared/src/protocol/` |
| v1.1 变更 | 补 seed 下发、soft 持续态、inputBatch、game.state.full/seq 基线、rematch、addBot difficulty、error/ping 结构、坐标方向约定、房间码爆破限流、resumeToken 轮换 |
| v1.2 变更 | M3 survival：新增 `game.attack`；`modeState.survival {aliveCount, pendingGarbage}`；对手快照 `status` 增加 `eliminated`、可选 `pendingGarbage` |
| v1.3 变更 | `RankingEntry.status` 增加 `eliminated`（survival 淘汰不再混用 `finished`）；`game.topOut` 明确 sprint 顶出由引擎内部清盘处置、不下发本事件；新增每连接入站消息限流（>120 条/s 断开） |
| v1.4 变更 | M4 timed：`modeState.timed {endsAt, respawnAt?, immuneUntil?}`；`game.start` 增加 `timeLimit`；`room.updateSettings` 放行 `timed`（`timeLimit` ∈ 120/180/300）；`RankingEntry` 增加可选 `score`（timed 排名展示） |
| v1.5 变更 | M4.5 修复：`game.snapshot.self` / `game.state.full.self` 增加可选 `status`（座位对局状态，驱动观战/终局显示与本地预测卡死校正）；`modeState.timed` 增加可选 `pendingGarbage`（timed 攻击预警，与 survival 同口径）；timed 断线宽限超时明确为"计一次顶出并继续复活循环"（座位与 resumeToken 保留）；房主转让优先在线真人；入站消息限流为固定 1s 窗口；`chat.system VICTORY` params 增加 `nickname` |

## 1. 通用约定
- 通道：单一 WebSocket 连接 `wss(s)://<host>/ws`，全双工，可靠有序（TCP）
- 编码：UTF-8 JSON 文本帧；信封结构：
  ```json
  { "t": "game.input", "ts": 1730000000000, "d": { "seq": 42, "action": "moveL" } }
  ```
  - `t`：消息类型（≤32 字符，必须是普通对象的自身属性名，非法信封/原型链键按 E4001/E4031 计数）
  - `ts`：发送方毫秒时间戳；`d`：载荷（输入类的 `seq` 在 `d` 内，见 §4）
- 服务端 → 客户端消息均带 `sseq`（每个连接的下行自增序号，客户端不回传）
- **坐标约定（重要）**：`board` 字符串与 `active.y` 均为数组 **top-down**（index 0 = 顶部隐藏行，21 = 底行）；可见区为 index 2~21
- **快照棋盘编码**：22 行 × 10 格 = **220 字符，无分隔符**；`.` 空、`L/J/I/O/S/T/Z` 块色、`G` 垃圾行
- 所有载荷入站经 **Zod 校验**（`shared/protocol/messages.ts`）：
  - 已知类型校验失败 → `error E4001`（累计 10 次断开）
  - **未知消息类型 → `error E4031`**（视为伪造/非法操作，同样计数）
- 单消息上限 **4KB**，超限直接断开

## 2. 握手与身份
```
C→S  hello      { playerId, nickname, resumeToken?, roomCode? }
S→C  welcome    { serverTime, session: { playerId, resumeToken, selfSeatId? }, room?: RoomState }
```
- `playerId`：客户端生成的 UUID，持久于 localStorage，**仅用于握手，不在 RoomState 中广播**（防同房间成员伪造 hello 顶号）；客户端以 `session.selfSeatId` 与 `room.state` 载荷中的 `selfSeatId` 定位自己
- 同 playerId 旧连接被顶号下线（回 E4010）；**resume 优先**：携带合法 resumeToken 的 hello 直接接管座位（旧连接在线也强制接管），失败才按新会话顶号
- `resumeToken`：服务器签发（`rt_` + 32 位随机 hex）；**每次成功 resume 后轮换**；宽限超时判放弃后作废；匹配失败按新会话处理
- `hello.roomCode` 可直接携带，省一次往返（失败回 E4040/E4090）
- 昵称 ≤12 字符；同房间重复昵称服务端自动加 `-n` 后缀

## 3. 大厅与房间消息
| 方向 | 类型 | 载荷 `d` | 说明 |
|---|---|---|---|
| C→S | `room.create` | `{ visibility: 'public'\|'private' }` | 返回 `room.state`（含 roomCode）；限 3 个/10min/IP |
| C→S | `room.join` | `{ roomCode }` | 不存在 E4040；满员/已开局 E4090；失败计 IP 爆破计数 |
| C→S | `room.quickMatch` | `{}` | 优先公开 WAITING 房，否则自动建公开房 |
| C→S | `room.leave` | `{}` | PLAYING 中离开视为放弃（sprint：移出排名） |
| C→S | `room.updateSettings` | `{ mode, targetLines?, timeLimit? }` | 仅房主、仅 WAITING；survival 可选；**v1.4** timed 可选（`timeLimit` ∈ 120/180/300，默认 180；非法值 E4001，非 timed 携带 `timeLimit` E4031） |
| C→S | `room.addBot` | `{ seatId, difficulty: 'EASY'\|'NORMAL'\|'HARD' }` | 仅房主、仅 WAITING、目标座位为空 |
| C→S | `room.removeSeat` | `{ seatId }` | 仅房主、仅 WAITING；被移除真人收 `error E4030 (reason='kicked')` 并回大厅 |
| C→S | `game.ready` | `{ ready: boolean }` | 玩家准备 |
| C→S | `game.start` | `{}` | 仅房主；需 ≥2 占用座位且所有真人已 ready（房主默认已准备），否则 E4031 |
| C→S | `room.rematch` | `{}` | 仅房主、仅 FINISHED；→ WAITING（设置保留、AI 保留、ready 重置） |
| S→C | `room.state` | `{ room: RoomState }` | 任何变更后广播 |
| S→C | `room.countdown` | `{ seconds: 3, startAt }` | 开局倒计时（startAt 为服务器毫秒时间戳） |
| S→C | `game.start` | `{ mode, targetLines, timeLimit?, seeds: { [seatId]: seed }, startTs }` | **开局下发各座位方块 seed**（对手板本就可见，无窥探增益）；**v1.4** timed 携带 `timeLimit`（秒） |
| S→C | `game.result` | `{ mode, reason: 'finished'\|'timeout', ranking: RankingEntry[] }` | 结束时一次 |

`RoomState`（`room.state` 载荷为 `{ room: RoomState, selfSeatId: number }`，`selfSeatId` 为接收者自身座位号）：
```json
{
  "roomCode": "K7XQ2F", "visibility": "public", "phase": "WAITING",
  "hostSeat": 0, "settings": { "mode": "sprint", "targetLines": 40 },
  "seats": [
    { "seatId": 0, "kind": "human", "nickname": "Alice", "ready": true, "online": true },
    { "seatId": 1, "kind": "bot", "nickname": "Bot-EASY", "difficulty": "EASY" },
    { "seatId": 2, "kind": "empty" },
    { "seatId": 3, "kind": "empty" }
  ]
}
```
`RankingEntry`：`{ seatId, nickname, rank, timeMs: number|null, lines, score?, status: 'finished'|'timeout'|'eliminated'|'abandoned' }`（**v1.3**：`eliminated` = survival 淘汰；**v1.4**：可选 `score` = timed 总分）；sprint 排名：完赛时间升序 → 已清行数降序 → 放弃者移出排名；survival 排名：存活者并列第 1 → 淘汰顺序倒序（同刻并列），abandoned（宽限超时判淘汰）垫底并列，timeMs = 淘汰时刻/存活者 null；**v1.4 timed 排名：总分降序 → 消行数降序 → 顶出次数升序，完全并列，abandoned 移出排名，timeMs 恒为 null**。

## 4. 游戏内消息
| 方向 | 类型 | 载荷 | 说明 |
|---|---|---|---|
| C→S | `game.input` | `{ seq, action }`，action ∈ `moveL\|moveR\|rotCW\|rotCCW\|soft\|hard\|hold` | 带 `seq`；服务器按 seq 序在 tick 边界应用；≤60 action/s，超限丢弃 + E4290 |
| C→S | `game.inputBatch` | `{ actions: [{ seq, action }] (≤32) }` | 网络合并优化（可选） |
| C→S | `game.soft` | `{ on: boolean }` | **软降持续态**（keydown/keyup），服务端每 tick 应用 |
| S→C | `game.snapshot.self` | 见 §5 | 20Hz + 变化才发（`h` 指纹） |
| S→C | `game.snapshot.others` | `{ tick, seats: [{seatId, board, active, score, lines, status}] }` | 10Hz，变化才发；省略 queue/hold（防窥探） |
| S→C | `game.state.full` | `{ seatId, tick, seq, seed, self, room }` | 重连恢复（PLAYING 中宽限内 resume 时下发，welcome 之后） |
| S→C | `game.topOut` | `{ seatId, action: 'ELIMINATE'\|'RESPAWN'\|'RESET_BOARD' }` | 顶出处置事件：survival = ELIMINATE；**v1.4 timed = RESPAWN**（顶出即播报，随后该座位 modeState.timed.respawnAt 出现 3s 复活倒计时、immuneUntil 免伤 3s；复活期间输入被静默丢弃）；**sprint 顶出由引擎内部清盘处置，不下发本事件**（v1.3 明确） |
| S→C | `game.attack` | `{ fromSeat, lines, targets: seatId[] }` | **v1.2** 一次消行攻击（offset 后实际转发行数），全房间广播用于攻击指示；lines ≥1，targets 为其他存活对手 |
| S→C | `error` | `{ code, message, reason? }` | 错误码见 §8 |

**seq 语义**：客户端从 1 起单调递增，**重连后不重置**；`game.snapshot.self.seq` / `game.state.full.seq` 为服务器已应用的最大 seq，客户端据此重放未确认输入。

## 5. 快照格式
`game.snapshot.self`：
```json
{
  "tick": 3512, "seq": 42, "h": "…stateHash",
  "board": "220 字符 top-down",
  "active": { "type": "T", "x": 4, "y": 19, "rot": 1 },
  "queue": ["L", "S", "Z", "I", "O", "…（最多 8）"],
  "hold": "S", "canHold": false,
  "score": 12400, "lines": 23, "level": 3, "combo": 2, "b2b": true,
  "elapsedMs": 58633,
  "modeState": { "sprint": { "target": 40 } }
}
```
- `h`：状态指纹（棋盘 + active + 分数/行数/等级/连击/B2B/Hold），双端同一函数（`TetrisGame.stateHash()`）计算；不一致 → 客户端 `applySnapshotState` 重建 + 重放未确认输入
- **`status`（v1.5，可选）**：座位对局状态 `playing/finished/eliminated/abandoned`，与对手快照同口径；客户端用于观战/终局显示，并把权威 `playing` 映射回引擎 `running`（修复本地预测顶出后无法从快照恢复的卡死）
- 对手快照省略 `queue/hold`；`status` ∈ `playing/finished/eliminated/abandoned`（**v1.2**：`eliminated` = survival 淘汰转观战）；**v1.2** 可选 `pendingGarbage`（该对手待接收垃圾行数，攻击预警可视化）
- `modeState`：sprint `{target}`；**v1.2** survival `{aliveCount, pendingGarbage}`（pendingGarbage 为己方待接收垃圾行，红色预警条数据源）；**v1.4** timed `{endsAt, respawnAt?, immuneUntil?}`（均为服务器 epoch ms：endsAt 计时归零时刻；respawnAt 复活倒计时截止，仅复活中的座位携带；immuneUntil 免伤截止，复活后 3s）；**v1.5** timed 增加可选 `pendingGarbage`（>0 时携带）

## 6. 聊天协议
| 方向 | 类型 | 载荷 | 说明 |
|---|---|---|---|
| C→S | `chat.send` | `{ text: string(≤200) }` | 限流：1 条/s 且 10 条/10s，超出 E4290 |
| S→C | `chat.message` | `{ seatId, nickname, text, ts }` | 广播全房间 |
| S→C | `chat.system` | `{ code: 'JOIN'\|'LEAVE'\|'KICKED'\|'TOP_OUT'\|'RESPAWN'\|'VICTORY'\|'START', params }` | 系统消息，客户端按 i18n key 渲染 |

服务端清洗：去除控制字符（U+0000~001F、U+007F）、截断 200 字符；客户端以 React 文本节点渲染（天然防 XSS），禁止 `dangerouslySetInnerHTML`。

## 7. 心跳、断线与重连
- 心跳：服务器 15s 一次 `ping {id}`，客户端回 `pong {id}`；**连续 2 次未响应（30s）判定断线**
- 断线宽限：**30s** 内携带 resumeToken 重连 → 恢复座位与棋局（PLAYING 中下发 `game.state.full`）
  - PLAYING 中宽限期的座位：棋盘冻结、不收发数据；宽限超时按模式处置（FR-10.3）：survival → 判淘汰（转观战）；**timed → 计一次顶出并继续复活循环（v1.5 明确：座位与 resumeToken 保留，迟到的 resume 仍可恢复）**；**sprint → 移出排名**（status='abandoned'，resumeToken 作废）
  - 非 PLAYING 阶段宽限超时 → 直接释放座位
- 主动离开（`room.leave`）：立即释放座位（PLAYING 中视为放弃）
- 房主断线：宽限内保留；超时 → 转让给最早加入的**在线**真人（全部离线时退而求其次给宽限中的真人；无其他真人时空位加入者自动补位为房主）
- 房间回收：WAITING 空房 / FINISHED 后 10 分钟 → 销毁（5s 扫描周期）

## 8. 错误码
| 码 | 含义 | 客户端处理 |
|---|---|---|
| E4001 | 已知消息类型校验失败 / 超限 | 忽略 + 控制台告警 |
| E4010 | 身份无效 / 顶号 | 重置本地身份重新 hello |
| E4030 | 权限不足（非房主等）/ 被踢（reason='kicked'） | Toast 提示 |
| E4031 | 操作与当前状态不符 / 未知消息类型 | 忽略 |
| E4040 | 房间不存在 | 回大厅 |
| E4090 | 房间已满 / 已开局 / 房间被回收解散 | 提示后回大厅 |
| E4290 | 限流（聊天/输入/建房/爆破） | 提示 + 静默丢弃 |
| E5000 | 服务器内部错误 | 提示重试 |
| E4999 | 服务器即将关闭 | 展示维护公告 |

## 9. 限流与安全基线
- 每 IP：并发连接 ≤5、房间创建 ≤3/10min（`ROOM_CREATE_LIMIT` 可覆盖）、**加入失败（房间码爆破）>10 次/10min → E4290**
- **每连接入站消息 ≤120 条/s（v1.3）**：固定 1s 窗口计数（窗口起点对齐首条消息，v1.5 修正"滑动窗口"措辞），超限直接断开（在应用层解析之前生效，防 JSON.parse CPU DoS）
- 每 IP 并发与限流以 TCP 对端地址为准；部署在可信反代后设 `TRUST_PROXY=1` 才采用 `x-forwarded-for`（防伪造绕过）。**注意：办公室/家庭局域网多玩家共享同一出口 IP 时，上述每 IP 配额为全体共享**（部署文档 §9/technical-design）
- 每连接：校验失败 ≤10（非法信封/未知类型/校验失败均计数）；聊天限流见 §6；输入 ≤60 action/s
- WS 层 `maxPayload=4096` 字节：超限帧直接关闭连接（配合应用层 4KB 检查）
- Origin 校验：仅允许配置的部署域名（开发放行 localhost/127.0.0.1、私有网段 10/192.168/172.16-31 与无 Origin 的非浏览器客户端）
- 单消息上限 4KB，超限直接断开
- resumeToken 每次成功 resume 轮换，旧 token 即刻失效；宽限超时判放弃后作废
