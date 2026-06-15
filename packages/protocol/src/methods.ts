/**
 * The MCTP method/event registry: the canonical name unions, the compile-time
 * `params`/`result` type map, and the runtime schema registries used by the
 * schema generator and the conformance-fixture validator.
 *
 * This is the one place that enumerates the complete wire surface. Adding a
 * method means adding it here (and to `mctp.ts`); the generator and fixtures
 * derive from these registries, so nothing can be silently half-wired.
 */
import { Type } from "@sinclair/typebox";
import type { TSchema } from "@sinclair/typebox";
import { JsonRpcVersion, JsonRpcId } from "./common.js";
import * as M from "./mctp.js";

// ---------------------------------------------------------------------------
// Canonical name lists (the complete M1 surface — PROTOCOL.md §13)
// ---------------------------------------------------------------------------

/** Every request method, in canonical order. */
export const METHOD_NAMES = [
  // session & lifecycle
  "session.create",
  "session.describe",
  "session.close",
  "session.ping",
  // world entry
  "world.join",
  "world.leave",
  "world.sendChat",
  "world.runCommand",
  "world.waitForChat",
  // screen / GUI primitives
  "screen.get",
  "screen.listElements",
  "screen.clickElement",
  "screen.typeText",
  "screen.pressKey",
  "screen.screenshot",
  "screen.waitForScreen",
  "screen.close",
  // world-truth
  "truth.getWorldBlock",
  "truth.getEntities",
  "truth.assertPluginState",
  // fixtures & doubles
  "fixture.set",
  "fixture.reset",
  "player.spawnFake",
  "player.despawnFake",
] as const;

export type MethodName = (typeof METHOD_NAMES)[number];

