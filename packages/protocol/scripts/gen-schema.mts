/**
 * Emit the committed JSON Schema files from the TypeBox contract.
 *
 * Run via `npm run gen:schema`. The committed output under `schema/` is the
 * published wire schema; the drift gate (`test/schema-sync.test.ts`) fails CI if
 * the committed files and a fresh regeneration disagree — proving the TS types
 * and the JSON Schema are always in sync.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA_FILES, serializeSchema } from "./schema-files.mts";

const here = dirname(fileURLToPath(import.meta.url));
const schemaDir = resolve(here, "..", "schema");

// Clean the generated subtrees so renamed/removed methods leave no stale files.
for (const sub of ["methods", "events"]) {
  const p = join(schemaDir, sub);
  if (existsSync(p)) rmSync(p, { recursive: true, force: true });
}

for (const { relPath, schema } of SCHEMA_FILES) {
  const out = join(schemaDir, relPath);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, serializeSchema(schema), "utf8");
}

console.log(`Wrote ${SCHEMA_FILES.length} schema files to ${schemaDir}`);
