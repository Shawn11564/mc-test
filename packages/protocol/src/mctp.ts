/**
 * MCTP envelopes, error model, shared runtime shapes, and the params/result
 * schema for every canonical method + event.
 *
 * This is the TypeScript + JSON-Schema source of truth for the wire vocabulary
 * (PROTOCOL.md is the authoritative prose spec; every spelling here matches it).
 * Each `*Params` / `*Result` is a TypeBox schema (a runtime JSON-Schema object)
 * paired with a `Static<>` TypeScript type of the same name.
 */
import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";
import {
  JsonRpcVersion,
  JsonRpcId,
  Vec3,
  JsonValue,
  JsonObject,
  Obj,
  ResultObject,
  StatefulParams,
  SessionId,
} from "./common.js";
import { Selector, SelectorRole } from "./selectors.js";
import { LoaderSchema } from "./capabilities.js";

// ===========================================================================
// 1. Error model (PROTOCOL.md §9)
// ===========================================================================

/** Numeric JSON-RPC error codes — standard range + the MCTP reserved block. */
export const MCTP_ERROR_CODES = {
  // JSON-RPC standard
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // MCTP reserved (-32000 … -32099)
  ELEMENT_NOT_FOUND: -32000,
  AMBIGUOUS_SELECTOR: -32001,
  METHOD_NOT_SUPPORTED: -32002,
  TIMEOUT: -32003,
  WORLD_NOT_READY: -32004,
  FIXTURE_FAILED: -32005,
  ASSERT_FAILED: -32006,
  PROTOCOL_VERSION_UNSUPPORTED: -32099,
} as const;

export type MctpErrorCode = (typeof MCTP_ERROR_CODES)[keyof typeof MCTP_ERROR_CODES];

/** Stable machine reason token mirroring each numeric code. Clients branch on this. */
export const ERROR_REASON_BY_CODE = {
  [-32700]: "parseError",
  [-32600]: "invalidRequest",
  [-32601]: "methodNotFound",
  [-32602]: "invalidParams",
  [-32603]: "internalError",
  [-32000]: "ELEMENT_NOT_FOUND",
  [-32001]: "AMBIGUOUS_SELECTOR",
  [-32002]: "METHOD_NOT_SUPPORTED",
  [-32003]: "TIMEOUT",
  [-32004]: "WORLD_NOT_READY",
  [-32005]: "FIXTURE_FAILED",
  [-32006]: "ASSERT_FAILED",
  [-32099]: "PROTOCOL_VERSION_UNSUPPORTED",
} as const satisfies Record<MctpErrorCode, string>;

export type MctpErrorReason = (typeof ERROR_REASON_BY_CODE)[keyof typeof ERROR_REASON_BY_CODE];

/**
 * Runner-level skip reason (NOT a wire error code): emitted when no configured
 * driver can satisfy a test's required capabilities. Carries `unmet[]`.
 */
export const NO_COMPATIBLE_DRIVER = "NO_COMPATIBLE_DRIVER" as const;
export type NoCompatibleDriver = typeof NO_COMPATIBLE_DRIVER;

/** The structured `error.data` MCTP standardizes (free-form beyond these keys). */
export const McptErrorData = Type.Object(
  {
    /** Stable machine token; mirrors the numeric code. */
    reason: Type.Optional(Type.String()),
    /** `true` if the same request might succeed on retry. */
    retryable: Type.Optional(Type.Boolean()),
    /** Free-form, error-specific context (selector, screenId, constraint, …). */
    details: Type.Optional(JsonObject),
    sessionId: Type.Optional(Type.String()),
    requestId: Type.Optional(Type.String()),
    /** Negotiation refusal: required capabilities the agent lacks. */
    unmet: Type.Optional(Type.Array(Type.String())),
    /** Negotiation refusal: capabilities the agent does offer. */
    offered: Type.Optional(Type.Array(Type.String())),
  },
  {
    // Error data carries error-specific context inline (e.g. selector, candidates).
    additionalProperties: true,
    description: "Structured MCTP error data (PROTOCOL.md §9.1).",
  },
);
export type McptErrorData = Static<typeof McptErrorData>;

