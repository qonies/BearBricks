# BearBricks 测试文档（Test Plan）

| 项 | 内容 |
|---|---|
| 版本 | v1.0 |
| 日期 | 2026-10-22 |
| 关联 | `requirements.md`（FR/NFR）、`technical-design.md`、`protocol.md` |
| 工具链 | Vitest（单元/集成）、Playwright（E2E）、自研 ws 压测脚本 |

## 1. 目的与范围
验证 BearBricks 满足 `requirements.md` 中全部 FR/NFR：三模式规则正确、联机稳定公平、聊天安全、性能达标。范围覆盖 shared 引擎、server 房间与网络、client UI 与交互；不含浏览器内核兼容性穷举（按目标浏览器矩阵抽样）。

## 2. 测试策略（金字塔）
| 层级 | 工具 | 对象 | 覆盖率目标 |
|---|---|---|---|
| L1 单元 | Vitest | `shared/*` 全部、server 纯函数 | shared ≥ 85%，SRS/攻击表 100% 分支 |
| L2 集成 | Vitest（Node 环境，真实 ws 端口） | RoomManager/Room/GameLoop/ChatHub/重连 | 关键路径全覆盖 |
| L3 E2E | Playwright | 多 browser context 模拟 1-4 玩家全流程 | 主流程 + 异常流 |
| L4 专项 | 压测脚本 / 手工矩阵 | 性能、网络异常、安全、兼容性 | 按基线表判定 |

**测试环境约定**：所有集成/E2E 测试使用随机高位端口；`afterAll` 钩子必须关闭 server 与浏览器实例——**每轮测试后退出后台程序、不占用端口**（项目规则）。

## 3. 用例编号与优先级
- 编号：`TC-<模块>-<序号>`；模块：ENG（引擎）、MD-A/B/C（三模式）、MD-X（跨模式）、NET（网络）、ROOM、CHAT、BOT（AI 机器人）、UI、SEC（安全）、PERF、COMPAT、ACC（可访问性）
- 优先级：**P0** 阻断性（不通过不得发版）/ **P1** 重要 / **P2** 一般

## 4. L1 单元用例（Vitest）

### 4.1 ENG 引擎（`packages/shared`）
| 编号 | 用例 | 优先级 | 关联 |
|---|---|---|---|
| TC-ENG-001 | SRS：JLSTZ 四方向 × 各踢墙偏移逐值断言（标准表） | P0 | FR-5 |
| TC-ENG-002 | SRS：I 块专用踢墙表逐值断言 | P0 | FR-5 |
| TC-ENG-003 | 7-bag：连续 70 块每种方块恰 10 次；同 seed 序列完全可复现 | P0 | FR-5 |
| TC-ENG-004 | 碰撞：左右墙/地板/堆叠判定；出生位被占 → Block Out | P0 | FR-5 |
| TC-ENG-005 | 锁定延迟：500ms 锁定；移动重置 ≤15 次后强制锁定 | P0 | FR-5 |
| TC-ENG-006 | 消行：1~4 行消除与上方行下移正确 | P0 | FR-5 |
| TC-ENG-007 | 计分：Single~Tetris × 等级、软/硬降、B2B ×1.5、Combo、PC +3500 | P0 | §4.2 |
| TC-ENG-008 | T-Spin：3 角规则判定；Mini 与普通区分；踢墙后不误判 | P0 | §4.2 |
| TC-ENG-009 | 攻击表全行值断言（含 T-Spin 系列、B2B/Combo/PC 加成） | P0 | §4.3 |
| TC-ENG-010 | 垃圾行：同批次同列洞；offset 1:1 抵消；500ms 缓冲；单批 ≤8 行 | P0 | §4.3 |
| TC-ENG-011 | 重力公式数值断言（level 1/5/10/15/20） | P1 | §4.1 |
| TC-ENG-012 | Hold：每块一次；锁定后 canHold 复位 | P1 | FR-5 |
| TC-ENG-013 | 顶出：Lock Out（完全锁在可见区上方）判定 | P0 | §4.1 |

