# ADR-0003：传输层选型 —— 原生 ws + 自研 JSON 协议

- 状态：已接受（2026-10-22）
- 关联：protocol.md、ADR-0001

## 决策
- 传输：原生 `ws`（Node）+ 浏览器原生 WebSocket；可靠有序（TCP），不自建 UDP
- 格式：JSON（UTF-8），信封 `{ t: 消息类型, seq?, ts, d: 载荷 }`；棋盘快照用紧凑字符编码（见 protocol.md §快照格式）降低体积
- 留 `Codec` 抽象（encode/decode 两函数），未来可平滑切 MessagePack

## 理由
- 4 人房间、10×20 棋盘、10-20Hz 快照：估算单房间下行 < 10KB/s/客户端（变化才发后；v1.1 口径以 `technical-design.md` §4.4 为准），JSON 完全够用，可读性与调试效率优先
- 自研心跳（15s ping/pong）+ resumeToken 重连可控且代码量小（< 200 行）
- 游戏内消息低频小包，Socket.IO 的自动降级（polling）在 2026 年浏览器环境无意义，反而增加握手开销

## 备选
| 备选 | 不选原因 |
|---|---|
| Socket.IO | 重连/房间/广播自带，但黑盒语义多、体积大；自研成本可控 |
| uWebSockets.js | 性能极强但 API 非 Node 标准，本项目容量目标（800 连接）远未触及瓶颈 |
| gRPC/HTTP 轮询 | 双向实时性要求不匹配 |

## 后果
- 需自行实现：心跳超时、断线宽限、限流、Origin 校验（均已列入 protocol.md 与 NFR-3）
- 反向代理需配置 WS 升级头与读超时（部署章节）
