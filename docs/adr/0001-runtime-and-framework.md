# ADR-0001：技术栈选型

- 状态：已接受（2026-10-22）
- 关联：requirements.md §NFR、technical-design.md §1

## 决策
- Monorepo（npm workspaces）：`packages/shared`（纯 TS 游戏核心+协议）、`packages/server`（Node 22 + Fastify + ws）、`packages/client`（React 19 + Vite + TS + Zustand + Tailwind CSS v4，棋盘 Canvas 2D）
- 测试：Vitest + Playwright；质量：ESLint flat config + Prettier；CI：GitHub Actions
- 部署：单 Docker 镜像（node:22-alpine），反代（Caddy/Nginx）终止 TLS

## 理由
- `shared` 双端复用同一引擎：保证客户端预演与服务端权威逻辑一致，杜绝规则漂移；RNG 带 seed 可复现方块序列
- Canvas 2D 对 10×20 棋盘 + 4 人小板绰绰有余，60FPS 稳定；WebGL(PixiJS) 过度设计，DOM 渲染有掉帧风险
- Zustand 高频更新样板少；React 19 + Vite 开发体验与生态最佳
- Fastify 内置静态托管与健康检查，配 `ws` 足够；不引入重框架

## 备选与不选原因
| 备选 | 不选原因 |
|---|---|
| Socket.IO | 体积大、自带重连/fallback 语义与自研协议重叠；如需可后迁（NetClient 已抽象） |
| Colyseus | 房间框架抽象重、状态序列化黑盒，学习成本 > 收益 |
| Phaser | 完整游戏引擎对本项目过重，且与 React UI 融合别扭 |
| Redux Toolkit | 高频游戏状态更新下样板冗余 |
| SQLite/Redis | 无登录、无持久化需求（需求 §7 明确）；预留 RoomStore 接口 |
| Next.js | 无 SSR/SEO 需求，纯 SPA 更简单 |

## 后果
- 需要自研少量基础设施（重连、限流、快照编码）——已列入 protocol.md
- Tailwind v4 + Vite 需使用其官方 Vite 插件
