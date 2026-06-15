/**
 * The conformance gate every driver must pass: every golden fixture validates
 * against the JSON Schema, every canonical method/event is covered by a request
 * + at least one response, every error code is exercised, error reasons mirror
 * their codes, and the negative controls are actually rejected.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import type { TSchema } from "@sinclair/typebox";
import {
  METHOD_NAMES,
  EVENT_NAMES,
  REQUEST_SCHEMAS,
  RESULT_SCHEMAS,
  NOTIFICATION_SCHEMAS,
  type MethodName,
  type EventName,
} from "../src/methods";
import { McptErrorResponse, MCTP_ERROR_CODES, ERROR_REASON_BY_CODE } from "../src/mctp";
import { Selector } from "../src/selectors";
import { Capabilities } from "../src/capabilities";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(here, "..", "fixtures", "conformance");
const methodsDir = join(fixturesDir, "methods");

/** Fresh Ajv per compile so the inline `$id:"Selector"` never collides across schemas. */
function makeValidator(schema: TSchema) {
  const ajv = new Ajv({ strict: false, allErrors: true });
  return ajv.compile(schema as object);
}

function expectValid(schema: TSchema, data: unknown, label: string): void {
  const validate = makeValidator(schema);
  const ok = validate(data);
  if (!ok) {
    throw new Error(`${label} should validate but did not:\n${JSON.stringify(validate.errors, null, 2)}`);
  }
  expect(ok).toBe(true);
}

const KNOWN_CODES = new Set<number>(Object.values(MCTP_ERROR_CODES));
const REASON_BY_CODE = ERROR_REASON_BY_CODE as Record<number, string>;

interface ErrorEnvelope {
  error: { code: number; message: string; data?: { reason?: string } };
}

function checkErrorEnvelope(env: ErrorEnvelope, label: string): void {
  expectValid(McptErrorResponse, env, `${label} (error envelope)`);
  const code = env.error.code;
  expect(KNOWN_CODES.has(code), `${label}: code ${code} is a known error code`).toBe(true);
  const reason = env.error.data?.reason;
  if (reason !== undefined) {
    expect(reason, `${label}: reason mirrors code ${code}`).toBe(REASON_BY_CODE[code]);
  }
}

interface Bundle {
  method: string;
  request: unknown;
  responses: { name: string; envelope: Record<string, unknown> }[];
}

const bundles: Bundle[] = readdirSync(methodsDir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(methodsDir, f), "utf8")) as Bundle);

describe("conformance fixtures — per method", () => {
  for (const b of bundles) {
    describe(b.method, () => {
      it("is a canonical method", () => {
        expect((METHOD_NAMES as readonly string[]).includes(b.method)).toBe(true);
      });
      it("request validates against the request schema", () => {
        expectValid(REQUEST_SCHEMAS[b.method as MethodName], b.request, `${b.method} request`);
      });
      it("has at least one response", () => {
        expect(b.responses.length).toBeGreaterThan(0);
      });
      for (const r of b.responses) {
        it(`response '${r.name}' validates`, () => {
          if ("result" in r.envelope) {
            expectValid(RESULT_SCHEMAS[b.method as MethodName], r.envelope, `${b.method} ${r.name}`);
          } else if ("error" in r.envelope) {
            checkErrorEnvelope(r.envelope as unknown as ErrorEnvelope, `${b.method} ${r.name}`);
          } else {
            throw new Error(`${b.method} ${r.name}: response has neither result nor error`);
          }
        });
      }
    });
  }
});

describe("conformance fixtures — coverage", () => {
  const byMethod = new Map(bundles.map((b) => [b.method, b]));

  it("every canonical method has a request + >=1 response", () => {
    for (const m of METHOD_NAMES) {
      const b = byMethod.get(m);
      expect(b, `missing fixture bundle for ${m}`).toBeDefined();
      expect(b?.request, `${m} missing request`).toBeDefined();
      expect((b?.responses.length ?? 0) > 0, `${m} missing responses`).toBe(true);
    }
  });

  it("has no stray fixture for an unknown method", () => {
    for (const b of bundles) {
      expect((METHOD_NAMES as readonly string[]).includes(b.method), `unknown method ${b.method}`).toBe(true);
    }
  });
});

const eventsFile = JSON.parse(readFileSync(join(fixturesDir, "events.json"), "utf8")) as {
  events: { event: string; envelope: unknown }[];
};

describe("conformance fixtures — events", () => {
  for (const e of eventsFile.events) {
    it(`${e.event} notification validates`, () => {
      expect((EVENT_NAMES as readonly string[]).includes(e.event)).toBe(true);
      expectValid(NOTIFICATION_SCHEMAS[e.event as EventName], e.envelope, e.event);
    });
  }
  it("covers every canonical event", () => {
    const seen = new Set(eventsFile.events.map((e) => e.event));
    for (const e of EVENT_NAMES) expect(seen.has(e), `missing event fixture ${e}`).toBe(true);
  });
});

const errorsFile = JSON.parse(readFileSync(join(fixturesDir, "errors.json"), "utf8")) as {
  errors: { name: string; envelope: ErrorEnvelope }[];
};

describe("conformance fixtures — generic errors", () => {
  for (const e of errorsFile.errors) {
    it(`${e.name} validates`, () => checkErrorEnvelope(e.envelope, e.name));
  }
});

describe("conformance fixtures — error-code coverage", () => {
  it("every MCTP/JSON-RPC error code is exercised by a fixture", () => {
    const codes = new Set<number>();
    for (const b of bundles) {
      for (const r of b.responses) {
        if ("error" in r.envelope) {
          codes.add((r.envelope as unknown as ErrorEnvelope).error.code);
        }
      }
    }
    for (const e of errorsFile.errors) codes.add(e.envelope.error.code);
    for (const code of Object.values(MCTP_ERROR_CODES)) {
      expect(codes.has(code), `no fixture exercises error code ${code}`).toBe(true);
    }
  });
});

const invalidFile = JSON.parse(readFileSync(join(fixturesDir, "invalid.json"), "utf8")) as {
  cases: { name: string; schemaRef: string; data: unknown }[];
};

function resolveSchema(ref: string): TSchema {
  if (ref === "selector") return Selector;
  if (ref === "capabilities") return Capabilities;
  if (ref === "errorResponse") return McptErrorResponse;
  const [kind, name] = ref.split(":");
  if (kind === "request") return REQUEST_SCHEMAS[name as MethodName];
  if (kind === "result") return RESULT_SCHEMAS[name as MethodName];
  if (kind === "notification") return NOTIFICATION_SCHEMAS[name as EventName];
  throw new Error(`unknown schemaRef ${ref}`);
}

describe("conformance fixtures — negative controls (must be rejected)", () => {
  for (const c of invalidFile.cases) {
    it(`${c.name} is rejected`, () => {
      const validate = makeValidator(resolveSchema(c.schemaRef));
      expect(validate(c.data), `${c.name} should have FAILED validation`).toBe(false);
    });
  }
});
