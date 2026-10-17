#!/usr/bin/env node
/**
 * The macro menu real-boot E2E (docs/MACROS.md §8): boots a real dedicated server per loader with its server
 * agent and MCTEST_MACROS pointing at a scratch folder, joins a real opped client (Mineflayer "Tester"), and
 * drives the menu with the clicks a vanilla client sends, checking the menu's slots, the macro files and the
 * `[macro Tester] …` log lines:
 *
 *   1. `/macro` lists every macro with its steps on the icon;
 *   2. dragging moves a macro, dropping it on another swaps them, a macro can be carried to the next page, and
 *      the arrangement is saved (macros.layout) and survives reopening; no icon ever lands in the inventory;
 *   3. shift-click runs a macro; right-click opens it, showing every step;
 *   4. dragging a step reorders the file; Q deletes a step and Undo brings it back;
 *   5. a step added through the filled-in chat command lands in the file, and the menu opens again on it;
 *   6. the book: edited and Done → the macro is rewritten; a bad book isn't saved and can be cancelled;
 *   7. a new macro, then deleting it through the confirm screen.
 *
 * Loaders whose agent jar is not built are honest skips. Needs the runner built (`npm run build`).
 *
 *   node tests/e2e/run-bench-macro-menu.mjs [fabric|neoforge]
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createBot } from "mineflayer";
import { provisionModded } from "../../packages/runner/dist/provision/ModdedProvisioner.js";
import { findFreePort } from "../../packages/runner/dist/provision/serverCommon.js";
import { resolveJavaForMc } from "../../packages/runner/dist/provision/jdk.js";
import { resolveModrinth } from "../../packages/runner/dist/provision/modrinth.js";

const LANES = [
  {
    id: "fabric", mc: "1.21.1",
    jar: "agents/server-fabric/build/libs/agent-server-fabric-1.21.1.jar",
    boot: async (o) => provisionModded({
      ...o, loader: "fabric", mc: "1.21.1", loaderVersion: "0.16.5",
      mods: [{
        path: await resolveModrinth({ project: "fabric-api", loader: "fabric", gameVersion: "1.21.1" }, o.cacheDir),
        as: "fabric-api.jar",
      }],
    }),
  },
  {
    id: "neoforge", mc: "1.21.1",
    jar: "agents/server-neoforge/build/libs/agent-server-neoforge-1.21.1.jar",
    boot: (o) => provisionModded({ ...o, loader: "neoforge", mc: "1.21.1", loaderVersion: "21.1.234", mods: [] }),
  },
];

const E2E = `macro give.to who n=1
  # Gives {who} {n} diamonds.
  /give {who} minecraft:diamond {n}
  /say {who} got {n}
end

macro hello
  /say hello from the menu
  wait 1t
  /say second step
end
`;
const OTHER = `macro other.thing
  say just a note
end
`;

const failures = [];
function assert(cond, label) {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures.push(label);
  return cond;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every text in a chat component, item name or lore, as NBT or JSON. */
function texts(x, out = []) {
  if (x == null) return out;
  if (typeof x === "string") {
    try {
      const parsed = JSON.parse(x);
      if (parsed && typeof parsed === "object") return texts(parsed, out);
    } catch { /* plain text */ }
    out.push(x);
    return out;
  }
  if (Array.isArray(x)) {
    x.forEach((v) => texts(v, out));
    return out;
  }
  if (typeof x === "object") {
    if (x.type === "string" && typeof x.value === "string") {
      out.push(x.value);
      return out;
    }
    for (const [k, v] of Object.entries(x)) {
      if (k === "color" || k === "italic" || k === "type") continue;
      texts(v, out);
    }
  }
  return out;
}

