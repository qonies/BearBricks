// 结构化日志接口（NFR-6）：房间/座位/对局事件统一以 { event, room, ... } JSON 输出。
// 只依赖最小接口（Fastify 的 app.log 结构兼容），测试可注入 noop 或收集器。

export interface Logger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
}

export const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
};
