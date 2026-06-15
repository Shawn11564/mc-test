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

/** Flatten a value that may be a plain string, a `§`-coded string, or a JSON component. */
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
  return flattenComponent(raw);
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
