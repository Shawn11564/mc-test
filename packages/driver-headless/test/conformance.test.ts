/**
 * Conformance gate (ROADMAP §7.1 / §3.6): the headless driver replays the M1
 * golden conformance fixtures for **every advertised method** and asserts each
 * response is a schema-valid MCTP envelope — a success matching the method's
 * result schema, or a canonical MCTP error (known code) matching the error
 * schema. Pre-join, methods that need a live bot legitimately return a
 * schema-valid WORLD_NOT_READY; the point is that no advertised method ever
 * emits a malformed envelope. (`world.join` actually connects, so it is proven
 * by the real boot rather than replayed here.)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import WebSocket from "ws";
import Ajv from "ajv";
import type { TSchema } from "@sinclair/typebox";
import { RESULT_SCHEMAS, McptErrorResponse, MCTP_ERROR_CODES, type MethodName } from "@mc-test/protocol";
import { HeadlessDriver } from "../src/HeadlessDriver.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "..", "protocol", "fixtures", "conformance", "methods");

/** Methods the headless driver dispatches/advertises (its full surface, minus
 *  world.join which dials out — that is exercised by the real boot). */
const ADVERTISED = new Set<string>([
  "session.create",
  "session.describe",
  "session.ping",
  "session.close",
  "world.leave",
  "world.sendChat",
  "world.runCommand",
  "world.waitForChat",
  "screen.get",
  "screen.listElements",
  "screen.clickElement",
  "screen.typeText",
  "screen.pressKey",
  "screen.waitForScreen",
  "screen.close",
]);

interface Bundle {
  method: string;
  request: { params?: Record<string, unknown> };
}

const bundles: Bundle[] = readdirSync(fixturesDir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(fixturesDir, f), "utf8")) as Bundle)
  .filter((b) => ADVERTISED.has(b.method));

function validate(schema: TSchema, data: unknown): { ok: boolean; errors: unknown } {
  const ajv = new Ajv({ strict: false, allErrors: true });
  const fn = ajv.compile(schema as object);
  return { ok: fn(data) as boolean, errors: fn.errors };
}

const KNOWN_CODES = new Set<number>(Object.values(MCTP_ERROR_CODES));

describe("headless driver replays M1 golden conformance fixtures", () => {
  const driver = new HeadlessDriver();
  let url = "";
  let ws: WebSocket;
  let nextId = 1;

  beforeAll(async () => {
    ({ url } = await driver.start());
    await new Promise<void>((resolve, reject) => {
      ws = new WebSocket(url, ["mctp.v1"]);
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
  });

  afterAll(async () => {
    ws?.close();
    await driver.stop();
  });

  function rpc(method: string, params: Record<string, unknown>): Promise<{ id: number; result?: unknown; error?: { code: number } }> {
    const id = nextId++;
    return new Promise((resolve) => {
      const onMsg = (data: WebSocket.RawData): void => {
        const msg = JSON.parse(data.toString());
        if (msg.id === id) {
          ws.off("message", onMsg);
          resolve(msg);
        }
      };
      ws.on("message", onMsg);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  for (const b of bundles) {
    it(`${b.method}: golden request → schema-valid envelope`, async () => {
      const res = await rpc(b.method, b.request.params ?? {});
      if (res.error) {
        expect(KNOWN_CODES.has(res.error.code), `unknown code ${res.error.code}`).toBe(true);
        const v = validate(McptErrorResponse, { jsonrpc: "2.0", id: res.id, error: res.error });
        expect(v.ok, JSON.stringify(v.errors)).toBe(true);
      } else {
        const v = validate(RESULT_SCHEMAS[b.method as MethodName], {
          jsonrpc: "2.0",
          id: res.id,
          result: res.result,
        });
        expect(v.ok, JSON.stringify(v.errors)).toBe(true);
      }
    });
  }

  it("a golden fixture exists for every advertised method (minus world.join)", () => {
    const seen = new Set(bundles.map((b) => b.method));
    for (const m of ADVERTISED) {
      expect(seen.has(m), `no golden fixture replayed for advertised method ${m}`).toBe(true);
    }
  });
});
