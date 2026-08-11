/**
 * The headless driver's world-interaction half (cap `worldInteraction`): the pure
 * geometry/normalization helpers, and the wire wiring — every new `world.*`
 * method must be DISPATCHED (a `WORLD_NOT_READY` before join, never a
 * `METHOD_NOT_SUPPORTED`, which would mean the method was never routed at all).
 */
import { describe, it, expect, afterAll } from "vitest";
import WebSocket from "ws";
import { MCTP_ERROR_CODES, REQUEST_SCHEMAS } from "@mc-test/protocol";
import Ajv from "ajv";
import { HeadlessDriver } from "../src/HeadlessDriver.js";
import {
  FACE_NUMBERS,
  FACE_VECTORS,
  controlsToHold,
  faceCursor,
  normalizeItemId,
  toBlock,
  toHeldItem,
} from "../src/primitives/worldInteraction.js";

describe("face geometry", () => {
  it("each face normal points out of the block and matches its vanilla direction byte", () => {
    expect(FACE_VECTORS.north).toEqual({ x: 0, y: 0, z: -1 });
    expect(FACE_VECTORS.south).toEqual({ x: 0, y: 0, z: 1 });
    expect(FACE_VECTORS.east).toEqual({ x: 1, y: 0, z: 0 });
    expect(FACE_VECTORS.west).toEqual({ x: -1, y: 0, z: 0 });
    expect(FACE_VECTORS.up).toEqual({ x: 0, y: 1, z: 0 });
    expect(FACE_VECTORS.down).toEqual({ x: 0, y: -1, z: 0 });
    expect(FACE_NUMBERS).toEqual({ down: 0, up: 1, north: 2, south: 3, west: 4, east: 5 });
  });

  it("the cursor lands on the centre of the clicked face", () => {
    expect(faceCursor("north")).toEqual({ x: 0.5, y: 0.5, z: 0 });
    expect(faceCursor("south")).toEqual({ x: 0.5, y: 0.5, z: 1 });
    expect(faceCursor("up")).toEqual({ x: 0.5, y: 1, z: 0.5 });
    expect(faceCursor("west")).toEqual({ x: 0, y: 0.5, z: 0.5 });
    // Every face-centre component stays inside the 0..1 block-local box.
    for (const face of Object.keys(FACE_VECTORS) as (keyof typeof FACE_VECTORS)[]) {
      for (const v of Object.values(faceCursor(face))) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("item/block normalization", () => {
  it("strips the namespace and case when comparing item ids", () => {
    expect(normalizeItemId("minecraft:Oak_Sign")).toBe("oak_sign");
    expect(normalizeItemId("oak_sign")).toBe("oak_sign");
    expect(normalizeItemId("  chestshop:Sign ")).toBe("sign");
  });

  it("reports an empty hand as type:null, never as an omitted field", () => {
    expect(toHeldItem(null, 3)).toEqual({ type: null, slot: 3 });
    expect(toHeldItem({ name: "oak_sign", count: 16 }, 0)).toEqual({
      type: "minecraft:oak_sign",
      count: 16,
      slot: 0,
    });
  });

  it("renders block state properties as strings", () => {
    const block = {
      name: "oak_wall_sign",
      position: { x: 0, y: 0, z: 0 } as never,
      getProperties: () => ({ facing: "north", waterlogged: false }),
    };
    expect(toBlock(block)).toEqual({
      type: "minecraft:oak_wall_sign",
      properties: { facing: "north", waterlogged: "false" },
    });
  });
});

describe("control diffing", () => {
  it("only the controls a call switched ON are the ones it must release", () => {
    expect(controlsToHold({ forward: true, sneak: false, sprint: true })).toEqual(["forward", "sprint"]);
    expect(controlsToHold(undefined)).toEqual([]);
    expect(controlsToHold({})).toEqual([]);
  });
});

describe("wire dispatch (no boot)", () => {
  const driver = new HeadlessDriver();
  let ws: WebSocket;
  let nextId = 1;

  async function rpc(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<{ id: number; result?: unknown; error?: { code: number; data?: { reason?: string } } }> {
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

  const REQUESTS: Record<string, Record<string, unknown>> = {
    "world.useBlock": { pos: { x: 2, y: -60, z: 0 }, face: "north", sneak: true },
    "world.attackBlock": { pos: { x: 2, y: -60, z: 0 }, face: "up" },
    "world.setHeldItem": { item: "minecraft:oak_sign" },
    "world.look": { at: { x: 2.5, y: -59.5, z: 0.5 }, force: true },
    "world.move": { controls: { forward: true }, durationMs: 10 },
  };

  it("connects", async () => {
    const { url } = await driver.start();
    await new Promise<void>((resolve, reject) => {
      ws = new WebSocket(url, ["mctp.v1"]);
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
  });

  for (const [method, params] of Object.entries(REQUESTS)) {
    it(`${method} is dispatched (WORLD_NOT_READY before join, NOT method-not-supported)`, async () => {
      // The request itself must be schema-valid, so the fixture we send is the
      // same shape a runner would.
      const ajv = new Ajv({ strict: false, allErrors: true });
      const validate = ajv.compile(REQUEST_SCHEMAS[method as keyof typeof REQUEST_SCHEMAS] as object);
      expect(
        validate({ jsonrpc: "2.0", id: 1, method, params: { sessionId: "s_1", ...params } }),
        JSON.stringify(validate.errors),
      ).toBe(true);

      const res = await rpc(method, params);
      expect(res.error?.code, `${method} was not routed`).not.toBe(MCTP_ERROR_CODES.METHOD_NOT_SUPPORTED);
      expect(res.error?.code).toBe(MCTP_ERROR_CODES.WORLD_NOT_READY);
      expect(res.error?.data?.reason).toBe("WORLD_NOT_READY");
    });
  }
});
