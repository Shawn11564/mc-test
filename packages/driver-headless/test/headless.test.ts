/**
 * Headless driver tests: pure selector resolution + normalization, the
 * advertised capability set, and an MCTP wire-conformance check — every method
 * the driver advertises returns a SCHEMA-VALID envelope (a success or a
 * canonical MCTP error), validated against the M1 schemas. No Minecraft boot is
 * needed (methods needing a live bot return a valid WORLD_NOT_READY error).
 */
import { describe, it, expect, afterAll } from "vitest";
import WebSocket from "ws";
import Ajv from "ajv";
import type { TSchema } from "@sinclair/typebox";
import {
  RESULT_SCHEMAS,
  McptErrorResponse,
  MCTP_ERROR_CODES,
  type MethodName,
} from "@mc-test/protocol";
import { resolveSelector, type ResolvedElement } from "../src/primitives/selectorResolve.js";
import { normalize, flattenText, toPlainComponent } from "../src/normalize.js";
import { HEADLESS_CAPABILITY_KEYS } from "../src/capabilities.js";
import { HeadlessDriver } from "../src/HeadlessDriver.js";

// ---------- pure selector resolution ----------

const ROOT: ResolvedElement[] = [
  { slot: 4, elementId: "slot-4", label: "Regions", itemType: "minecraft:book", role: "button", testId: "regions:root:regions" },
  { slot: 8, elementId: "slot-8", label: "§7Close", itemType: "minecraft:barrier", role: "button" },
];

describe("normalize", () => {
  it("strips section codes, collapses whitespace, case-folds", () => {
    expect(normalize("§a§lRegions ")).toBe("regions");
    expect(normalize("  Regions   List ")).toBe("regions list");
  });
});

describe("flattenText", () => {
  it("unwraps the NBT-wrapped window title Mineflayer surfaces", () => {
    // Real shape observed from Paper 1.20.4 via Mineflayer.
    expect(flattenText('{"type":"string","value":"OpenRegions"}')).toBe("OpenRegions");
  });
  it("flattens a chat component with extra (item display name)", () => {
    expect(flattenText('{"text":"","extra":["Regions"]}')).toBe("Regions");
  });
  it("passes through a plain string", () => {
    expect(flattenText("TestRegion")).toBe("TestRegion");
  });
  it("flattens a 1.20.5+ NBT-tagged custom_name component (real Paper 1.21.1 shape)", () => {
    // prismarine-item surfaces item.customName as prismarine-nbt tags on MC 1.20.5+:
    // the visible text lives in extra[].text, nested under tagged list/compound nodes
    // the old flattener could not follow (it expected `extra` to be a plain JS array).
    const taggedName = {
      type: "compound",
      value: {
        text: { type: "string", value: "" },
        extra: {
          type: "list",
          value: {
            type: "compound",
            value: [
              { color: { type: "string", value: "green" }, text: { type: "string", value: "Regions" } },
            ],
          },
        },
      },
    };
    expect(flattenText(taggedName)).toBe("Regions");
  });
  it("simplifies a tagged lore list into independently-flattenable lines", () => {
    const taggedLore = {
      type: "list",
      value: {
        type: "compound",
        value: [
          { text: { type: "string", value: "Line one" } },
          { text: { type: "string", value: "Line two" } },
        ],
      },
    };
    const plain = toPlainComponent(taggedLore) as unknown[];
    expect(Array.isArray(plain)).toBe(true);
    expect(plain.map((l) => flattenText(l))).toEqual(["Line one", "Line two"]);
  });
});

describe("resolveSelector", () => {
  it("matches by exact label after normalization", () => {
    expect(resolveSelector({ label: "Regions" }, ROOT).matches.map((m) => m.slot)).toEqual([4]);
    expect(resolveSelector({ label: "close" }, ROOT).matches.map((m) => m.slot)).toEqual([8]);
  });
  it("matches by testId, itemType, and textContains", () => {
    expect(resolveSelector({ testId: "regions:root:regions" }, ROOT).matches.map((m) => m.slot)).toEqual([4]);
    expect(resolveSelector({ itemType: "book" }, ROOT).matches.map((m) => m.slot)).toEqual([4]);
    expect(resolveSelector({ textContains: "egio" }, ROOT).matches.map((m) => m.slot)).toEqual([4]);
  });
  it("returns no match for an absent label (drives ELEMENT_NOT_FOUND)", () => {
    expect(resolveSelector({ label: "Zones" }, ROOT).matches).toHaveLength(0);
  });
  it("disambiguates with nth", () => {
    const els: ResolvedElement[] = [
      { slot: 0, elementId: "a", label: "Row", role: "listItem" },
      { slot: 1, elementId: "b", label: "Row", role: "listItem" },
    ];
    expect(resolveSelector({ label: "Row", nth: 1 }, els).matches.map((m) => m.slot)).toEqual([1]);
    expect(resolveSelector({ label: "Row" }, els).matches).toHaveLength(2);
  });
});

