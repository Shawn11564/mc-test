/**
 * Drift gate: the committed JSON Schema files MUST byte-for-byte equal a fresh
 * regeneration from the TypeBox contract. Because the TS types and the schemas
 * derive from the same TypeBox objects, this proves they are in sync — any edit
 * to a type that is not reflected in the committed schema (or vice versa) fails
 * CI here. Run `npm run gen:schema` to refresh.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA_FILES, serializeSchema } from "../scripts/schema-files.mts";

const here = dirname(fileURLToPath(import.meta.url));
const schemaDir = resolve(here, "..", "schema");

describe("schema/TS drift gate", () => {
  for (const { relPath, schema } of SCHEMA_FILES) {
    it(`${relPath} is in sync`, () => {
      const path = join(schemaDir, relPath);
      expect(existsSync(path), `${relPath} is not committed — run npm run gen:schema`).toBe(true);
      const committed = readFileSync(path, "utf8");
      expect(committed).toBe(serializeSchema(schema));
    });
  }

  it("emits the expected number of files", () => {
    // 6 top-level + 24 methods x 2 (request+result) + 4 events = 58
    expect(SCHEMA_FILES.length).toBe(58);
  });
});
