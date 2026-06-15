# @mc-test/driver-headless

The **headless driver** — a [Mineflayer](https://github.com/PrismarineJS/mineflayer)
protocol bot exposed as a real **MCTP WebSocket server**. This is the default
fast CI driver: it logs into a server as an offline player, runs commands, reads
chat, and drives **server-driven container GUIs** (chest menus). No GPU, no
rendered client.

Per BUILD_PROMPT §M2 it advertises exactly:

```
chat · command · containerGui · typeText · pressKey
```

and **not** `screenshot`, `clientScreens`, `rendering`, `worldTruth`,
`pluginState`, `fixtures`, or `fakePlayers` — so a test requiring any of those
honestly **skips** on this driver.

## Protocol-first

The driver hosts a genuine MCTP server (`ws://127.0.0.1:0/mctp`, sub-protocol
`mctp.v1`); the runner connects to it as a JSON-RPC 2.0 client exactly as it
would to a JVM agent. There is no in-process shortcut on the wire.

## How primitives map

| MCTP method | Mineflayer |
|-------------|------------|
| `world.join` / `world.leave` | `createBot({auth:"offline"})` / `bot.quit()` |
| `world.runCommand` / `world.sendChat` | `bot.chat("/" + cmd)` / `bot.chat(msg)` |
| `world.waitForChat` | buffered `messagestr` (scans buffer, then waits) |
| `screen.get` / `screen.listElements` | enumerate `bot.currentWindow` container slots → `Element[]` |
| `screen.clickElement` | resolve selector → slot → `bot.clickWindow(slot)` |
| `screen.waitForScreen` | poll the open window's title/kind until match or timeout |
| `truth.*` / `fixture.*` / `player.*` | `METHOD_NOT_SUPPORTED` (M3 server agent) |

Selector resolution (`selectorResolve.ts`) maps a semantic `Selector` onto an
inventory slot by display-name / lore / itemType / testId. All retry/wait
intelligence stays in the runner's SelectorWaits.

## Usage (via the runner)

The runner instantiates and drives this driver automatically when a target
selects `driver: headless`. To embed it directly:

```ts
import { HeadlessDriver } from "@mc-test/driver-headless";
const driver = new HeadlessDriver();
const { url } = await driver.start(); // ws://127.0.0.1:<port>/mctp
// … connect an MctpClient to `url`, session.create, world.join, …
await driver.stop();
```