/** A JSON-RPC 2.0 error object with MCTP-standardized `data`. */
export const McptErrorObject = Obj(
  {
    code: Type.Integer(),
    message: Type.String(),
    data: Type.Optional(McptErrorData),
  },
  { description: "JSON-RPC 2.0 error object." },
);
export type McptErrorObject = Static<typeof McptErrorObject>;

// ===========================================================================
// 2. Shared runtime shapes (elements, screens, entities, blocks, chat)
// ===========================================================================

/** Element bounds in GUI-space pixels (diagnostic only; client/pixel drivers). */
export const Bounds = Obj({
  x: Type.Integer(),
  y: Type.Integer(),
  w: Type.Integer(),
  h: Type.Integer(),
});
export type Bounds = Static<typeof Bounds>;

/** A normalized UI element returned by `screen.get` / `screen.listElements`. */
export const Element = Obj(
  {
    /** Ephemeral handle valid for this snapshot. */
    elementId: Type.String(),
    role: Type.Optional(SelectorRole),
    /** Color-stripped primary name (compared via normalization in the runner). */
    label: Type.Optional(Type.String()),
    text: Type.Optional(Type.String()),
    /** Untouched runtime string (for reports/screenshots). */
    rawLabel: Type.Optional(Type.String()),
    /** Non-lore secondary visible text (for `textContains`). */
    bodyText: Type.Optional(Type.String()),
    lore: Type.Optional(Type.Array(Type.String())),
    itemType: Type.Optional(Type.String()),
    testId: Type.Optional(Type.String()),
    /** Slot index (container GUIs). */
    slot: Type.Optional(Type.Integer()),
    /** GUI-space bounds (client screens / pixel). */
    bounds: Type.Optional(Bounds),
    screenId: Type.Optional(Type.String()),
    /** Document order within the current screen/container. */
    index: Type.Optional(Type.Integer()),
    enabled: Type.Optional(Type.Boolean()),
    visible: Type.Optional(Type.Boolean()),
    /** Driver-native opaque handle for the click primitive. */
    ref: Type.Optional(Type.String()),
  },
  { description: "Normalized UI element descriptor." },
);
export type Element = Static<typeof Element>;

/** The active screen/window kind. */
export const ScreenKind = Type.Union(
  [
    Type.Literal("containerGui"),
    Type.Literal("clientScreen"),
    Type.Literal("hud"),
    Type.Literal("none"),
  ],
  { description: "Active screen kind." },
);
export type ScreenKind = Static<typeof ScreenKind>;

/** A snapshot of the active screen/GUI as a normalized element list. */
export const ScreenSnapshot = Obj(
  {
    /** Stable id for the current screen, or `null` when not derivable. */
    screenId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    kind: ScreenKind,
    title: Type.Optional(Type.String()),
    titleRaw: Type.Optional(Type.String()),
    size: Type.Optional(Obj({ rows: Type.Integer(), cols: Type.Integer() })),
    elements: Type.Array(Element),
  },
  { description: "Active-screen snapshot." },
);
export type ScreenSnapshot = Static<typeof ScreenSnapshot>;

/**
 * The concrete element a selector resolved to (the `resolved` audit trail in
 * `screen.clickElement` results): which key matched + the driver-native target.
 */
export const ElementRef = Obj(
  {
    /** Which selector key actually matched (audit trail). */
    via: Type.String(),
    /** Concrete slot chosen (container GUIs). */
    slot: Type.Optional(Type.Integer()),
    /** Concrete widget chosen (client screens). */
    widgetId: Type.Optional(Type.String()),
    screenId: Type.Optional(Type.String()),
  },
  { description: "Resolved element reference (diagnostics)." },
);
export type ElementRef = Static<typeof ElementRef>;

/** An entity returned by `truth.getEntities` (server truth). */
export const Entity = Obj(
  {
    id: Type.String(),
    uuid: Type.Optional(Type.String()),
    type: Type.String(),
    name: Type.Optional(Type.String()),
    position: Vec3,
    tags: Type.Optional(Type.Array(Type.String())),
    customNameRaw: Type.Optional(Type.String()),
  },
  { description: "Authoritative entity descriptor." },
);
export type Entity = Static<typeof Entity>;

