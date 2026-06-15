/**
 * The canonical manifest of every emitted JSON Schema file, derived from the
 * TypeBox contract. Shared by `gen-schema.mts` (writes the files) and the drift
 * gate (`test/schema-sync.test.ts`, regenerates and compares) so the two can
 * never disagree about what should exist.
 */
import type { TSchema } from "@sinclair/typebox";
import { McptRequest, McptResponse, McptNotification, McptErrorObject } from "../src/mctp";
import { Capabilities } from "../src/capabilities";
import { Selector } from "../src/selectors";
import {
  METHOD_NAMES,
  EVENT_NAMES,
  REQUEST_SCHEMAS,
  RESULT_SCHEMAS,
  NOTIFICATION_SCHEMAS,
} from "../src/methods";

export interface SchemaFile {
  relPath: string;
  schema: TSchema;
}

export const SCHEMA_FILES: SchemaFile[] = [
  // Top-level envelope + vocabulary schemas
  { relPath: "mctp-request.schema.json", schema: McptRequest },
  { relPath: "mctp-response.schema.json", schema: McptResponse },
  { relPath: "mctp-notification.schema.json", schema: McptNotification },
  { relPath: "mctp-error-object.schema.json", schema: McptErrorObject },
  { relPath: "capabilities.schema.json", schema: Capabilities },
  { relPath: "selector.schema.json", schema: Selector },
  // Per-method request + result pair under schema/methods/
  ...METHOD_NAMES.map((name) => ({
    relPath: `methods/${name}.request.schema.json`,
    schema: REQUEST_SCHEMAS[name],
  })),
  ...METHOD_NAMES.map((name) => ({
    relPath: `methods/${name}.result.schema.json`,
    schema: RESULT_SCHEMAS[name],
  })),
  // Per-event notification schema under schema/events/
  ...EVENT_NAMES.map((name) => ({
    relPath: `events/${name}.notification.schema.json`,
    schema: NOTIFICATION_SCHEMAS[name],
  })),
];

/** Deterministic serialization used identically by the generator and the gate. */
export function serializeSchema(schema: TSchema): string {
  return `${JSON.stringify(schema, null, 2)}\n`;
}
