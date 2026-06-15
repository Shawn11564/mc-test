/**
 * `screen.*` mapped onto a Mineflayer container window: enumerate slots as
 * Elements, snapshot the screen, and match screen-wait criteria. Selector
 * resolution itself lives in `selectorResolve.ts`.
 */
import type { Bot } from "mineflayer";
import type { Element, ScreenSnapshot, ScreenMatch } from "@mc-test/protocol";
import { flattenText, normalize } from "../normalize.js";
import type { ResolvedElement } from "./selectorResolve.js";

// Mineflayer's prismarine-window/-item types don't surface every field we read,
// so we access the structural shape through narrow local interfaces.
interface RawItem {
  name: string;
  customName?: string | null;
  customLore?: unknown;
  displayName?: string;
  nbt?: { value?: Record<string, { value?: Record<string, { value?: unknown }> }> } | null;
}

interface RawWindow {
  id: number;
  type?: string | number;
  title?: unknown;
  slots: (RawItem | null)[];
  inventoryStart?: number;
}

function currentWindow(bot: Bot): RawWindow | null {
  return (bot.currentWindow as unknown as RawWindow | null) ?? null;
}

/** The plugin-set display name (flattened), falling back to the vanilla name. */
export function itemLabel(item: RawItem): string | undefined {
  if (item.customName) {
    const flat = flattenText(item.customName);
    if (flat) return flat;
  }
  return item.displayName ?? undefined;
}

export function itemLore(item: RawItem): string[] | undefined {
  const cl = item.customLore;
  if (!cl) return undefined;
  const arr = Array.isArray(cl) ? cl : [cl];
  const lines = arr.map((l) => flattenText(l)).filter((l) => l.length > 0);
  return lines.length ? lines : undefined;
}

/** Read a Paper PDC testId (`mc-test:test_id`) off the item's NBT, if present. */
export function itemTestId(item: RawItem): string | undefined {
  const pbv = item.nbt?.value?.["PublicBukkitValues"]?.value;
  const v = pbv?.["mc-test:test_id"]?.value;
  return typeof v === "string" ? v : undefined;
}

/** Enumerate the container (top) slots of the open window as resolvable elements. */
export function containerElements(bot: Bot): ResolvedElement[] {
  const w = currentWindow(bot);
  if (!w) return [];
  const end = typeof w.inventoryStart === "number" ? w.inventoryStart : w.slots.length;
  const out: ResolvedElement[] = [];
  for (let i = 0; i < end; i++) {
    const item = w.slots[i];
    if (!item) continue;
    const label = itemLabel(item);
    out.push({
      slot: i,
      elementId: `slot-${i}`,
      label,
      testId: itemTestId(item),
      itemType: `minecraft:${item.name}`,
      lore: itemLore(item),
      role: label ? "button" : "slot",
    });
  }
  return out;
}

/** Project a resolved element onto the protocol `Element` wire shape. */
export function toProtocolElement(el: ResolvedElement): Element {
  return {
    elementId: el.elementId,
    role: el.role,
    label: el.label,
    text: el.label,
    itemType: el.itemType,
    lore: el.lore,
    testId: el.testId,
    slot: el.slot,
    enabled: true,
    visible: true,
    ref: `slot:${el.slot}`,
  };
}

/** A snapshot of the currently open container window (or `none`). */
export function snapshot(bot: Bot): ScreenSnapshot {
  const w = currentWindow(bot);
  if (!w) return { kind: "none", elements: [] };
  return {
    screenId: `window:${w.id}`,
    kind: "containerGui",
    title: flattenText(w.title),
    elements: containerElements(bot).map(toProtocolElement),
  };
}

/** Whether a screen snapshot satisfies a `screen.waitForScreen` match (title = contains). */
export function screenMatches(snap: ScreenSnapshot, match: ScreenMatch | undefined): boolean {
  if (!match) return snap.kind !== "none";
  if (match.kind !== undefined && snap.kind !== match.kind) return false;
  if (match.title !== undefined && !normalize(snap.title ?? "").includes(normalize(match.title))) {
    return false;
  }
  if (match.screenId !== undefined && snap.screenId !== match.screenId) return false;
  if (match.screenIdPrefix !== undefined && !(snap.screenId ?? "").startsWith(match.screenIdPrefix)) {
    return false;
  }
  return true;
}