/** Authoritative block state returned by `truth.getWorldBlock`. */
export const Block = Obj(
  {
    type: Type.String(),
    properties: Type.Optional(JsonObject),
    nbtJson: Type.Optional(Type.String()),
    biome: Type.Optional(Type.String()),
  },
  { description: "Authoritative block state." },
);
export type Block = Static<typeof Block>;

/** A chat channel an inbound line arrived on. */
export const ChatChannel = Type.Union([
  Type.Literal("system"),
  Type.Literal("chat"),
  Type.Literal("actionBar"),
  Type.Literal("gameInfo"),
]);
export type ChatChannel = Static<typeof ChatChannel>;

/** A captured chat line. */
export const ChatLine = Obj({
  text: Type.String(),
  rawJson: Type.Optional(Type.String()),
  sender: Type.Optional(Type.String()),
  channel: Type.Optional(ChatChannel),
});
export type ChatLine = Static<typeof ChatLine>;

// ===========================================================================
// 3. Shared enums for method params
// ===========================================================================

const ClientLang = Type.Union([
  Type.Literal("ts"),
  Type.Literal("java"),
  Type.Literal("kotlin"),
  Type.Literal("other"),
]);

const AgentKind = Type.Union([
  Type.Literal("headlessBot"),
  Type.Literal("clientMod"),
  Type.Literal("serverPlugin"),
  Type.Literal("serverMod"),
  Type.Literal("pixelOcr"),
]);

const AuthMode = Type.Union([Type.Literal("offline"), Type.Literal("microsoft")]);
const ClickButton = Type.Union([
  Type.Literal("left"),
  Type.Literal("right"),
  Type.Literal("middle"),
]);
const ClickType = Type.Union([
  Type.Literal("single"),
  Type.Literal("double"),
  Type.Literal("shift"),
  Type.Literal("hold"),
]);
const KeyAction = Type.Union([Type.Literal("press"), Type.Literal("down"), Type.Literal("up")]);
const ScreenshotReturn = Type.Union([Type.Literal("inline"), Type.Literal("ref")]);
const ScreenshotRegion = Type.Union([Type.Literal("screen"), Type.Literal("gui")]);
const ScreenChange = Type.Union([
  Type.Literal("opened"),
  Type.Literal("closed"),
  Type.Literal("replaced"),
]);

// ===========================================================================
// 4. Generic envelopes (for the top-level schema files)
// ===========================================================================

/** A generic MCTP request envelope (any method). */
export const McptRequest = Obj(
  {
    jsonrpc: JsonRpcVersion,
    id: JsonRpcId,
    method: Type.String(),
    params: Type.Optional(JsonObject),
  },
  { description: "Generic MCTP JSON-RPC request envelope." },
);
export type McptRequest = Static<typeof McptRequest>;

/** A generic MCTP success response envelope. */
export const McptSuccessResponse = Obj(
  {
    jsonrpc: JsonRpcVersion,
    id: JsonRpcId,
    result: JsonObject,
  },
  { description: "Generic MCTP success response envelope." },
);
export type McptSuccessResponse = Static<typeof McptSuccessResponse>;

/** A generic MCTP error response envelope. */
export const McptErrorResponse = Obj(
  {
    jsonrpc: JsonRpcVersion,
    id: JsonRpcId,
    error: McptErrorObject,
  },
  { description: "Generic MCTP error response envelope." },
);
export type McptErrorResponse = Static<typeof McptErrorResponse>;

/** Either flavour of response. */
export const McptResponse = Type.Union([McptSuccessResponse, McptErrorResponse], {
  description: "Generic MCTP response envelope (success or error).",
});
export type McptResponse = Static<typeof McptResponse>;

/** A generic MCTP event notification envelope (no `id`). */
export const McptNotification = Obj(
  {
    jsonrpc: JsonRpcVersion,
    method: Type.String(),
    params: Type.Optional(JsonObject),
  },
  { description: "Generic MCTP event notification envelope (no id)." },
);
export type McptNotification = Static<typeof McptNotification>;