async function runLane(lane) {
  console.log(`\n=== ${lane.id} (${lane.mc}) ===`);
  const instanceDir = mkdtempSync(join(tmpdir(), `mctest-menu-${lane.id}-`));
  const macroDir = mkdtempSync(join(tmpdir(), `mctest-menu-files-${lane.id}-`));
  writeFileSync(join(macroDir, "e2e.macro"), E2E);
  writeFileSync(join(macroDir, "other.macro"), OTHER);
  process.env.MCTEST_MACROS = macroDir; // the provisioner's child inherits process.env
  const gamePort = await findFreePort("127.0.0.1", 25800, 25999);
  const agentPort = await findFreePort("127.0.0.1", gamePort + 1, 25999);
  const cacheDir = resolve(".mc-test/cache");
  const javaPath = await resolveJavaForMc(lane.mc, { cacheDir });
  const log = [];
  const file = (name) => (existsSync(join(macroDir, name)) ? readFileSync(join(macroDir, name), "utf8") : "");
  let server;
  let bot;
  const chat = [];
  try {
    server = await lane.boot({
      bindHost: "127.0.0.1", gamePort, instanceDir, cacheDir, javaPath,
      agents: [{ name: `server-${lane.id}`, jarPath: resolve(lane.jar), port: agentPort }],
      ops: ["Tester"],
      eulaAccepted: true,
      bootTimeoutMs: 300000,
      onLog: (chunk) => log.push(...String(chunk).split(/\r?\n/)),
    });
    const booted = log.length;
    const seen = (re) => log.slice(booted).some((l) => re.test(l));
    const waitLog = async (re, ms = 10000) => {
      const until = Date.now() + ms;
      while (!seen(re) && Date.now() < until) await sleep(100);
      return seen(re);
    };

    bot = await new Promise((res, rej) => {
      const b = createBot({ host: "127.0.0.1", port: gamePort, username: "Tester", version: "1.21.1", auth: "offline" });
      b.once("spawn", () => res(b));
      b.once("kicked", (r) => rej(new Error(`kicked: ${JSON.stringify(r)}`)));
      b.once("error", rej);
      setTimeout(() => rej(new Error("Tester did not join within 30s")), 30000);
    });
    bot.on("error", () => {});
    // A vanilla client's chest slots ARE its inventory; Mineflayer copies them back only when it closes the
    // window itself, so a window the server closes would leave its inventory stale. Copy them back here too.
    bot.on("windowClose", (w) => {
      if (!w || w.inventoryStart == null) return;
      const offset = w.inventoryStart - bot.inventory.inventoryStart;
      for (let i = w.inventoryStart; i < w.inventoryEnd; i++) bot.inventory.updateSlot(i - offset, w.slots[i] ?? null);
    });
    /** What the player holds: through the open window's inventory part while one is open. */
    const items = () => (bot.currentWindow
      ? bot.currentWindow.slots.slice(bot.currentWindow.inventoryStart).filter(Boolean)
      : bot.inventory.items());
    bot.on("message", (m) => chat.push({ text: m.toString(), json: JSON.stringify(m.json ?? {}) }));
    await sleep(1000);

    /** Resolves with the next window the server opens (set up before the action that opens it). */
    const nextWindow = (ms = 5000) => new Promise((res) => {
      const t = setTimeout(() => { bot.off("windowOpen", on); res(null); }, ms);
      const on = (w) => { clearTimeout(t); bot.off("windowOpen", on); res(w); };
      bot.on("windowOpen", on);
    });
    const open = async (command) => {
      const w = nextWindow();
      bot.chat(command);
      return w;
    };
    const title = (w) => texts(w?.title).join("");
    const slot = (i) => bot.currentWindow?.slots[i] ?? null;
    const name = (i) => texts(slot(i)?.componentMap?.get("custom_name")?.data).join("");
    const lore = (i) => texts(slot(i)?.componentMap?.get("lore")?.data).join("\n");
    /** A click as a vanilla client sends it; the server redraws the menu, so the client's guess doesn't matter. */
    const click = async (s, button = 0, mode = 0) => {
      bot._client.write("window_click", {
        windowId: bot.currentWindow.id, stateId: 0, slot: s, mouseButton: button, mode,
        changedSlots: [], cursorItem: { itemCount: 0 },
      });
      await sleep(400);
    };
    const leaked = () => items().filter((it) => /shulker|command_block|glass_pane|arrow|clock|target/.test(it.name));

    // 1. the list.
    let w = await open("/macro");
    assert(w && title(w).includes("Macros"), `/macro opens the menu (${title(w)})`);
    assert(name(0) === "give.to" && name(1) === "hello" && name(2) === "other.thing",
      `every macro, in file order (${name(0)}, ${name(1)}, ${name(2)})`);
    assert(lore(0).includes("/give {who} minecraft:diamond {n}") && lore(0).includes("Gives {who} {n} diamonds."),
      `the icon shows the description and the steps (${JSON.stringify(lore(0))})`);
    assert(slot(0)?.name?.endsWith("shulker_box") && slot(0)?.name !== slot(2)?.name,
      `macros are shulker boxes, coloured by file (${slot(0)?.name}, ${slot(2)?.name})`);

    // 2. dragging.
    await click(0);
    await click(20);
    assert(name(20) === "give.to" && slot(0) === null, `a macro picked up and put down moves (${name(20)})`);
    assert(/^20 give\.to$/m.test(file("macros.layout")), `…and the place is saved (${JSON.stringify(file("macros.layout"))})`);
    await click(20);
    await click(1);
    assert(name(1) === "give.to", "dropping a macro on another puts it there…");
    await click(30);
    assert(name(30) === "hello", "…and the other is picked up, to put down elsewhere");
    await click(1);
    await click(53);
    await click(4);
    assert(/^49 give\.to$/m.test(file("macros.layout")), "a macro carried to the next page lands there (position 49)");
    await click(45);
    bot.closeWindow(bot.currentWindow);
    await sleep(500);
    w = await open("/macro");
    assert(name(30) === "hello" && slot(1) === null, "the arrangement survives closing and reopening");
    assert(leaked().length === 0, `no icon ever reached the inventory (${leaked().map((i) => i.name)})`);

    // 3. run and open.
    await click(30, 0, 1);
    assert(await waitLog(/\[macro Tester\] done hello/), "shift-click runs the macro");
    assert(seen(/hello from the menu/) && seen(/second step/), "…all its steps");
    await sleep(300);
    assert(bot.currentWindow == null, "…and closes the menu so you see it run");
    w = await open("/macro");
    await click(53);
    const opened = nextWindow();
    await click(4, 1, 0);
    w = await opened;
    assert(title(w).includes("Macro give.to"), `right-click opens the macro (${title(w)})`);
    assert(name(0) === "1  /give {who} minecraft:diamond {n}" && name(1) === "2  /say {who} got {n}",
      `…showing every step in order (${name(0)} | ${name(1)})`);
    assert(slot(0)?.name === "command_block", "a command step is a command block");

    // 4. reorder, delete, undo.
    await click(1);
    await click(0);
    assert(/\/say \{who\} got \{n\}\n {2}\/give/.test(file("e2e.macro")), `dragging step 2 onto step 1 swaps them in the file (${JSON.stringify(file("e2e.macro").slice(0, 120))})`);
    assert(name(0) === "1  /say {who} got {n}", "…and the menu shows the new order");
    await click(0, 0, 4);
    assert(!file("e2e.macro").includes("/say {who} got {n}"), "Q deletes the step from the file");
    assert(name(52).includes("Undo"), "…and Undo appears");
    await click(52);
    assert(file("e2e.macro").includes("/say {who} got {n}"), "Undo puts it back");

    // 5. a step through chat.
    chat.length = 0;
    await click(48);
    await sleep(300);
    assert(bot.currentWindow == null, "Add a step closes the menu…");
    assert(chat.some((m) => m.json.includes("/macro edit give.to add ") && /suggest_command/.test(m.json)),
      `…and offers the command, filled in (${chat.map((m) => m.text).join(" | ")})`);
    let reopened = nextWindow();
    bot.chat("/macro edit give.to add /say added by the menu test");
    assert(await waitLog(/\[macro Tester\] edit: added a step to give\.to/), "the command adds the step");
    w = await reopened;
    assert(title(w).includes("Macro give.to") && name(2) === "3  /say added by the menu test",
      `…and the menu opens again on the macro, showing it (${title(w)}: ${name(2)})`);

    // 6. the book.
    await click(49);
    await sleep(600);
    const book = bot.inventory.slots[36 + bot.quickBarSlot];
    assert(book?.name === "writable_book", `Edit in a book puts a book in hand (${book?.name})`);
    reopened = nextWindow();
    bot._client.write("edit_book", {
      hand: bot.quickBarSlot,
      pages: ["macro give.to who n=1\n# Rewritten in a book.\n/give {who} minecraft:emerald {n}", "/say from the book\nend"],
      title: undefined,
    });
    assert(await waitLog(/\[macro Tester\] edit: rewrote give\.to from a book/), "pressing Done saves the book");
    assert(file("e2e.macro").includes("macro give.to who n=1\n  # Rewritten in a book.\n  /give {who} minecraft:emerald {n}\n  /say from the book\nend"),
      `…as the macro, indented (${JSON.stringify(file("e2e.macro").slice(0, 160))})`);
    assert(file("e2e.macro").includes("macro hello"), "…leaving the other macros alone");
    w = await reopened;
    assert(title(w).includes("Macro give.to"), "…and opens the macro again");
    assert(!items().some((i) => i.name === "writable_book"), "…and takes the book back");
    bot.closeWindow(bot.currentWindow);
    await sleep(300);
    chat.length = 0;
    bot.chat("/macro edit give.to book");
    await sleep(600);
    bot._client.write("edit_book", { hand: bot.quickBarSlot, pages: ["/say no header"], title: undefined });
    await sleep(800);
    assert(chat.some((m) => m.text.includes("Not saved")), `a book without a header isn't saved (${chat.map((m) => m.text).join(" | ")})`);
    assert(bot.inventory.items().some((i) => i.name === "writable_book"), "…and the book stays to fix");
    bot.chat("/macro book cancel");
    await sleep(600);
    assert(!bot.inventory.items().some((i) => i.name === "writable_book"), "/macro book cancel takes it back");

    // 7. new, and delete through the confirm screen.
    bot.chat("/macro new menu.made who");
    assert(await waitLog(/\[macro Tester\] edit: created menu\.made/), "/macro new creates a macro");
    assert(file("new.macro").includes("macro menu.made who"), "…in new.macro");
    w = await open("/macro menu menu.made");
    assert(title(w).includes("Macro menu.made"), "/macro menu <name> opens it");
    let next = nextWindow();
    await click(53);
    w = await next;
    assert(title(w).includes("Delete menu.made?"), `Delete asks first (${title(w)})`);
    next = nextWindow();
    await click(11);
    w = await next;
    assert(!file("new.macro").includes("menu.made") && title(w).includes("Macros"), "…and deletes it, back on the list");
    bot.closeWindow(bot.currentWindow);
    await sleep(300);
    assert(leaked().length === 0, "no icon reached the inventory at any point");

    const errors = log.slice(booted).filter((l) => /ERROR|Exception/.test(l));
    assert(errors.length === 0, `no errors in the server log (${errors.slice(0, 5).join(" | ")})`);
    if (failures.length > 0) {
      console.log("  what Tester was told, for triage:");
      console.log(chat.map((m) => `    > ${m.text}`).join("\n"));
      console.log("  the macro lines, for triage:");
      console.log(log.slice(booted).filter((l) => /\[macro |mc-test/.test(l)).map((l) => `    | ${l}`).join("\n"));
    }
  } catch (e) {
    failures.push(`${lane.id}: ${e.message}`);
    console.log(`  ✗ lane error: ${e.stack}`);
    console.log(chat.map((m) => `    > ${m.text}`).join("\n"));
    console.log(log.slice(-60).filter((l) => l.trim()).map((l) => `    | ${l}`).join("\n"));
    console.log(`  (instance kept for triage: ${instanceDir})`);
    try {
      bot?.quit();
      await server?.stop();
    } catch { /* best-effort */ }
    return;
  }
  bot?.quit();
  try {
    await server.stop();
  } catch { /* best-effort */ }
  for (const dir of [instanceDir, macroDir]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch { /* Windows file locks */ }
  }
}

const only = process.argv[2];
const lanes = LANES.filter((l) => !only || l.id === only);
const built = lanes.filter((l) => existsSync(l.jar));
for (const lane of lanes.filter((l) => !existsSync(l.jar))) {
  console.log(`○ SKIP ${lane.id} — ${lane.jar} not built (acceptance-only)`);
}
for (const lane of built) {
  await runLane(lane);
}
if (built.length === 0) {
  console.log("no agent jars built; nothing verified (honest skip)");
  process.exit(0);
}
console.log(failures.length === 0
  ? "\nALL bench-macro-menu E2E assertions passed"
  : `\n${failures.length} FAILURES:\n - ${failures.join("\n - ")}`);
process.exit(failures.length === 0 ? 0 : 1);