### 4.2 MD 模式策略（`shared/modes`）
| 编号 | 用例 | 优先级 | 关联 |
|---|---|---|---|
| TC-MD-A-001 | sprint：清满 targetLines → isFinished；排名按完赛时间 | P0 | FR-8 |
| TC-MD-A-002 | sprint：消行不产生攻击（AttackPlan = null） | P0 | FR-8 |
| TC-MD-A-003 | sprint：顶出 → RESET_BOARD，已清行数保留 | P0 | FR-8 |
| TC-MD-A-004 | sprint：300s 超时按已清行数排名；同 tick 完赛并列 | P0 | §4.4 |
| TC-MD-B-001 | survival：Double+ 产生攻击并定向存活对手 | P0 | FR-6 |
| TC-MD-B-002 | survival：仅剩 1 人存活 → 结束，排名 = 淘汰顺序倒序 | P0 | FR-6 |
| TC-MD-B-003 | survival：剩余全员同 tick 顶出 → 并列第 1 | P0 | §4.4 |
| TC-MD-B-004 | survival：淘汰者转观战，不占存活数，仍可聊天 | P1 | FR-6/9 |
| TC-MD-C-001 | timed：endsAt 以服务器 tick 为准；归零结束并排名 | P0 | FR-7 |
| TC-MD-C-002 | timed：顶出 → RESPAWN（3s），分数/消行保留，3s 免伤生效 | P0 | FR-7 |
| TC-MD-C-003 | timed：同分同消行同顶出 → 并列 | P1 | §4.4 |
| TC-MD-X-001 | 跨模式：FINISHED → WAITING 改模式重开，ModeState 无残留 | P0 | FR-2 |

## 5. L2 集成用例（Vitest + 真实 ws，随机高位端口）
> **M2 已落地**：`packages/server/tests/room.integration.test.ts`（TC-ROOM-001/002/005、TC-NET-001/002/003、TC-CHAT-001/002、TC-SEC-001 的自动化覆盖）；
> **M3 已落地**：`packages/server/tests/survival.integration.test.ts`（TC-MD-B-001/002/004、TC-MD-X-001 + 宽限期不提前终局/resume 复位回归）；
> **M4 已落地**：`packages/server/tests/timed.integration.test.ts`（TC-MD-C-001/002 结算/复活/免伤、TC-MD-X-001 timed 分支、timeLimit 校验；排名并列口径在 `packages/shared/tests/timed.test.ts` 单测覆盖）；
> **M4.5 已落地（2026-10-22）**：timed 断线宽限超时"计顶出并继续复活循环"集成用例（timed.integration 第 3 用例，FR-10.3 口径回归）；shared/client 新增 status 校正、Hold 出生一致性、垃圾溢出顶出等用例；
> 协议层单测：`packages/shared/tests/protocol.test.ts`；客户端调度器/校正/聊天单测：`packages/client/tests/`。
> 口径说明：TC-NET-001 的「输入限流」与 TC-SEC-003/008（非法信封/超大帧）已断言；TC-NET-002 的「20Hz/10Hz 频率」属压测口径（TC-PERF-001），集成测试仅覆盖"变化才发"语义。

| 编号 | 用例 | 优先级 | 关联 |
|---|---|---|---|
| TC-ROOM-001 | 创建/加入/离开/满员拒绝（E4090） | P0 | FR-2 |
| TC-ROOM-002 | 房主权限：非房主改设置/踢人 → E4030；PLAYING 中改设置被拒 | P0 | FR-2 |
| TC-ROOM-003 | 房主离开/断线超时 → 自动转让 | P1 | FR-10 |
| TC-ROOM-004 | 补 AI / 真人替换 AI 座位（仅 WAITING） | P1 | FR-4 |
| TC-ROOM-005 | 开局条件：<2 占用座位、或存在未 ready 的真人玩家 → 拒绝（E4031） | P0 | FR-2 |
| TC-ROOM-006 | COUNTDOWN 3s → PLAYING；60Hz tick 推进（时间仿真 1000 tick ≈ 16.7s） | P0 | FR-2 |
| TC-NET-001 | 输入按 seq 有序应用；>60 action/s 丢弃并告警 | P0 | ADR-0002 |
| TC-NET-002 | 快照节流：己方 20Hz / 对手 10Hz，无变化不发送 | P1 | 技设 §4.2 |
| TC-NET-003 | 心跳 30s 无 pong 判断线；宽限 30s 内 resume 恢复座位 + 下发 game.state.full | P0 | FR-10 |
| TC-NET-004 | 宽限超时：survival 判淘汰 / timed 计顶出 / sprint 移出排名 | P0 | FR-10 |
| TC-NET-005 | FINISHED 后 10 分钟回收房间（时间仿真） | P2 | 协议 §9 |
| TC-CHAT-001 | 限流：1 条/s、10 条/10s 超出 E4290 | P0 | FR-9 |
| TC-CHAT-002 | 清洗：200 字符截断、控制字符剔除 | P0 | FR-9 |
| TC-CHAT-003 | 系统消息 JOIN/LEAVE/TOP_OUT/RESPAWN/VICTORY 触发正确 | P1 | FR-9 |
| TC-BOT-001 | AI 输入经同一 GameLoop 路径；固定 seed 100 局 EASY 胜率显著低于 HARD | P1 | FR-4 |
| TC-BOT-002 | AI 移除后立即停帧、不占连接 | P1 | FR-4 |