// ===========================================================================
// 5. Method params & results
// ===========================================================================

// --- session.* -------------------------------------------------------------

export const SessionCreateParams = Obj({
  protocolVersion: Type.String(),
  client: Obj({ name: Type.String(), version: Type.String(), lang: ClientLang }),
  requiredCapabilities: Type.Array(Type.String()),
  optionalCapabilities: Type.Optional(Type.Array(Type.String())),
  constraints: Type.Optional(
    Obj({
      mcVersionRange: Type.Optional(Type.String()),
      loader: Type.Optional(LoaderSchema),
      worldId: Type.Optional(Type.String()),
    }),
  ),
  connection: Type.Optional(
    Obj({
      maxFrameBytes: Type.Optional(Type.Integer()),
      eventBufferSize: Type.Optional(Type.Integer()),
      defaultTimeoutMs: Type.Optional(Type.Integer()),
      locale: Type.Optional(Type.String()),
    }),
  ),
});
export type SessionCreateParams = Static<typeof SessionCreateParams>;

export const SessionCreateResult = ResultObject({
  sessionId: Type.String(),
  protocolVersion: Type.String(),
  agent: Obj({
    name: Type.String(),
    version: Type.String(),
    kind: AgentKind,
    lang: Type.Optional(ClientLang),
  }),
  target: Obj({
    minecraft: Type.String(),
    protocolVersion: Type.Optional(Type.Integer()),
    loader: LoaderSchema,
    loaderVersion: Type.Optional(Type.String()),
    viaVersion: Type.Optional(Type.Boolean()),
  }),
  grantedCapabilities: Type.Array(Type.String()),
  deniedCapabilities: Type.Array(Type.String()),
  capabilityDetails: Type.Optional(JsonObject),
  limits: Type.Optional(
    Obj({
      maxFrameBytes: Type.Optional(Type.Integer()),
      maxConcurrentRequests: Type.Optional(Type.Integer()),
    }),
  ),
});
export type SessionCreateResult = Static<typeof SessionCreateResult>;

export const SessionDescribeParams = Obj({
  timeoutMs: Type.Optional(Type.Number()),
  requestId: Type.Optional(Type.String()),
});
export type SessionDescribeParams = Static<typeof SessionDescribeParams>;

export const SessionDescribeResult = ResultObject({
  protocolVersion: Type.String(),
  supportedProtocols: Type.Array(Type.String()),
  agent: Obj({ name: Type.String(), version: Type.String(), kind: AgentKind }),
  capabilities: Type.Array(Type.String()),
});
export type SessionDescribeResult = Static<typeof SessionDescribeResult>;

export const SessionCloseParams = StatefulParams({ reason: Type.Optional(Type.String()) });
export type SessionCloseParams = Static<typeof SessionCloseParams>;

export const SessionCloseResult = ResultObject({});
export type SessionCloseResult = Static<typeof SessionCloseResult>;

export const SessionPingParams = Obj({
  nonce: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),
  requestId: Type.Optional(Type.String()),
});
export type SessionPingParams = Static<typeof SessionPingParams>;

export const SessionPingResult = ResultObject({ nonce: Type.Optional(Type.String()) });
export type SessionPingResult = Static<typeof SessionPingResult>;

// --- world.* ---------------------------------------------------------------

export const WorldJoinParams = StatefulParams({
  /** Server socket — required for bot/client agents; ignored by server-side agents (PROTOCOL.md §7.1). */
  host: Type.Optional(Type.String()),
  port: Type.Optional(Type.Integer()),
  username: Type.Optional(Type.String()),
  auth: Type.Optional(AuthMode),
  world: Type.Optional(Type.String()),
  joinTimeoutMs: Type.Optional(Type.Integer()),
});
export type WorldJoinParams = Static<typeof WorldJoinParams>;

export const WorldJoinResult = ResultObject({
  playerName: Type.Optional(Type.String()),
  playerUuid: Type.Optional(Type.String()),
  dimension: Type.Optional(Type.String()),
  position: Type.Optional(Vec3),
  serverBrand: Type.Optional(Type.String()),
});
export type WorldJoinResult = Static<typeof WorldJoinResult>;

