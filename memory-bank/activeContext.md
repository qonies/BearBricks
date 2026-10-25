# 当前工作上下文（Active Context）

## 当前阶段
**M6 第四轮（2026-10-25，Act）：全量审计修复 + AI 难度下调 / 硬降门槛**。
工作树仍包含 M6 前几轮（设置屏 / 改键 / 触屏 / iPad 自适应）与本轮全部改动；按项目规则**未提交、未推送**。

## 本轮完成（按审计报告逐项）

### 规则 / 联机正确性
- **survival 离场口径**：`Seat.rankBottom` 新增。主动离开/宽限超时且仍存活 → 判淘汰并垫底（`computeSurvivalRanking` 的 abandoned 分支终于可达），但**不复用 `abandoned`**，因此迟到 resume 仍可回来观战/聊天；**已淘汰观战者离开**不再置空座位，保留原淘汰时刻与结算记录（`RankingEntry.status='eliminated'`）。
- **7-bag 重连对齐（协议 v1.7）**：`TetrisGame.spawnCount`（从队列取块数）+ `alignBag()`；自快照携带 `spawnCount`，`applySnapshotState` 按 `seed + spawnCount + queue.length` 重建 bag 游标。修复重连/大校正后 Next 预览与实际出块漂移；新增「重连后连续 9 块 queue 一致」回归。
- **PLAYING 广播 room.state**：`beginGame` 成功路径补 `broadcastRoomState()`（客户端不再长期停在 COUNTDOWN）。
- **tickStep 阶段守卫**：补帧循环在 `finishGame` 后不再推进引擎。
- **房主转让**：优先未放弃/未淘汰真人，全部不可用才回退。
- **timed 宽限双计顶出**：掉线时已在复活冻结中则不再 `markSeatGameEnded`。
- **survival 系统消息**：主动离开只播 TOP_OUT（不再 TOP_OUT + LEAVE 双播）。

### 客户端状态机 / 输入 / 触控
- **App welcome 迁移**：抽出 `applyRoom`，welcome 与 room.state 共用；重连时若房间已回 WAITING/COUNTDOWN（掉线期间房主 rematch）→ 清 `mpStart/result` 并回房间，修复卡在旧对局屏。
- **E4010 终态**：服务端 `Session.closeAfterFlush()`（先 flush 错误再断开）；未 hello 的消息改回 **E4031**；客户端 welcome 前只放行 hello/pong（其余动作入队），E4010 停止看门狗并展示全屏「已在其他窗口登录」遮罩 + 刷新。
- **聊天 IME**：`ChatPanel` 在 `isComposing` 时忽略 Enter，中文选词不再误发。
- **手势多指**：`GestureRecognizer.end` 先校验 pointerId 再清 track；第二根手指抬起不再终止第一根手势。
- **320px 触控**：`input/touchLayout.ts` 按容器宽度反算按键（5 键 + 64px 固定开销；320px → 51px，<284px 换行兜底）；`TouchControls` 用 ResizeObserver；新增单测。
- **单人设置自动暂停**：`GameView` 打开设置弹层时暂停，关闭时只恢复由设置触发的暂停；联机仍不暂停。
- **HUD**：联机宽屏仅在 sprint 显示 `行/目标`（survival/timed 不再显示 `n/40` / 重连后 `n/0`）；重连初始快照预热 `selfStatus/survival/timed`；sprint 完赛显示等待提示。
- **命中区**：`(any-pointer: coarse)` 下全局按钮 `min-height: 44px`。

### 服务端 / 部署
- `config` 的 `port/origin/isProd/trustProxy` 改为 getter；非法 `PORT` 回退 3000；`ORIGIN` 归一化比较（容忍结尾 `/` 与路径）。
- `RoomManager.handleHello` / `Room.uniqueNickname` 清洗昵称控制字符；`/healthz` rooms 统计全部房间。
- `wsHub` 429/503 改用 `socket.end`（保证状态行 flush）。
- `.webmanifest` MIME = `application/manifest+json`；仅 `/assets/*` 长缓存，manifest/图标/index 用 no-cache。
- PWA 图标：`public/icon-192.png`、`icon-512.png`、`apple-touch-icon.png`（脚本生成的 2×2 色块），manifest/index.html 已引用。
- 生产安全头（CSP / nosniff / frame / referrer）；`@fastify/compress` 全局 gzip（server build 将其 external）。
- Dockerfile：`USER node` + `HEALTHCHECK /healthz`。

### AI（shared/src/ai/bot.ts）
- 难度下调：EASY **450ms / 30%**、NORMAL **300ms / 18%**、HARD **180ms / 6%**。
- **硬降门槛**：`BOT_MIN_HARD_DROP_ROWS = 10`（可见区一半）；每个新块记录 `pieceStartY`，必须逐格 `soft` 下降 ≥10 行后才允许 `hard`；提前落地返回 null 交给锁定延迟；无合法落点/卡死兜底也遵守。新增单测断言 hard 前 soft ≥10 且 `active.y ≥ 1+10`。
- 文档：README / requirements FR-4 / technical-design §6 / test-plan TC-BOT-003。

## 验证
- `npm run typecheck` / `npm run lint` 通过。
- **shared 98 / client 57 / server 29**（server 单元 16 + 集成 13）全绿。
- `npm run test:coverage` 通过（阈值 90/80/85/90）。
- `npm run build`（client tsc+vite、server esbuild）通过；server bundle 仅 102.6KB。

## 下一步
1. Playwright E2E（TC-UI-002~007、012~021，含 iPad project）。
2. iPad 真机手测（320px Split View、IME、妙控键盘、切后台、主屏幕图标）。
3. M6 余项：音效本体（iOS AudioContext 解锁）、色盲配色、压测、Docker 镜像实测。
4. 依赖：`npm audit --omit=dev` 仍有 zod <4.6.6 的 high advisory（4KB 上限已降低暴露面）；zod 4 迁移单独排期。

## 待定 / 风险
- 触控手势默认关闭，是否首次检测到触屏时提示开启待产品定。
- 硬降保留 T-Spin（d=0）与软降不清理 `lastActionRotation` 的口径仍需手感评审。
- 对手快照仍含 2 行隐藏区（小幅信息冗余，改动牵动渲染索引）。
- 宽限扫描 5s → 实际 30–35s；timed 迟到 resume 按协议保留。
- Docker 镜像未本机实测；Playwright/真机未跑。

## 历史
M0~M5.5 的详细记录见 `memory-bank/progress.md` 与 git 历史；本文件只保留当前有效上下文。