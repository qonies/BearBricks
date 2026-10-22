# 当前工作上下文（Active Context）

## 当前阶段
**M3.5 全量代码审查修复完成**（2026-10-22：27 项问题修复 + 协议升 v1.3 + 聊天 UI/i18n 骨架落地；用例 shared 68 + client 13 + server 8；规则/重连/限流回归测试已补）

## 本轮产出（2026-10-22，M3.5 全量审查修复）
### 规则正确性（server + shared）
- survival 不再被 Room 层 300s 强制结算：`tickStep` 的 SPRINT_TIMEOUT 判定限定 `mode === 'sprint'`（requirements §4.4 survival 无超时）
- survival 结束判定拆分：`survivalAliveSeats()`（结束判定/HUD aliveCount，**含宽限内离线真人**）vs `aliveSeats()`（攻击目标，再排除离线 = FR-10.2 不收发攻击）——修复"断线瞬间提前终局 + 掉线者并列第 1"漏洞
- 垃圾行：新增 `TetrisGame.receiveGarbage(rows, holeCol)`（棋盘上移 + **active 随动上移** + 无条件顶出校验）；`Room.insertDueGarbage` 改走该入口（修复方块被埋进垃圾行不结算）
- `resumeSeat` 复位 `softDrop`/清空 `pendingInputs`（修复重连后棋盘自己下冲）
- `handleInput`/`handleSoft` 增加 `phase === 'PLAYING'` 守卫（FINISHED 后输入回 E4031，不再无限堆积 pendingInputs）
- `transferHost` 不再转让给 AI（无其他真人时保持原值，空位加入者自动成为房主）；VICTORY 平局逐人播报；昵称去重后缀 ≤12 字符

### 协议 v1.3（shared/protocol）
- `RankingEntry.status` 增加 `eliminated`（survival 淘汰单列）；`finishGame` survival 分支按 abandoned/eliminated/finished 映射
- `game.topOut` 口径明确：sprint 顶出由引擎内部清盘处置、不下发该事件（sprint = RESET_BOARD 的旧表述删除）
- 新增**每连接入站消息限流 120 条/s**（Session 滑动 1s 窗口，先于解析计数，超限直接断开）

### 客户端
- **修复"建房/加入后停留大厅"缺陷**：`room.state` 处理器在 lobby 屏时导航到房间屏（对局屏不受影响）
- resume 失败/服务器重启（welcome 无 room 且本地有 room）→ 清 store 回大厅（不再卡死对局画面）
- 重连横幅：`net.onStatus` 接入 App，reconnecting 时顶部提示（FR-10.1）
- **聊天 UI 落地（FR-9）**：`ChatPanel.tsx`（用户+系统消息、Enter 发送/Esc 退出、可折叠）+ `store.chatLog`（100 条上限、房间码变化清空）+ `i18n.ts` 骨架（`formatSystemMessage`，chat.system 七种 code 中文模板）；聊天框聚焦时游戏键让路（FR-9.4）
- `game.attack` 攻击闪烁提示（指向自己的攻击 2.5s 提示）；结算屏 abandoned 显示"放弃"
- 改昵称 `commitNickname` → `net.rehandshake()` 重建握手（新昵称生效）；大厅重复 Toast 移除
- `netClient`：onclose 仅在 `this.ws === ws` 时清引用（防旧 socket 迟到 close 吞掉新连接）；新增 `rehandshake()`

### 服务端健壮性
- `index.ts`：uncaughtException/unhandledRejection 以**非零码**退出（NFR-4）
- `config.allowOrigin`：dev 放行私有网段（10/192.168/172.16-31/.local），生产仍只认 `ORIGIN`
- `app.ts` 静态托管：path 归一化 + 目录前缀判定（防兄弟目录碰撞）+ 指纹资源 immutable 缓存/index.html no-cache + statSync try/catch
- `session.ts`：心跳改为"发 ping 后判 `pingId - lastPongId >= 2`"（稳态 ≈30s 无 pong 判线）；`missedCount` 移除
- 删除死代码 `RoomManager.destroyRoom`

### 文档
- protocol.md v1.3；README（M3 状态/聊天/NAT 注意/缓存）；technical-design §2.1（M3 目录）§2.3（实际策略接口）；ADR-0005（接口修订记录）；test-plan（M3 集成测试）；techContext（**Node v24.13.0 / npm 11.12.1 实测；仓库根未 `git init`**）；room/GameViewMP/garbage/board/srs 过时注释清理

