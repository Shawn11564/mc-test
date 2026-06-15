import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const protocolSrc = fileURLToPath(new URL("../protocol/src/index.ts", import.meta.url));
const headlessCaps = fileURLToPath(new URL("../driver-headless/src/capabilities.ts", import.meta.url));
const runnerSrc = fileURLToPath(new URL("./src/index.ts", import.meta.url));

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "../../examples/regions/**/*.test.ts"],
    environment: "node",
    testTimeout: 60000,
  },
  resolve: {
    alias: {
      "@mc-test/protocol": protocolSrc,
      "@mc-test/driver-headless/capabilities": headlessCaps,
      "@mc-test/runner": runnerSrc,
    },
  },
});
