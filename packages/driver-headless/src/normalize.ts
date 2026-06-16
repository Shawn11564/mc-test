/**
 * Text flattening + normalization for selector matching.
 *
 * Minecraft display names / titles arrive as chat components (JSON) or
 * legacy `§`-coded strings. We flatten to plain text, then normalize for
 * robust comparison (strip formatting, collapse whitespace, case-fold) — the
 * same normalization SELECTORS.md prescribes, applied driver-side here.
 */

/**
 * Recursively flatten a Minecraft text component to plain text. Handles chat
 * components (`text`/`translate`/`extra`), arrays, AND the NBT-wrapped form
 * Mineflayer surfaces for window titles (`{ type: "string", value: "…" }` and
 * compound `{ type: "compound", value: {…} }`).
 */
export function flattenComponent(c: unknown): string {
  if (c == null) return "";
  if (typeof c === "string") return c;
  if (typeof c === "number" || typeof c === "boolean") return String(c);
  if (Array.isArray(c)) return c.map(flattenComponent).join("");
  const obj = c as Record<string, unknown>;
  let out = "";
  let matched = false;
  if (obj["text"] !== undefined) {
    out += flattenComponent(obj["text"]);
    matched = true;
  } else if (obj["translate"] !== undefined) {
    out += flattenComponent(obj["translate"]);
    matched = true;
  }
  if (Array.isArray(obj["extra"])) {
    out += (obj["extra"] as unknown[]).map(flattenComponent).join("");
    matched = true;
  }
  // NBT tag wrapper { type, value } (no chat keys) → unwrap the value.
  if (!matched && obj["value"] !== undefined) {
    out += flattenComponent(obj["value"]);
  }
  return out;
}

/** prismarine-nbt tag-type names — used to detect a tagged node `{ type, value }`. */
const NBT_TYPES = new Set([
  "compound", "list", "string", "byte", "short", "int", "long",
  "float", "double", "byteArray", "shortArray", "intArray", "longArray",
]);

/** A prismarine-nbt tagged value: `{ type: <nbtType>, value: … }`. */
function isNbtTag(v: unknown): v is { type: string; value: unknown } {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return typeof o["type"] === "string" && NBT_TYPES.has(o["type"]) && "value" in o;
}

function nbtTransform(value: unknown, type: string): unknown {
  if (type === "compound") {
    const out: Record<string, unknown> = {};
    for (const [k, child] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isNbtTag(child) ? nbtTransform(child.value, child.type) : child;
    }
    return out;
  }
  if (type === "list") {
    const inner = value as { type?: string; value?: unknown[] };
    return (inner.value ?? []).map((el) => nbtTransform(el, inner.type ?? ""));
  }
  return value; // scalar (string/number/bool) used as-is
}

/**
 * Convert a value to a plain chat component, simplifying it first if it is a
 * prismarine-nbt tagged node (mirrors prismarine-nbt's `simplify`): compounds →
 * objects, lists → arrays, scalars → their value. MC 1.20.5+ serializes item
 * display-name / lore components (`minecraft:custom_name`, `minecraft:lore`) as NBT,
 * which Mineflayer surfaces in this tagged form; simplifying turns it back into the
 * plain `{ text, extra, translate }` shape {@link flattenComponent} understands.
 * Non-tagged input (plain components, strings) passes through untouched.
 */
export function toPlainComponent(raw: unknown): unknown {
  return isNbtTag(raw) ? nbtTransform(raw.value, raw.type) : raw;
}

/** Flatten a value that may be a plain string, a `§`-coded string, a JSON component, or NBT-tagged. */
export function flattenText(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw === "string") {
    const s = raw.trim();
    if (s.startsWith("{") || s.startsWith("[")) {
      try {
        return flattenComponent(JSON.parse(s));
      } catch {
        return s;
      }
    }
    return s;
  }
  return flattenComponent(toPlainComponent(raw));
}

const SECTION_CODES = /[§&][0-9A-FK-ORa-fk-or]/g;
const ZERO_WIDTH = /[​‌‍﻿]/g;

/** Normalize a string for selector comparison (SELECTORS.md §4.1 pipeline). */
export function normalize(s: string): string {
  return s
    .replace(SECTION_CODES, "")
    .replace(ZERO_WIDTH, "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