### 测试（shared 68 + client 13 + server 8）
- shared +2：receiveGarbage 随动上移保持相对位置 / finished 后 no-op
- server +3：宽限期内断线不提前终局 + resume 后 softDrop/pendingInputs 复位（新 it）；FINISHED 后 winner 输入 E4031（主流程断言）；入站限流 200 帧 → 断开且服务器存活；TestClient 统一回应心跳 ping
- client +1（`chat.test.ts`）：formatSystemMessage 模板/回退 + chatLog 追加截断/清空/跨房间清理

## 已确认的关键决策（历史 + 本轮新增）
1. 坐标：引擎与协议统一 **top-down**（index 0 = 顶部隐藏行）
2. Combo：`50×(n−1)×等级`；T-Spin 计分全部 ×等级；Mini Double 几何不可达计 0 分
3. ARR=0：瞬间到墙 + 撞墙闩锁（新块 2 帧内重新到墙）
4. **playerId 不下发**：客户端以 welcome/room.state 的 `selfSeatId` 定位自己
5. resume 优先于顶号；宽限超时 abandoned 座位不可再 resume；**resume 复位 softDrop/未消费输入**
6. 快照编码 220 字符无分隔符；seed 经 `game.start` 广播
7. seq 重连后不重置（`game.state.full.seq` 为基线）
8. 限流/部署配置走环境变量（`ROOM_CREATE_LIMIT`/`TRUST_PROXY`/`CLIENT_DIST`）
9. **M3**：survival 引擎用 marathon 语义；垃圾洞列 Rng 与 bag Rng 分离；客户端不预测垃圾行；abandoned 排名垫底并列
10. **M3.5**：survival 无 Room 层超时；存活两口径拆分（结束判定含宽限离线者 / 攻击目标不含）；垃圾行走 `receiveGarbage`（active 随动）；sprint `game.topOut(RESET_BOARD)` 不下发（引擎内部处置）；入站限流 120 msg/s 超限断开；`RankingEntry.status` 增 eliminated；硬降仍取消 T-Spin（遵循需求 §4.2 字面口径，如需对齐主流手感需单独决策）

## 开发顺序约定（重要）
timed（M4 复活）→ AI + 聊天完善（M5：聊天 UI 已落地，剩余真实 AI）→ 打磨（M6）

## 下一步（M4：timed 限时赛）
1. shared：TimedStrategy（RESPAWN/免伤钩子、computeTimedRanking：总分→消行→顶出次数）+ `modeState.timed{endsAt, respawnAt?}`
2. server：计时归零结束（按 tick）、顶出 → RESPAWN（3s 后清盘+免伤窗）、topOuts 计数（`tickStep` 的超时判定需继续排除 timed，由策略 `endsAt` 接管）
3. client：timed HUD（剩余时间/复活倒计时）、免伤视觉提示
4. `updateSettings` 放行 timed（timeLimit 参数校验 120/180/300s，默认 180s）

## 待定项 / 风险提醒
- **硬降取消 T-Spin**（`hardDrop` 中 `lastActionRotation = false`）：遵循需求 §4.2 字面口径，但主流手感（tetr.io/Jstris）硬降不清 T-Spin 标记——玩家最常用的"旋转入槽+硬降"将不计 T-Spin，建议 M6 手感评审时定夺
- 临时 bot 每块 0.5s 硬降，survival 中会自然堆积消行产生攻击（真人 vs bot 可玩但强度低）——M5 真实 AI 解决
- Dockerfile 未经实际 build 验证（本机无 Docker）；`npm ci` 在仓库中尚未跑过（本轮验证需先安装依赖）
- PowerShell 5.1 文本替换必须用 `[System.IO.File]::ReadAllText/WriteAllText`（UTF-8 无 BOM）；`Get-Content | Set-Content -Encoding UTF8` 会把中文按 ANSI 误读（历史踩坑）
- PowerShell 5.1 会话 `$env:PORT` 会跨命令残留，烟测前记得 `Remove-Item Env:PORT`
- 已推送 GitHub：github.com/qonies/bearbricks（私有，main = origin/main，首提交 4c98c04）；后续改动直接 `git commit` + `git push`（注意 PS 5.1 对 git 中文参数用 `-F 消息文件` 传递）