export const WorldLeaveParams = StatefulParams({ reason: Type.Optional(Type.String()) });
export type WorldLeaveParams = Static<typeof WorldLeaveParams>;

export const WorldLeaveResult = ResultObject({});
export type WorldLeaveResult = Static<typeof WorldLeaveResult>;

export const WorldSendChatParams = StatefulParams({ message: Type.String() });
export type WorldSendChatParams = Static<typeof WorldSendChatParams>;

export const WorldSendChatResult = ResultObject({});
export type WorldSendChatResult = Static<typeof WorldSendChatResult>;

export const WorldRunCommandParams = StatefulParams({
  command: Type.String(),
  args: Type.Optional(Type.Array(Type.String())),
  expectChat: Type.Optional(Type.Boolean()),
});
export type WorldRunCommandParams = Static<typeof WorldRunCommandParams>;

export const WorldRunCommandResult = ResultObject({ chat: Type.Optional(ChatLine) });
export type WorldRunCommandResult = Static<typeof WorldRunCommandResult>;

export const ChatFilter = Obj({
  contains: Type.Optional(Type.String()),
  regex: Type.Optional(Type.String()),
  channel: Type.Optional(ChatChannel),
  sender: Type.Optional(Type.String()),
});
export type ChatFilter = Static<typeof ChatFilter>;

export const WorldWaitForChatParams = StatefulParams({ filter: Type.Optional(ChatFilter) });
export type WorldWaitForChatParams = Static<typeof WorldWaitForChatParams>;

export const WorldWaitForChatResult = ResultObject({ chat: ChatLine });
export type WorldWaitForChatResult = Static<typeof WorldWaitForChatResult>;

// --- screen.* --------------------------------------------------------------

export const ScreenGetParams = StatefulParams({
  includeTree: Type.Optional(Type.Boolean()),
  includeInvisible: Type.Optional(Type.Boolean()),
});
export type ScreenGetParams = Static<typeof ScreenGetParams>;

export const ScreenGetResult = ResultObject({ screen: ScreenSnapshot });
export type ScreenGetResult = Static<typeof ScreenGetResult>;

export const ScreenListElementsParams = StatefulParams({
  selector: Type.Optional(Selector),
});
export type ScreenListElementsParams = Static<typeof ScreenListElementsParams>;

export const ScreenListElementsResult = ResultObject({
  count: Type.Integer(),
  elements: Type.Array(Element),
});
export type ScreenListElementsResult = Static<typeof ScreenListElementsResult>;

export const ScreenClickElementParams = StatefulParams({
  selector: Selector,
  button: Type.Optional(ClickButton),
  clickType: Type.Optional(ClickType),
  expectScreenChange: Type.Optional(Type.Boolean()),
});
export type ScreenClickElementParams = Static<typeof ScreenClickElementParams>;

export const ScreenClickElementResult = ResultObject({ resolved: Type.Optional(ElementRef) });
export type ScreenClickElementResult = Static<typeof ScreenClickElementResult>;

export const ScreenTypeTextParams = StatefulParams({
  text: Type.String(),
  selector: Type.Optional(Selector),
  clear: Type.Optional(Type.Boolean()),
  submit: Type.Optional(Type.Boolean()),
});
export type ScreenTypeTextParams = Static<typeof ScreenTypeTextParams>;

export const ScreenTypeTextResult = ResultObject({});
export type ScreenTypeTextResult = Static<typeof ScreenTypeTextResult>;

export const ScreenPressKeyParams = StatefulParams({
  key: Type.String(),
  action: Type.Optional(KeyAction),
  modifiers: Type.Optional(Type.Array(Type.String())),
});
export type ScreenPressKeyParams = Static<typeof ScreenPressKeyParams>;

export const ScreenPressKeyResult = ResultObject({});
export type ScreenPressKeyResult = Static<typeof ScreenPressKeyResult>;

export const ScreenshotImage = Obj({
  format: Type.String(),
  width: Type.Integer(),
  height: Type.Integer(),
  encoding: Type.Optional(Type.Literal("base64")),
  data: Type.Optional(Type.String()),
  ref: Type.Optional(Type.String()),
});
export type ScreenshotImage = Static<typeof ScreenshotImage>;