## 6. L3 E2E 用例（Playwright，多 browser context）
| 编号 | 用例 | 优先级 | 关联 |
|---|---|---|---|
| TC-UI-001 | 首次访问生成昵称可修改；刷新身份不变；清 localStorage 生成新身份 | P0 | FR-1 |
| TC-UI-002 | 单人 Marathon：开局→消行→计分→Esc 暂停生效（重力冻结） | P0 | FR-3 |
| TC-UI-003 | 单人 Sprint 40：完成 40 行出结算，成绩写 localStorage | P0 | FR-3 |
| TC-UI-004 | 建房 → 2 context 加入 → 开局 → 双方互见对手小板 | P0 | FR-2 |
| TC-UI-005 | 4 context sprint 全流程：一方完成 40 行 → 全员收到结算与排名 | P0 | FR-8 |
| TC-UI-006 | 4 context survival：攻击预警条、垃圾行插入、一方淘汰转观战 | P0 | FR-6 |
| TC-UI-007 | 4 context timed：倒计时同步、顶出复活倒计时、结束排名 | P0 | FR-7 |
| TC-UI-008 | 聊天：A 发送 → B/C/D 收到；系统消息样式区分；超长截断 | P0 | FR-9 |
| TC-UI-009 | 断线重连：掐断某 context 网络 → 30s 内恢复 → 座位与棋局还原 | P0 | FR-10 |
| TC-UI-010 | 改键生效并持久化 | P1 | FR-12 |
| TC-UI-011 | 结算「再来一局」→ 全员回 WAITING，模式设置保留 | P1 | FR-2/11 |

## 7. 专项测试

### 7.1 SEC 安全与作弊
| 编号 | 用例 | 优先级 |
|---|---|---|
| TC-SEC-001 | 伪造高分/棋盘类消息（绕过 input）→ E4031，权威状态不变 | P0 |
| TC-SEC-002 | 聊天注入 `<script>` / `<img onerror>` → 纯文本显示，无脚本执行（DOM 断言） | P0 |
| TC-SEC-003 | 4KB / 200KB 载荷 → 拒绝或断开，服务不崩溃 | P0 |
| TC-SEC-004 | 房间码爆破 20 次失败 → IP 限流 | P1 |
| TC-SEC-005 | 非 Origin 的 ws 连接被拒 | P1 |
| TC-SEC-006 | 伪造 resumeToken → 按新会话处理，不越权恢复他人座位 | P0 |
| TC-SEC-007 | 脚本级高频输入 1000/s → 丢弃+告警，他人不受影响 | P1 |
| TC-SEC-008 | 非法信封（JSON `null`/数组）、原型链键（`__proto__`/`toString`）→ E4001/E4031 计数，**进程不退出**（M2.5 回归） | P0 |

