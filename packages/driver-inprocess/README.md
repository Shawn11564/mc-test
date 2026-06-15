# @mc-test/driver-inprocess

The **in-process driver** — the runner-side adapter that **launches and babysits
a rendered Minecraft client** hosting the client MCTP agent (`client-fabric` et
al.), then talks to that agent over MCTP. It is the only driver that can
read/operate **real, client-rendered mod Screens/widgets** — the one thing the
headless bot fundamentally cannot see.

Per M4 it advertises:

```
chat · command · containerGui · clientScreens · typeText · pressKey · testIdTags · screenshot · rendering
```

and **not** `worldTruth`, `pluginState`, `fixtures`, or `fakePlayers` — those
belong to a paired server agent. A `clientScreens` test selects this driver; a
`containerGui`-only test still picks the cheaper headless driver.

## Protocol-first

This package launches the rendered client and connects to the **client agent**'s
MCTP endpoint (`ws://127.0.0.1:<port>/mctp`) as a JSON-RPC 2.0 client — exactly
as the runner connects to any JVM agent. There is no in-process shortcut on the
wire; the runner is unaware whether a driver is headless or a rendered client.

## Launch & babysit

| Piece | Role |
|-------|------|
| `launch/Display.ts` (`selectDisplay`) | Pick the display backend: **Xvfb + software GL** on Linux CI (ROADMAP §8.2), native **desktop** on win32/darwin or by explicit `display: desktop`. |
| `launch/ClientLauncher.ts` (`buildClientLaunch`) | Build the **offline** launch (no Microsoft auth: `--username Tester --uuid 0… --accessToken 0`), inject the SUT mods + the client agent jar, thread `MCTEST_AGENT_PORT` + display env. PURE. |
| `InProcessDriver.ts` | Launch the client, scrape `MCTP listening on :PORT` from its stdout, and hand the runner `ws://127.0.0.1:PORT/mctp`. |

### Offline & headless

The client joins an `online-mode=false` server with a deterministic identity
(`Tester`, zero UUID, zero access token) — **no Microsoft/Mojang session token,
ever** (ROADMAP §8.3). On Linux CI it renders under **Xvfb** with software GL so
no GPU is required; on a desktop runner it renders natively. Both are selected
automatically by `Display.ts`.

> **Acceptance-only:** the *real* `start()` (spawning a provisioned, mods-injected
> rendered client and scraping its readiness line) needs a built client +
> framebuffer and is **not** exercised in this repo's no-boot CI. Unit tests
> inject `opts.spawn`, a stub returning a live MCTP url with no client.

## Usage (via the runner)

The runner instantiates and drives this driver automatically when a target
selects `driver: inprocess`. To embed it directly:

```ts
import { InProcessDriver } from "@mc-test/driver-inprocess";
const driver = new InProcessDriver({ mc: "1.21.1", loader: "fabric", display: "xvfb" });
const { url } = await driver.start(); // ws://127.0.0.1:<port>/mctp (real client, acceptance-only)
// … connect an MctpClient to `url`, session.create, world.join, screen.*, …
await driver.stop();
```

For unit tests, inject a spawn stub so no client is launched:

```ts
const driver = new InProcessDriver({
  spawn: async () => ({ url: "ws://127.0.0.1:25599/mctp", stop: async () => {} }),
});
```