export const ScreenScreenshotParams = StatefulParams({
  format: Type.Optional(Type.Literal("png")),
  return: Type.Optional(ScreenshotReturn),
  region: Type.Optional(ScreenshotRegion),
  maxWidth: Type.Optional(Type.Integer()),
  maxHeight: Type.Optional(Type.Integer()),
});
export type ScreenScreenshotParams = Static<typeof ScreenScreenshotParams>;

export const ScreenScreenshotResult = ResultObject({ image: ScreenshotImage });
export type ScreenScreenshotResult = Static<typeof ScreenScreenshotResult>;

export const ScreenMatch = Obj({
  screenId: Type.Optional(Type.String()),
  screenIdPrefix: Type.Optional(Type.String()),
  kind: Type.Optional(ScreenKind),
  title: Type.Optional(Type.String()),
});
export type ScreenMatch = Static<typeof ScreenMatch>;

export const ScreenWaitForScreenParams = StatefulParams({
  match: Type.Optional(ScreenMatch),
  change: Type.Optional(ScreenChange),
});
export type ScreenWaitForScreenParams = Static<typeof ScreenWaitForScreenParams>;

export const ScreenWaitForScreenResult = ResultObject({ screen: ScreenSnapshot });
export type ScreenWaitForScreenResult = Static<typeof ScreenWaitForScreenResult>;

export const ScreenCloseParams = StatefulParams({});
export type ScreenCloseParams = Static<typeof ScreenCloseParams>;

export const ScreenCloseResult = ResultObject({});
export type ScreenCloseResult = Static<typeof ScreenCloseResult>;

// --- truth.* ---------------------------------------------------------------

export const TruthGetWorldBlockParams = StatefulParams({
  world: Type.Optional(Type.String()),
  x: Type.Integer(),
  y: Type.Integer(),
  z: Type.Integer(),
});
export type TruthGetWorldBlockParams = Static<typeof TruthGetWorldBlockParams>;

export const TruthGetWorldBlockResult = ResultObject({ block: Block });
export type TruthGetWorldBlockResult = Static<typeof TruthGetWorldBlockResult>;

export const TruthGetEntitiesParams = StatefulParams({
  world: Type.Optional(Type.String()),
  center: Type.Optional(Vec3),
  radius: Type.Optional(Type.Number()),
  type: Type.Optional(Type.String()),
});
export type TruthGetEntitiesParams = Static<typeof TruthGetEntitiesParams>;

export const TruthGetEntitiesResult = ResultObject({
  count: Type.Integer(),
  entities: Type.Array(Entity),
});
export type TruthGetEntitiesResult = Static<typeof TruthGetEntitiesResult>;

/** Predicate the agent evaluates against a plugin-state value (one comparator). */
export const ExpectPredicate = Obj({
  equals: Type.Optional(JsonValue),
  notEquals: Type.Optional(JsonValue),
  contains: Type.Optional(JsonValue),
  gt: Type.Optional(Type.Number()),
  gte: Type.Optional(Type.Number()),
  lt: Type.Optional(Type.Number()),
  lte: Type.Optional(Type.Number()),
  exists: Type.Optional(Type.Boolean()),
});
export type ExpectPredicate = Static<typeof ExpectPredicate>;

export const TruthAssertPluginStateParams = StatefulParams({
  plugin: Type.Optional(Type.String()),
  query: Type.String(),
  args: Type.Optional(JsonObject),
  expect: Type.Optional(ExpectPredicate),
});
export type TruthAssertPluginStateParams = Static<typeof TruthAssertPluginStateParams>;

export const TruthAssertPluginStateResult = ResultObject({
  query: Type.String(),
  value: JsonValue,
  matched: Type.Union([Type.Boolean(), Type.Null()]),
  valueJson: Type.Optional(Type.String()),
});
export type TruthAssertPluginStateResult = Static<typeof TruthAssertPluginStateResult>;

// --- fixture.* -------------------------------------------------------------

export const FixtureSetParams = StatefulParams({
  fixture: Type.String(),
  args: Type.Optional(JsonObject),
});
export type FixtureSetParams = Static<typeof FixtureSetParams>;