describe("advertised capabilities", () => {
  it("advertises exactly chat/command/containerGui/typeText/pressKey", () => {
    expect([...HEADLESS_CAPABILITY_KEYS].sort()).toEqual(
      ["chat", "command", "containerGui", "pressKey", "typeText"].sort(),
    );
    for (const denied of ["screenshot", "clientScreens", "worldTruth", "pluginState", "fixtures"]) {
      expect(HEADLESS_CAPABILITY_KEYS).not.toContain(denied);
    }
  });
});

// ---------- MCTP wire conformance ----------

function validate(schema: TSchema, data: unknown): { ok: boolean; errors: unknown } {
  const ajv = new Ajv({ strict: false, allErrors: true });
  const fn = ajv.compile(schema as object);
  return { ok: fn(data) as boolean, errors: fn.errors };
}

const KNOWN_CODES = new Set<number>(Object.values(MCTP_ERROR_CODES));

describe("MCTP conformance (no boot)", () => {
  const driver = new HeadlessDriver();
  let url = "";
  let ws: WebSocket;
  let nextId = 1;

  async function rpc(method: string, params: Record<string, unknown> = {}): Promise<{ id: number; result?: unknown; error?: { code: number } }> {
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

  afterAll(async () => {
    ws?.close();
    await driver.stop();
  });

  it("starts and accepts the mctp.v1 sub-protocol", async () => {
    ({ url } = await driver.start());
    await new Promise<void>((resolve, reject) => {
      ws = new WebSocket(url, ["mctp.v1"]);
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    expect(url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/mctp$/);
  });

  it("session.describe returns a schema-valid result advertising the 5 caps", async () => {
    const res = await rpc("session.describe");
    const v = validate(RESULT_SCHEMAS["session.describe"], { jsonrpc: "2.0", id: res.id, result: res.result });
    expect(v.ok, JSON.stringify(v.errors)).toBe(true);
    expect((res.result as { capabilities: string[] }).capabilities.sort()).toEqual(
      ["chat", "command", "containerGui", "pressKey", "typeText"].sort(),
    );
  });

  it("session.create succeeds for advertised caps (schema-valid)", async () => {
    const res = await rpc("session.create", {
      protocolVersion: "1.0",
      client: { name: "test", version: "0", lang: "ts" },
      requiredCapabilities: ["command", "containerGui"],
      constraints: { mcVersionRange: "1.20.4", loader: "paper" },
    });
    const v = validate(RESULT_SCHEMAS["session.create"], { jsonrpc: "2.0", id: res.id, result: res.result });
    expect(v.ok, JSON.stringify(v.errors)).toBe(true);
  });

  it("session.create refuses an unadvertised cap with -32002 + unmet[]", async () => {
    const res = await rpc("session.create", {
      protocolVersion: "1.0",
      client: { name: "test", version: "0", lang: "ts" },
      requiredCapabilities: ["pluginState"],
    });
    expect(res.error?.code).toBe(MCTP_ERROR_CODES.METHOD_NOT_SUPPORTED);
    const v = validate(McptErrorResponse, { jsonrpc: "2.0", id: res.id, error: res.error });
    expect(v.ok, JSON.stringify(v.errors)).toBe(true);
    expect((res.error as unknown as { data: { unmet: string[] } }).data.unmet).toEqual(["pluginState"]);
  });

  it("advertised screen/world methods return schema-valid envelopes pre-join", async () => {
    // Not joined → these return a valid WORLD_NOT_READY error (a conformant envelope).
    for (const method of ["screen.get", "world.waitForChat"] as MethodName[]) {
      const res = await rpc(method, { timeoutMs: 200 });
      if (res.error) {
        expect(KNOWN_CODES.has(res.error.code)).toBe(true);
        const v = validate(McptErrorResponse, { jsonrpc: "2.0", id: res.id, error: res.error });
        expect(v.ok, JSON.stringify(v.errors)).toBe(true);
      } else {
        const v = validate(RESULT_SCHEMAS[method], { jsonrpc: "2.0", id: res.id, result: res.result });
        expect(v.ok, JSON.stringify(v.errors)).toBe(true);
      }
    }
  });

  it("unadvertised methods (truth.*) return METHOD_NOT_SUPPORTED", async () => {
    const res = await rpc("truth.getWorldBlock", { x: 0, y: 64, z: 0 });
    expect(res.error?.code).toBe(MCTP_ERROR_CODES.METHOD_NOT_SUPPORTED);
  });
});
