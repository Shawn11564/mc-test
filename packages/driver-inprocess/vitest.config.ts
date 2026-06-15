import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const protocolSrc = fileURLToPath(new URL("../protocol/src/index.ts", import.meta.url));

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30000,
  },
  resolve: {
    alias: {
      "@mc-test/protocol": protocolSrc,
    },
  },
});