/** Every event notification, in canonical order. */
export const EVENT_NAMES = [
  "event.chat",
  "event.screenChanged",
  "event.log",
  "event.disconnected",
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

// ---------------------------------------------------------------------------
// Compile-time params/result type map: MctpMethods[name] = { params; result }
// ---------------------------------------------------------------------------

export interface MctpMethods {
  "session.create": { params: M.SessionCreateParams; result: M.SessionCreateResult };
  "session.describe": { params: M.SessionDescribeParams; result: M.SessionDescribeResult };
  "session.close": { params: M.SessionCloseParams; result: M.SessionCloseResult };
  "session.ping": { params: M.SessionPingParams; result: M.SessionPingResult };
  "world.join": { params: M.WorldJoinParams; result: M.WorldJoinResult };
  "world.leave": { params: M.WorldLeaveParams; result: M.WorldLeaveResult };
  "world.sendChat": { params: M.WorldSendChatParams; result: M.WorldSendChatResult };
  "world.runCommand": { params: M.WorldRunCommandParams; result: M.WorldRunCommandResult };
  "world.waitForChat": { params: M.WorldWaitForChatParams; result: M.WorldWaitForChatResult };
  "screen.get": { params: M.ScreenGetParams; result: M.ScreenGetResult };
  "screen.listElements": { params: M.ScreenListElementsParams; result: M.ScreenListElementsResult };
  "screen.clickElement": { params: M.ScreenClickElementParams; result: M.ScreenClickElementResult };
  "screen.typeText": { params: M.ScreenTypeTextParams; result: M.ScreenTypeTextResult };
  "screen.pressKey": { params: M.ScreenPressKeyParams; result: M.ScreenPressKeyResult };
  "screen.screenshot": { params: M.ScreenScreenshotParams; result: M.ScreenScreenshotResult };
  "screen.waitForScreen": {
    params: M.ScreenWaitForScreenParams;
    result: M.ScreenWaitForScreenResult;
  };
  "screen.close": { params: M.ScreenCloseParams; result: M.ScreenCloseResult };
  "truth.getWorldBlock": { params: M.TruthGetWorldBlockParams; result: M.TruthGetWorldBlockResult };
  "truth.getEntities": { params: M.TruthGetEntitiesParams; result: M.TruthGetEntitiesResult };
  "truth.assertPluginState": {
    params: M.TruthAssertPluginStateParams;
    result: M.TruthAssertPluginStateResult;
  };
  "fixture.set": { params: M.FixtureSetParams; result: M.FixtureSetResult };
  "fixture.reset": { params: M.FixtureResetParams; result: M.FixtureResetResult };
  "player.spawnFake": { params: M.PlayerSpawnFakeParams; result: M.PlayerSpawnFakeResult };
  "player.despawnFake": { params: M.PlayerDespawnFakeParams; result: M.PlayerDespawnFakeResult };
}

/** Params type for a given method. */
export type ParamsOf<N extends MethodName> = MctpMethods[N]["params"];
/** Result type for a given method. */
export type ResultOf<N extends MethodName> = MctpMethods[N]["result"];

/** Compile-time map of event name → notification `params` / `data` types. */
export interface MctpEvents {
  "event.chat": { params: M.EventChatParams; data: M.EventChatData };
  "event.screenChanged": { params: M.EventScreenChangedParams; data: M.EventScreenChangedData };
  "event.log": { params: M.EventLogParams; data: M.EventLogData };
  "event.disconnected": { params: M.EventDisconnectedParams; data: M.EventDisconnectedData };
}

// ---------------------------------------------------------------------------
// Runtime schema registry (the same TypeBox objects that yield the types above)
// ---------------------------------------------------------------------------

export interface MethodSchemaEntry {
  params: TSchema;
  result: TSchema;
  /** `true` if the request `params` may be omitted entirely. */
  paramsOptional: boolean;
}

/** method name → { params, result } TypeBox schemas. */
export const METHOD_SCHEMAS: Record<MethodName, MethodSchemaEntry> = {
  "session.create": { params: M.SessionCreateParams, result: M.SessionCreateResult, paramsOptional: false },
  "session.describe": { params: M.SessionDescribeParams, result: M.SessionDescribeResult, paramsOptional: true },
  "session.close": { params: M.SessionCloseParams, result: M.SessionCloseResult, paramsOptional: false },
  "session.ping": { params: M.SessionPingParams, result: M.SessionPingResult, paramsOptional: true },
  "world.join": { params: M.WorldJoinParams, result: M.WorldJoinResult, paramsOptional: false },
  "world.leave": { params: M.WorldLeaveParams, result: M.WorldLeaveResult, paramsOptional: false },
  "world.sendChat": { params: M.WorldSendChatParams, result: M.WorldSendChatResult, paramsOptional: false },
  "world.runCommand": { params: M.WorldRunCommandParams, result: M.WorldRunCommandResult, paramsOptional: false },
  "world.waitForChat": { params: M.WorldWaitForChatParams, result: M.WorldWaitForChatResult, paramsOptional: false },
  "screen.get": { params: M.ScreenGetParams, result: M.ScreenGetResult, paramsOptional: false },
  "screen.listElements": { params: M.ScreenListElementsParams, result: M.ScreenListElementsResult, paramsOptional: false },
  "screen.clickElement": { params: M.ScreenClickElementParams, result: M.ScreenClickElementResult, paramsOptional: false },
  "screen.typeText": { params: M.ScreenTypeTextParams, result: M.ScreenTypeTextResult, paramsOptional: false },
  "screen.pressKey": { params: M.ScreenPressKeyParams, result: M.ScreenPressKeyResult, paramsOptional: false },
  "screen.screenshot": { params: M.ScreenScreenshotParams, result: M.ScreenScreenshotResult, paramsOptional: false },
  "screen.waitForScreen": { params: M.ScreenWaitForScreenParams, result: M.ScreenWaitForScreenResult, paramsOptional: false },
  "screen.close": { params: M.ScreenCloseParams, result: M.ScreenCloseResult, paramsOptional: false },
  "truth.getWorldBlock": { params: M.TruthGetWorldBlockParams, result: M.TruthGetWorldBlockResult, paramsOptional: false },
  "truth.getEntities": { params: M.TruthGetEntitiesParams, result: M.TruthGetEntitiesResult, paramsOptional: false },
  "truth.assertPluginState": { params: M.TruthAssertPluginStateParams, result: M.TruthAssertPluginStateResult, paramsOptional: false },
  "fixture.set": { params: M.FixtureSetParams, result: M.FixtureSetResult, paramsOptional: false },
  "fixture.reset": { params: M.FixtureResetParams, result: M.FixtureResetResult, paramsOptional: false },
  "player.spawnFake": { params: M.PlayerSpawnFakeParams, result: M.PlayerSpawnFakeResult, paramsOptional: false },
  "player.despawnFake": { params: M.PlayerDespawnFakeParams, result: M.PlayerDespawnFakeResult, paramsOptional: false },
};

export interface EventSchemaEntry {
  params: TSchema;
  data: TSchema;
}

/** event name → { params, data } TypeBox schemas. */
export const EVENT_SCHEMAS: Record<EventName, EventSchemaEntry> = {
  "event.chat": { params: M.EventChatParams, data: M.EventChatData },
  "event.screenChanged": { params: M.EventScreenChangedParams, data: M.EventScreenChangedData },
  "event.log": { params: M.EventLogParams, data: M.EventLogData },
  "event.disconnected": { params: M.EventDisconnectedParams, data: M.EventDisconnectedData },
};

// ---------------------------------------------------------------------------
// Envelope schema builders (full request / success-response / notification)
// ---------------------------------------------------------------------------

/** Build a per-method request envelope schema. */
export function buildRequestSchema(method: string, params: TSchema, paramsOptional: boolean): TSchema {
  return Type.Object(
    {
      jsonrpc: JsonRpcVersion,
      id: JsonRpcId,
      method: Type.Literal(method),
      params: paramsOptional ? Type.Optional(params) : params,
    },
    { additionalProperties: false, description: `MCTP request: ${method}` },
  );
}

/** Build a per-method success-response envelope schema. */
export function buildResultSchema(method: string, result: TSchema): TSchema {
  return Type.Object(
    {
      jsonrpc: JsonRpcVersion,
      id: JsonRpcId,
      result,
    },
    { additionalProperties: false, description: `MCTP success response: ${method}` },
  );
}

/** Build a per-event notification envelope schema. */
export function buildNotificationSchema(event: string, params: TSchema): TSchema {
  return Type.Object(
    {
      jsonrpc: JsonRpcVersion,
      method: Type.Literal(event),
      params,
    },
    { additionalProperties: false, description: `MCTP notification: ${event}` },
  );
}

/** Per-method full request envelope schemas, keyed by method name. */
export const REQUEST_SCHEMAS: Record<MethodName, TSchema> = Object.fromEntries(
  METHOD_NAMES.map((name) => {
    const entry = METHOD_SCHEMAS[name];
    return [name, buildRequestSchema(name, entry.params, entry.paramsOptional)];
  }),
) as Record<MethodName, TSchema>;

/** Per-method full success-response envelope schemas, keyed by method name. */
export const RESULT_SCHEMAS: Record<MethodName, TSchema> = Object.fromEntries(
  METHOD_NAMES.map((name) => [name, buildResultSchema(name, METHOD_SCHEMAS[name].result)]),
) as Record<MethodName, TSchema>;

/** Per-event full notification envelope schemas, keyed by event name. */
export const NOTIFICATION_SCHEMAS: Record<EventName, TSchema> = Object.fromEntries(
  EVENT_NAMES.map((name) => [name, buildNotificationSchema(name, EVENT_SCHEMAS[name].params)]),
) as Record<EventName, TSchema>;

/** Type guard: is `name` a canonical method name? */
export function isMethodName(name: string): name is MethodName {
  return (METHOD_NAMES as readonly string[]).includes(name);
}

/** Type guard: is `name` a canonical event name? */
export function isEventName(name: string): name is EventName {
  return (EVENT_NAMES as readonly string[]).includes(name);
}
