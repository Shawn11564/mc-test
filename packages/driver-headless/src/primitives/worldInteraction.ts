/**
 * `world.*` **interaction** primitives (cap `worldInteraction`) mapped onto
 * Mineflayer: use/attack a block face, select a held item, aim, and hold movement
 * controls. Each does exactly ONE observable thing — no retries, no waiting for a
 * consequence, no assertions (all of that stays in the runner).
 *
 * The pure parts (face → vector/cursor, item-id normalization, control diffing)
 * live here as exported functions so they are unit-testable without a bot.
 */
import { Vec3 } from "vec3";
import type { Bot } from "mineflayer";
import type { BlockFace, HeldItem, MoveControls } from "@mc-test/protocol";

/** Mineflayer's loose block shape (its typings vary across prismarine versions). */
interface MfBlock {
  name?: string;
  type?: number;
  position: Vec3;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getProperties?: () => Record<string, any>;
}

/** Mineflayer's loose item shape. */
interface MfItem {
  name?: string;
  count?: number;
  slot?: number;
  displayName?: string;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The canonical outward normal of each block face. */
export const FACE_VECTORS: Record<BlockFace, { x: number; y: number; z: number }> = {
  up: { x: 0, y: 1, z: 0 },
  down: { x: 0, y: -1, z: 0 },
  north: { x: 0, y: 0, z: -1 },
  south: { x: 0, y: 0, z: 1 },
  west: { x: -1, y: 0, z: 0 },
  east: { x: 1, y: 0, z: 0 },
};

/** The vanilla `direction` byte for each face (down=0, up=1, north=2, …). */
export const FACE_NUMBERS: Record<BlockFace, number> = {
  down: 0,
  up: 1,
  north: 2,
  south: 3,
  west: 4,
  east: 5,
};

/**
 * The block-local point the cursor lands on for a face click: the face centre,
 * i.e. the block centre pushed half a block along the face normal. Returned in
 * the 0..1 block-local coordinates Mineflayer's `activateBlock` expects.
 */
export function faceCursor(face: BlockFace): { x: number; y: number; z: number } {
  const v = FACE_VECTORS[face];
  return { x: 0.5 + v.x * 0.5, y: 0.5 + v.y * 0.5, z: 0.5 + v.z * 0.5 };
}

/** Normalize an item id for comparison: strip the `minecraft:` namespace, lowercase. */
export function normalizeItemId(id: string): string {
  const trimmed = id.trim().toLowerCase();
  const colon = trimmed.indexOf(":");
  return colon === -1 ? trimmed : trimmed.slice(colon + 1);
}

/** Render a Mineflayer item as the wire `HeldItem` (`type: null` = empty hand). */
export function toHeldItem(item: MfItem | null | undefined, slot?: number): HeldItem {
  if (!item) {
    return { type: null, ...(slot !== undefined ? { slot } : {}) };
  }
  return {
    type: item.name ? `minecraft:${normalizeItemId(item.name)}` : null,
    ...(typeof item.count === "number" ? { count: item.count } : {}),
    ...(slot !== undefined ? { slot } : {}),
    ...(item.displayName ? { displayName: item.displayName } : {}),
  };
}

/** The control keys a `world.move` call sets to `true` (what it must release later). */
export function controlsToHold(controls: MoveControls | undefined): (keyof MoveControls)[] {
  if (!controls) return [];
  return (Object.keys(controls) as (keyof MoveControls)[]).filter((k) => controls[k] === true);
}

/** Render a Mineflayer block as the wire `Block` shape. */
export function toBlock(block: MfBlock): { type: string; properties?: Record<string, unknown> } {
  const props = block.getProperties?.();
  return {
    type: `minecraft:${normalizeItemId(block.name ?? "air")}`,
    ...(props && Object.keys(props).length
      ? { properties: Object.fromEntries(Object.entries(props).map(([k, v]) => [k, String(v)])) }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Bot-driven primitives
// ---------------------------------------------------------------------------

/** Look at a point (or explicit angles). `force` snaps instead of rotating smoothly. */
export async function look(
  bot: Bot,
  opts: { yaw?: number; pitch?: number; at?: { x: number; y: number; z: number }; force?: boolean },
): Promise<{ yaw: number; pitch: number }> {
  if (opts.at) {
    await bot.lookAt(new Vec3(opts.at.x, opts.at.y, opts.at.z), opts.force ?? true);
  } else if (opts.yaw !== undefined || opts.pitch !== undefined) {
    const yawDeg = opts.yaw ?? (bot.entity.yaw * 180) / Math.PI;
    const pitchDeg = opts.pitch ?? (bot.entity.pitch * 180) / Math.PI;
    await bot.look((yawDeg * Math.PI) / 180, (pitchDeg * Math.PI) / 180, opts.force ?? true);
  }
  return { yaw: (bot.entity.yaw * 180) / Math.PI, pitch: (bot.entity.pitch * 180) / Math.PI };
}

/**
 * Hold the requested control states, optionally for a bounded duration, then
 * release exactly the ones THIS call set (never the ones a previous call holds).
 */
export async function move(
  bot: Bot,
  opts: { controls?: MoveControls; durationMs?: number; stop?: boolean },
): Promise<string[]> {
  if (opts.stop === true) {
    bot.clearControlStates();
    return [];
  }
  const controls = opts.controls ?? {};
  for (const [key, value] of Object.entries(controls)) {
    if (typeof value === "boolean") {
      bot.setControlState(key as Parameters<Bot["setControlState"]>[0], value);
    }
  }
  const held = controlsToHold(controls);
  if (opts.durationMs !== undefined) {
    await sleep(opts.durationMs);
    for (const key of held) {
      bot.setControlState(key as Parameters<Bot["setControlState"]>[0], false);
    }
    return [];
  }
  return held.map(String);
}

/**
 * Select what the player holds. `slot` picks a hotbar index directly; `item`
 * resolves a matching inventory stack (namespace-insensitive) and equips it.
 * Returns `null` when nothing matches so the caller can raise ELEMENT_NOT_FOUND
 * — an empty hand is never reported as success for an `item` request.
 */
export async function setHeldItem(
  bot: Bot,
  opts: { item?: string; slot?: number; hand?: "main" | "off" },
): Promise<HeldItem | null> {
  const destination = opts.hand === "off" ? "off-hand" : "hand";
  if (opts.slot !== undefined) {
    bot.setQuickBarSlot(opts.slot);
    await sleep(50);
    return toHeldItem(bot.heldItem as MfItem | null, bot.quickBarSlot);
  }
  if (opts.item !== undefined) {
    const want = normalizeItemId(opts.item);
    const stack = (bot.inventory.items() as unknown as MfItem[]).find(
      (i) => normalizeItemId(i.name ?? "") === want,
    );
    if (!stack) return null;
    await bot.equip(stack as never, destination);
    await sleep(50);
    return toHeldItem(
      (destination === "hand" ? bot.heldItem : bot.inventory.slots[45]) as MfItem | null,
      destination === "hand" ? bot.quickBarSlot : undefined,
    );
  }
  // Neither `item` nor `slot`: a pure read of what is currently held.
  return toHeldItem(bot.heldItem as MfItem | null, bot.quickBarSlot);
}

/**
 * Right-click a block face. When `sneak` is set the bot holds sneak across the
 * interaction (and long enough for the server to see the pose change) — that is
 * what suppresses the block's own use behavior so a held item places against the
 * clicked face.
 */
export async function useBlock(
  bot: Bot,
  opts: {
    pos: { x: number; y: number; z: number };
    face?: BlockFace;
    hand?: "main" | "off";
    sneak?: boolean;
    cursor?: { x: number; y: number; z: number };
  },
): Promise<{ block: MfBlock; face: BlockFace } | null> {
  const face = opts.face ?? "up";
  const block = bot.blockAt(new Vec3(opts.pos.x, opts.pos.y, opts.pos.z)) as MfBlock | null;
  if (!block) return null;
  const fv = FACE_VECTORS[face];
  const cur = opts.cursor ?? faceCursor(face);
  const sneak = opts.sneak === true;
  try {
    // Aim at the face centre first: the server validates the interaction against
    // where the player is actually looking.
    await bot.lookAt(block.position.offset(cur.x, cur.y, cur.z), true);
    if (sneak) {
      bot.setControlState("sneak", true);
      // The sneak pose reaches the server on the next physics tick; interacting
      // before that would be read as a NON-sneaking click.
      await sleep(120);
    }
    await bot.activateBlock(block as never, new Vec3(fv.x, fv.y, fv.z), new Vec3(cur.x, cur.y, cur.z));
  } finally {
    if (sneak) bot.setControlState("sneak", false);
  }
  return { block, face };
}

/**
 * Left-click a block face. Default is one PUNCH (start digging, then abort) —
 * the primitive a protection SUT reacts to. `breakBlock` digs to completion.
 * NOTE: in creative mode a punch breaks instantly; that is vanilla behavior.
 */
export async function attackBlock(
  bot: Bot,
  opts: { pos: { x: number; y: number; z: number }; face?: BlockFace; breakBlock?: boolean },
): Promise<{ block: MfBlock; face: BlockFace; broken: boolean } | null> {
  const face = opts.face ?? "up";
  const position = new Vec3(opts.pos.x, opts.pos.y, opts.pos.z);
  const block = bot.blockAt(position) as MfBlock | null;
  if (!block) return null;
  const fv = FACE_VECTORS[face];
  const digFace = new Vec3(fv.x, fv.y, fv.z);

  if (opts.breakBlock === true) {
    await bot.dig(block as never, true, digFace as never);
  } else {
    const digging = bot.dig(block as never, true, digFace as never);
    // Abort as soon as the start-digging packet is out: that pair (status 0 then
    // status 1) IS a vanilla left-click. Aborting rejects `dig`, which is expected.
    const deadline = Date.now() + 1000;
    while (!(bot as unknown as { targetDigBlock?: unknown }).targetDigBlock && Date.now() < deadline) {
      await sleep(20);
    }
    bot.stopDigging();
    await digging.catch(() => undefined);
  }
  await sleep(80);
  const after = bot.blockAt(position) as MfBlock | null;
  const broken = !after || normalizeItemId(after.name ?? "air") === "air";
  return { block, face, broken };
}
