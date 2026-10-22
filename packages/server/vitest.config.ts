import { defineConfig } from 'vitest/config';

// 集成测试文件各自运行真实 ws 服务器 + 60Hz GameLoop：并行会争用 CPU 导致
// 权威 tick 落后于墙钟（追赶保护钳制 steps），复活/免伤等以 tick 计时的断言会不稳定 → 串行执行
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});