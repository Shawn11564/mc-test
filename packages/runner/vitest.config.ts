import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const protocolSrc = fileURLToPath(new URL("../protocol/src/index.ts", import.meta.url));
const headlessCaps = fileURLToPath(new URL("../driver-headless/src/capabilities.ts", import.meta.url));
const inprocessCaps = fileURLToPath(new URL("../driver-inprocess/src/capabilities.ts", import.meta.url));
const inprocessSrc = fileURLToPath(new URL("../driver-inprocess/src/index.ts", import.meta.url));
const pixelCaps = fileURLToPath(new URL("../driver-pixel/src/capabilities.ts", import.meta.url));
const pixelSrc = fileURLToPath(new URL("../driver-pixel/src/index.ts", import.meta.url));
const runnerSrc = fileURLToPath(new URL("./src/index.ts", import.meta.url));

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "../../examples/regions/**/*.test.ts"],
    environment: "node",
    testTimeout: 60000,
  },
  resolve: {
    alias: [
      // Order matters: the `/capabilities` subpath alias MUST precede the bare
      // package alias so the subpath resolves to its own source file (M4: the
      // DriverRegistry statically imports `@mc-test/driver-inprocess/capabilities`).
      { find: "@mc-test/protocol", replacement: protocolSrc },
      { find: "@mc-test/driver-headless/capabilities", replacement: headlessCaps },
      { find: "@mc-test/driver-inprocess/capabilities", replacement: inprocessCaps },
      { find: "@mc-test/driver-inprocess", replacement: inprocessSrc },
      { find: "@mc-test/driver-pixel/capabilities", replacement: pixelCaps },
      { find: "@mc-test/driver-pixel", replacement: pixelSrc },
      { find: "@mc-test/runner", replacement: runnerSrc },
    ],
  },
});
