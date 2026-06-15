/**
 * Shared TypeBox schema fragments used across the MCTP contract.
 *
 * TypeBox schemas are *plain JSON Schema objects at runtime* and simultaneously
 * yield a static TypeScript type via `Static<typeof X>`. This is why
 * `@mc-test/protocol` can guarantee the TS types and the published JSON Schema
 * never drift: they are the same object.
 */
import { Type } from "@sinclair/typebox";
import type { Static, TSchema, TProperties, ObjectOptions } from "@sinclair/typebox";

/** JSON-RPC 2.0 version literal — frozen by the transport contract. */
export const JsonRpcVersion = Type.Literal("2.0");
export type JsonRpcVersion = Static<typeof JsonRpcVersion>;

/**
 * JSON-RPC correlation id. MUST be a string (UUID) or an integer, never null
 * (PROTOCOL.md §3.1).
 */
export const JsonRpcId = Type.Union([Type.String(), Type.Integer()], {
  $id: undefined,
  description: "JSON-RPC correlation id (string or integer, never null).",
});
export type JsonRpcId = Static<typeof JsonRpcId>;

/** A world-space position. Coordinates are doubles. */
export const Vec3 = Type.Object(
  {
    x: Type.Number(),
    y: Type.Number(),
    z: Type.Number(),
  },
  { additionalProperties: false, description: "World-space position (doubles)." },
);
export type Vec3 = Static<typeof Vec3>;

/**
 * An arbitrary JSON value. Used for free-form payloads the protocol routes but
 * does not interpret (`fixture.set` args, `truth.assertPluginState` value, etc.).
 */
export const JsonValue = Type.Unknown();
export type JsonValue = Static<typeof JsonValue>;

/** A free-form by-name JSON object (e.g. command `args`, plugin-state `args`). */
export const JsonObject = Type.Record(Type.String(), Type.Unknown(), {
  description: "Free-form by-name JSON object.",
});
export type JsonObject = Static<typeof JsonObject>;

/** A strict object: no properties beyond those declared. */
export function Obj<T extends TProperties>(properties: T, options: ObjectOptions = {}) {
  return Type.Object(properties, { additionalProperties: false, ...options });
}

/**
 * Reserved common envelope metadata that ANY success `result` MAY carry
 * (PROTOCOL.md §3.5). Composed into every method result so it is uniformly legal.
 */
export const ResultMetaProps = {
  /** Convenience success flag; always `true` on a success response. */
  ok: Type.Optional(Type.Boolean()),
  /** The agent detected the active screen/window changed as a side effect. */
  screenChanged: Type.Optional(Type.Boolean()),
  /** Agent-side wall-clock the command consumed (excludes network), in ms. */
  tookMs: Type.Optional(Type.Number()),
  /** Game tick at which the command was applied (number if < 2^53, else string). */
  serverTick: Type.Optional(Type.Union([Type.Number(), Type.String()])),
  /** Non-fatal advisories. */
  warnings: Type.Optional(Type.Array(Type.String())),
} satisfies TProperties;

/** Build a method `result` schema: common envelope metadata + method-specific props. */
export function ResultObject<T extends TProperties>(properties: T, options: ObjectOptions = {}) {
  return Type.Object({ ...ResultMetaProps, ...properties }, {
    additionalProperties: false,
    ...options,
  });
}

/**
 * Common optional params accepted by EVERY command except `session.create`
 * (PROTOCOL.md §7): a per-call `timeoutMs` upper bound and a client trace tag.
 */
export const CommonParamProps = {
  /** Hard upper bound for the agent to complete this single primitive, in ms. */
  timeoutMs: Type.Optional(Type.Number()),
  /** Client-supplied idempotency/trace tag echoed in logs/artifacts. */
  requestId: Type.Optional(Type.String()),
} satisfies TProperties;

/** The opaque session token assigned by `session.create`. */
export const SessionId = Type.String({ description: "Opaque session token from session.create." });
export type SessionId = Static<typeof SessionId>;

/**
 * Build a stateful method `params` schema: required `sessionId`, the common
 * optional params, then the method-specific props.
 */
export function StatefulParams<T extends TProperties>(properties: T, options: ObjectOptions = {}) {
  return Type.Object({ sessionId: SessionId, ...CommonParamProps, ...properties }, {
    additionalProperties: false,
    ...options,
  });
}

export type { TSchema };