export const FixtureSetResult = ResultObject({
  fixture: Type.String(),
  applied: Type.Boolean(),
  handle: Type.Optional(Type.String()),
  result: Type.Optional(JsonObject),
});
export type FixtureSetResult = Static<typeof FixtureSetResult>;

export const FixtureResetParams = StatefulParams({
  snapshot: Type.Optional(Type.String()),
  world: Type.Optional(Type.String()),
  regenerate: Type.Optional(Type.Boolean()),
  handle: Type.Optional(Type.String()),
});
export type FixtureResetParams = Static<typeof FixtureResetParams>;

export const FixtureResetResult = ResultObject({ restored: Type.Optional(Type.String()) });
export type FixtureResetResult = Static<typeof FixtureResetResult>;

// --- player.* --------------------------------------------------------------

export const PlayerSpawnFakeParams = StatefulParams({
  name: Type.String(),
  at: Type.Optional(Vec3),
  gameMode: Type.Optional(Type.String()),
});
export type PlayerSpawnFakeParams = Static<typeof PlayerSpawnFakeParams>;

export const PlayerSpawnFakeResult = ResultObject({
  name: Type.String(),
  uuid: Type.Optional(Type.String()),
  handle: Type.Optional(Type.String()),
});
export type PlayerSpawnFakeResult = Static<typeof PlayerSpawnFakeResult>;

export const PlayerDespawnFakeParams = StatefulParams({
  handle: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
});
export type PlayerDespawnFakeParams = Static<typeof PlayerDespawnFakeParams>;

export const PlayerDespawnFakeResult = ResultObject({ despawned: Type.String() });
export type PlayerDespawnFakeResult = Static<typeof PlayerDespawnFakeResult>;

// ===========================================================================
// 6. Event (notification) payloads
// ===========================================================================

/** `event.chat` payload. */
export const EventChatData = ChatLine;
export type EventChatData = Static<typeof EventChatData>;

/** `event.screenChanged` payload. */
export const EventScreenChangedData = Obj({
  change: ScreenChange,
  screenId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  kind: ScreenKind,
  title: Type.Optional(Type.String()),
});
export type EventScreenChangedData = Static<typeof EventScreenChangedData>;

/** `event.log` payload. */
export const EventLogData = Obj({
  level: Type.String(),
  logger: Type.Optional(Type.String()),
  message: Type.String(),
  thread: Type.Optional(Type.String()),
  source: Type.Optional(Type.Union([Type.Literal("server"), Type.Literal("client")])),
});
export type EventLogData = Static<typeof EventLogData>;

/** `event.disconnected` payload. */
export const EventDisconnectedData = Obj({
  reason: Type.String(),
  code: Type.Optional(Type.Union([Type.Integer(), Type.String()])),
  graceful: Type.Optional(Type.Boolean()),
});
export type EventDisconnectedData = Static<typeof EventDisconnectedData>;

/** Build the `params` schema for a stream event (carries a `subscriptionId`). */
function streamEventParams<T extends ReturnType<typeof Obj>>(data: T) {
  return Obj({
    sessionId: SessionId,
    subscriptionId: Type.Optional(Type.String()),
    seq: Type.Optional(Type.Integer()),
    tsMs: Type.Optional(Type.Number()),
    data,
  });
}

export const EventChatParams = streamEventParams(EventChatData);
export type EventChatParams = Static<typeof EventChatParams>;

export const EventScreenChangedParams = streamEventParams(EventScreenChangedData);
export type EventScreenChangedParams = Static<typeof EventScreenChangedParams>;

export const EventLogParams = streamEventParams(EventLogData);
export type EventLogParams = Static<typeof EventLogParams>;

/** `event.disconnected` is a session-scoped lifecycle event — no `subscriptionId`. */
export const EventDisconnectedParams = Obj({
  sessionId: SessionId,
  seq: Type.Optional(Type.Integer()),
  tsMs: Type.Optional(Type.Number()),
  data: EventDisconnectedData,
});
export type EventDisconnectedParams = Static<typeof EventDisconnectedParams>;