### 7.2 NET 网络异常（Playwright route/CDP 或代理注入）
| 编号 | 用例 | 优先级 |
|---|---|---|
| TC-NET-101 | 注入 200ms 延迟：本地手感不受影响，权威校正收敛 < 300ms | P0 |
| TC-NET-102 | 间歇丢包 10%：校正后棋盘一致 | P1 |
| TC-NET-103 | 断网 20s 重连恢复；断网超过 30s 宽限按 FR-10.3 处置（survival 淘汰 / timed 计顶出 / sprint 移出排名），他人对局继续 | P0 |
| TC-NET-104 | 服务器重启：客户端收 E4999/连接关闭 → 回大厅提示 | P1 |

### 7.3 PERF 性能基线（压测脚本模拟 N 客户端）
| 编号 | 指标 | 基线 | 优先级 |
|---|---|---|---|
| TC-PERF-001 | 4 人房间下行带宽 | < 10KB/s/客户端（变化才发通常 < 5KB/s） | P1 |
| TC-PERF-002 | 输入权威收敛 p95（同区域 RTT≤50ms） | < 100ms | P0 |
| TC-PERF-003 | 200 房间 / 800 连接持续 10 分钟 | 无 OOM、tick 漂移 < 5%、内存 < 300MB | P1 |
| TC-PERF-004 | 客户端 4 人对局帧率 | 稳定 60FPS（rAF 间隔 p95 < 20ms） | P0 |
| TC-PERF-005 | 生产构建首屏 | < 1.5s | P2 |

### 7.4 COMPAT / ACC
| 编号 | 用例 | 优先级 |
|---|---|---|
| TC-COMPAT-001 | Chrome/Edge/Firefox/Safari 最近 2 版核心流程冒烟 | P1 |
| TC-COMPAT-002 | 1366×768 / 1920×1080 / 4K 布局不错位 | P1 |
| TC-ACC-001 | 色盲模式：方块按形状可区分，颜色不承载唯一语义 | P2 |
| TC-ACC-002 | 全键盘可完成全部操作，焦点顺序合理 | P2 |

## 8. 验收矩阵（FR ↔ 用例追溯）
| 需求 | 主要用例 |
|---|---|
| FR-1 身份/大厅 | TC-UI-001 |
| FR-2 房间 | TC-ROOM-001~006、TC-UI-004/011、TC-MD-X-001 |
| FR-3 单人 | TC-UI-002/003 |
| FR-4 AI | TC-BOT-001/002、TC-ROOM-004 |
| FR-5 核心手感 | TC-ENG-001~008/011/012/013 |
| FR-6 survival | TC-MD-B-*、TC-UI-006、TC-ENG-009/010 |
| FR-7 timed | TC-MD-C-*、TC-UI-007、TC-ENG-009/010 |
| FR-8 sprint | TC-MD-A-*、TC-UI-005 |
| FR-9 聊天 | TC-CHAT-001~003、TC-UI-008、TC-SEC-002 |
| FR-10 断线重连 | TC-NET-003/004/101~104、TC-UI-009 |
| FR-11 界面 | TC-UI-004~007/011、TC-COMPAT-002 |
| FR-12 设置/输入 | TC-UI-010、TC-ACC-002 |

## 9. 缺陷管理与退出准则
- 缺陷等级：**S1** 阻断（崩溃/数据错乱/无法开局）、**S2** 严重（核心规则错误、座位丢失）、**S3** 一般（UI/体验）、**S4** 轻微（文案/样式）
- 每里程碑退出准则：P0 用例 100% 通过；无未修复 S1/S2；性能 P0 基线（TC-PERF-002/004）达标
- 回归：发版前全量 P0 + 上轮 S2/S3 关联用例

## 10. 执行纪律
- CI（GitHub Actions，触发分支 master/main）：lint → typecheck → Vitest（shared/client/server）→ coverage（shared 阈值 90/80/85/90）→ build；Playwright E2E 待 M6 接入后追加
- 集成测试时间逻辑当前为真实等待（端口随机 + afterAll 关闭）；tick/心跳/宽限期的时间仿真（fake timer）在 M3 随 Room 策略抽象一并补齐
- **每轮测试/调试结束后必须退出后台 node/vite/preview 进程，不占用端口**（测试代码 afterAll 强制关闭 + 手工 `Get-NetTCPConnection` 抽查）
- 压测脚本支持 `--duration` 与优雅退出，结束后输出摘要并清理进程


