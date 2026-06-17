/**
 * The capability set the in-process (rendered-client) driver advertises.
 *
 * Per M4 the in-process driver pairs the runner with a real, client-rendered
 * Minecraft instance hosting the client agent (`client-fabric` et al.). It can
 * read/operate **client-rendered mod Screens/widgets** (`clientScreens`) — the
 * one thing the headless bot fundamentally cannot see — plus container GUIs,
 * chat, commands, typing and key presses, and (because a real framebuffer is
 * present) `screenshot`/`rendering`. It does NOT advertise the server-truth
 * caps (`worldTruth`/`pluginState`/`fixtures`/`fakePlayers`) — those belong to a
 * paired server agent.
 */
import type { Capabilities, CapabilityKey } from "@mc-test/protocol";

/** The advertised capability keys (array form, for `session.create` results). */
export const INPROCESS_CAPABILITY_KEYS: CapabilityKey[] = [
  "chat",
  "command",
  "containerGui",
  "clientScreens",
  "typeText",
  "pressKey",
  "testIdTags",
  "screenshot",
  "rendering",
];

/**
 * The advertised capability set (object form, for `matchCapabilities`).
 *
 * NOTE on `screenshot`/`rendering`: this is the **rendering-present** advertisement
 * — the in-process driver always launches a *real rendered client* under a display
 * (Xvfb in CI / desktop), so a framebuffer is present and pixel capture is offered.
 * The Java agent gates these on `hasFramebuffer()` at `session.create`
 * (`ClientCapabilities.build`), so a render-less client honestly DROPS them in its
 * granted set. The runner's per-step union is currently built from this static
 * descriptor (not the agent's granted caps); aligning the union with the live
 * grant — so a render-less client's `screenshot` step honest-skips rather than
 * erroring — is a documented follow-up (CAPABILITIES.md §4 footnote 2).
 */
export const INPROCESS_CAPABILITIES: Capabilities = {
  chat: true,
  command: true,
  containerGui: true,
  clientScreens: true,
  typeText: true,
  pressKey: true,
  testIdTags: true,
  screenshot: true,
  rendering: true,
  // The client agent core is loader-neutral; the driver launches each via a
  // loader-aware resolver (`launch/loaders.ts`): fabric/quilt use the KnotClient
  // classpath launch (F3, fully run); forge/neoforge use the modular installer
  // launch (F4) — implemented + pure parts tested, the live boot CI-gated behind
  // `MC_TEST_RENDERED_LOADERS` (else an HONEST SKIP, never a crash or false green).
  loader: ["fabric", "quilt", "forge", "neoforge"],
  mcVersionRange: ">=1.20 <=1.21.4",
};

/** The MCTP `agent.kind` for the client agent this driver launches. */
export const INPROCESS_AGENT_KIND = "clientMod" as const;
