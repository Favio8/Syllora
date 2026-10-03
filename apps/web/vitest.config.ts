import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * 与根配置 vitest.shared.ts 的 vitestExecArgv 同口径：Node 22.4+ 的进程级 Web
 * Storage（Node 24/25 默认开启）会盖掉 jsdom 的 localStorage，必须显式关掉。
 * 这里就地判断而不从仓库根导入：apps/web/tsconfig.json 不允许带 .ts 后缀的导入。
 */
const execArgv = process.allowedNodeEnvironmentFlags.has("--webstorage") ? ["--no-webstorage"] : [];

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
    execArgv,
  },
});
