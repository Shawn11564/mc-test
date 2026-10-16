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
  BlockPos,
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

/**
 * One item stack as authoritative server truth (`truth.getContainer` /
 * `truth.getItem`).
 *
 * `type` + `count` are NOT an identity: two stacks of the same material differ by
 * their **data components** (custom name, lore, enchantments, custom model data,
 * mod-defined custom data). A modded item — a Cobblemon Poké Ball, a ChestShop
 * sign item, an ItemsAdder block — is a vanilla material plus components, so a
 * test that compares only `type` would call it equal to a plain one. `components`
 * carries the agent's canonical view of that data and `componentsHash` is its
 * stable digest: **item identity is `type` + `componentsHash`**, and comparing
 * hashes is how "this item only equals itself" is asserted.
 */
export const ItemStack = Obj(
  {
    type: Type.String(),
    count: Type.Integer(),
    /** Slot index within the container this stack was read from. */
    slot: Type.Optional(Type.Integer()),
    /** Color-stripped display name, when the stack has one. */
    displayName: Type.Optional(Type.String()),
    /** Untouched runtime display name (for reports). */
    displayNameRaw: Type.Optional(Type.String()),
    lore: Type.Optional(Type.Array(Type.String())),
    /**
     * The stack's data components, canonicalized by the agent (keys sorted, values
     * reduced to JSON scalars/arrays/objects). Absent means the agent cannot see
     * components at all — never "this stack has none"; an empty object means it
     * genuinely has none.
     */
    components: Type.Optional(JsonObject),
    /**
     * Stable digest over `type` + the canonical `components` form. Equal hashes ⇒
     * the agent saw identical stacks; different hashes ⇒ genuinely different items.
     */
    componentsHash: Type.Optional(Type.String()),
  },
  { description: "Authoritative item stack (identity = type + componentsHash)." },
);
export type ItemStack = Static<typeof ItemStack>;

/** Authoritative block state returned by `truth.getWorldBlock`. */
export const Block = Obj(
  {
    type: Type.String(),
    properties: Type.Optional(JsonObject),
    /**
     * The block entity's data as a JSON string, keyed by the vanilla NBT names
     * where the agent's API exposes the value (e.g. `front_text.messages`,
     * `CustomName`, `Items`). Absent = this block has no block entity, or the
     * agent cannot read it — never "the block entity is empty".
     */
    nbtJson: Type.Optional(Type.String()),
    /** The same block-entity data pre-parsed, so tests need not parse `nbtJson`. */
    nbt: Type.Optional(JsonObject),
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

/** The six faces of a block, as Minecraft names them. */
export const BlockFace = Type.Union(
  [
    Type.Literal("north"),
    Type.Literal("south"),
    Type.Literal("east"),
    Type.Literal("west"),
    Type.Literal("up"),
    Type.Literal("down"),
  ],
  { description: "Block face (interaction side)." },
);
export type BlockFace = Static<typeof BlockFace>;

/** Which hand an interaction uses. */
export const Hand = Type.Union([Type.Literal("main"), Type.Literal("off")], {
  description: "Interaction hand.",
});
export type Hand = Static<typeof Hand>;

/**
 * A held-item snapshot returned by the interaction verbs — `type: null` means an
 * empty hand (an honest "nothing held", never an omitted field the caller could
 * misread as "unchanged").
 */
export const HeldItem = Obj(
  {
    type: Type.Union([Type.String(), Type.Null()]),
    count: Type.Optional(Type.Integer()),
    /** Hotbar index (0–8) the item is selected from, for the main hand. */
    slot: Type.Optional(Type.Integer()),
    displayName: Type.Optional(Type.String()),
  },
  { description: "Held-item snapshot (type null = empty hand)." },
);
export type HeldItem = Static<typeof HeldItem>;

/** The movement controls a `world.move` call may hold (vanilla input axes). */
export const MoveControls = Obj(
  {
    forward: Type.Optional(Type.Boolean()),
    back: Type.Optional(Type.Boolean()),
    left: Type.Optional(Type.Boolean()),
    right: Type.Optional(Type.Boolean()),
    jump: Type.Optional(Type.Boolean()),
    sprint: Type.Optional(Type.Boolean()),
    sneak: Type.Optional(Type.Boolean()),
  },
  { description: "Primitive movement control states." },
);
export type MoveControls = Static<typeof MoveControls>;

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
  /**
   * Handshake auth (spec/42): when the agent is configured with a token
   * (`MCTEST_AGENT_TOKEN` env / bukkit `token:` config), `session.create`
   * requires `auth.token` to match — mismatch/absence is `-32602` and no
   * session is created. Agents with no token configured ignore this field.
   */
  auth: Type.Optional(Obj({ token: Type.String() })),
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

// --- world.* interaction (cap `worldInteraction`) ---------------------------
//
// The five primitives that let a test ACT on the world as the player, rather
// than only through GUIs and chat. Each performs exactly ONE observable action;
// waiting/retrying/asserting stays in the runner (PROTOCOL.md §7.2).

export const WorldUseBlockParams = StatefulParams({
  /** The block to interact with (its own grid cell, NOT the neighbour). */
  pos: BlockPos,
  /** Which face is clicked. Default `up`. */
  face: Type.Optional(BlockFace),
  /** Default `main`. */
  hand: Type.Optional(Hand),
  /**
   * Hold sneak for the interaction. Sneaking SUPPRESSES a block's own use
   * behavior (a chest does not open) and is what makes a held block/item place
   * against the clicked face — the canonical placement-test shape.
   */
  sneak: Type.Optional(Type.Boolean()),
  /**
   * Where on the face the cursor lands, in face-local 0..1 coordinates.
   * Omitted → the face centre.
   */
  cursor: Type.Optional(Vec3),
});
export type WorldUseBlockParams = Static<typeof WorldUseBlockParams>;

export const WorldUseBlockResult = ResultObject({
  /** The block that was clicked, as the agent saw it at click time. */
  block: Type.Optional(Block),
  face: Type.Optional(BlockFace),
  sneak: Type.Optional(Type.Boolean()),
  held: Type.Optional(HeldItem),
});
export type WorldUseBlockResult = Static<typeof WorldUseBlockResult>;

export const WorldAttackBlockParams = StatefulParams({
  pos: BlockPos,
  /** Which face is struck. Default `up`. */
  face: Type.Optional(BlockFace),
  /**
   * `false` (default) = one left-click "punch" (start + abort digging), the
   * primitive a protection/anti-grief SUT reacts to. `true` = dig the block to
   * completion. NOTE: in creative mode a punch breaks instantly — that is
   * vanilla behavior, not an agent liberty.
   */
  breakBlock: Type.Optional(Type.Boolean()),
});
export type WorldAttackBlockParams = Static<typeof WorldAttackBlockParams>;

export const WorldAttackBlockResult = ResultObject({
  block: Type.Optional(Block),
  face: Type.Optional(BlockFace),
  /** Whether the block was actually removed (agent-observed). */
  broken: Type.Optional(Type.Boolean()),
});
export type WorldAttackBlockResult = Static<typeof WorldAttackBlockResult>;

export const WorldSetHeldItemParams = StatefulParams({
  /**
   * Namespaced item id to hold, e.g. `minecraft:oak_sign`. The agent selects a
   * matching stack from the player's inventory; nothing matching →
   * `ELEMENT_NOT_FOUND` (never a silent empty hand).
   */
  item: Type.Optional(Type.String()),
  /** Hotbar index 0–8 to select instead of resolving by item id. */
  slot: Type.Optional(Type.Integer({ minimum: 0, maximum: 8 })),
  /** Default `main`. */
  hand: Type.Optional(Hand),
});
export type WorldSetHeldItemParams = Static<typeof WorldSetHeldItemParams>;

export const WorldSetHeldItemResult = ResultObject({ held: HeldItem });
export type WorldSetHeldItemResult = Static<typeof WorldSetHeldItemResult>;

export const WorldLookParams = StatefulParams({
  /** Absolute yaw in degrees (Minecraft convention). */
  yaw: Type.Optional(Type.Number()),
  /** Absolute pitch in degrees (−90 up … +90 down). */
  pitch: Type.Optional(Type.Number()),
  /** Look at a world-space point instead of explicit angles. */
  at: Type.Optional(Vec3),
  /** Snap instantly rather than rotating over several ticks. */
  force: Type.Optional(Type.Boolean()),
});
export type WorldLookParams = Static<typeof WorldLookParams>;

export const WorldLookResult = ResultObject({
  yaw: Type.Optional(Type.Number()),
  pitch: Type.Optional(Type.Number()),
  position: Type.Optional(Vec3),
});
export type WorldLookResult = Static<typeof WorldLookResult>;

export const WorldMoveParams = StatefulParams({
  /** Control states to apply. Omitted keys are left untouched. */
  controls: Type.Optional(MoveControls),
  /**
   * Hold the given controls this long, then release exactly the ones this call
   * set. Omitted → the controls stay held until a later `world.move`.
   */
  durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
  /** Release every control state (overrides `controls`). */
  stop: Type.Optional(Type.Boolean()),
});
export type WorldMoveParams = Static<typeof WorldMoveParams>;

export const WorldMoveResult = ResultObject({
  position: Type.Optional(Vec3),
  /** Control states still held when the call returned. */
  held: Type.Optional(Type.Array(Type.String())),
});
export type WorldMoveResult = Static<typeof WorldMoveResult>;

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

export const ScreenTypeTextResult = ResultObject({
  /**
   * Which input path actually consumed the text: `textField` (a real
   * `TextFieldWidget`/`EditBox`) or `screenCharTyped` (the screen-level fallback for
   * screens that own their editing and expose no text widget — the vanilla sign
   * editor). Reported so a run can never hide that a sign was typed through the
   * fallback; a `false` from BOTH paths is still `ELEMENT_NOT_FOUND`, never `ok`.
   */
  typedVia: Type.Optional(
    Type.Union([Type.Literal("textField"), Type.Literal("screenCharTyped")]),
  ),
});
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

export const TruthGetContainerParams = StatefulParams({
  world: Type.Optional(Type.String()),
  x: Type.Integer(),
  y: Type.Integer(),
  z: Type.Integer(),
  /** Include empty slots as `null` entries (default: only occupied slots). */
  includeEmpty: Type.Optional(Type.Boolean()),
});
export type TruthGetContainerParams = Static<typeof TruthGetContainerParams>;

export const TruthGetContainerResult = ResultObject({
  container: Obj({
    /** The container block's id, e.g. `minecraft:chest`. */
    type: Type.String(),
    /** Custom container name, when set. */
    title: Type.Optional(Type.String()),
    /** Total slot count of the inventory (including empty ones). */
    size: Type.Integer(),
    /** Number of occupied slots. */
    itemCount: Type.Integer(),
    slots: Type.Array(ItemStack),
  }),
});
export type TruthGetContainerResult = Static<typeof TruthGetContainerResult>;

export const TruthGetItemParams = StatefulParams({
  world: Type.Optional(Type.String()),
  x: Type.Integer(),
  y: Type.Integer(),
  z: Type.Integer(),
  /** Slot index within the container's inventory. */
  slot: Type.Integer({ minimum: 0 }),
});
export type TruthGetItemParams = Static<typeof TruthGetItemParams>;

export const TruthGetItemResult = ResultObject({
  slot: Type.Integer(),
  /** `null` for an empty slot — an explicit "nothing here", never an omitted field. */
  item: Type.Union([ItemStack, Type.Null()]),
});
export type TruthGetItemResult = Static<typeof TruthGetItemResult>;

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
  /**
   * `true` → the fake player joins the agent-global registry and SURVIVES
   * `session.close` / socket drop (spec/42 bench actors); it dies only on
   * `player.despawnFake`, the agent's in-game remove command, or server stop.
   * Persistent actors are addressable by `name` from ANY session. Default
   * `false` = today's session-scoped lifetime (released on close).
   */
  persist: Type.Optional(Type.Boolean()),
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

/**
 * The portable actor verbs `player.act` drives (spec/41 §5, minus join/leave —
 * those are `player.spawnFake`/`player.despawnFake`). A closed union, so a
 * typo'd verb is rejected by the schema instead of reaching the agent.
 */
export const PlayerActVerb = Type.Union(
  [
    Type.Literal("teleport"),
    Type.Literal("lookAt"),
    Type.Literal("chat"),
    Type.Literal("command"),
    Type.Literal("attack"),
    Type.Literal("interactEntity"),
    Type.Literal("interactBlock"),
    Type.Literal("clickMenuSlot"),
    Type.Literal("clickMenuText"),
    Type.Literal("give"),
    Type.Literal("hold"),
    Type.Literal("sneak"),
    Type.Literal("sprint"),
    Type.Literal("setGameMode"),
  ],
  { description: "Portable actor verb driven on a session-spawned fake player." },
);
export type PlayerActVerb = Static<typeof PlayerActVerb>;

export const PlayerActParams = StatefulParams({
  handle: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  verb: PlayerActVerb,
  args: Type.Optional(JsonObject),
});
export type PlayerActParams = Static<typeof PlayerActParams>;

export const PlayerActResult = ResultObject({
  handle: Type.String(),
  verb: Type.String(),
  /** Short human-readable outcome (e.g. the interaction's `ActionResult`). */
  detail: Type.Optional(Type.String()),
});
export type PlayerActResult = Static<typeof PlayerActResult>;

/**
 * One occupied slot of a fake player's open menu (`player.menu`, spec/42).
 * `slot` is the index the click protocol addresses — the number
 * `clickMenuSlot` takes. Empty slots are omitted, so a slot index the list
 * skips is an empty one.
 */
export const MenuSlot = Obj({
  slot: Type.Integer(),
  item: Type.String(),
  count: Type.Integer(),
  /** Display name as plain text — what the GUI actually shows. */
  name: Type.String(),
  lore: Type.Optional(Type.Array(Type.String())),
  /** The slot belongs to the player's own inventory rather than the container. */
  playerInventory: Type.Optional(Type.Boolean()),
});
export type MenuSlot = Static<typeof MenuSlot>;

/**
 * `player.menu` — read back the container menu an agent-owned fake player has
 * open. The point is addressing: a modded GUI (a PokeSteal steal menu, a
 * Cobblemon screen) is only clickable by slot index once you know its layout,
 * and this is how a controller learns it — or skips it entirely with the
 * `clickMenuText` verb, which matches the same text server-side.
 */
export const PlayerMenuParams = StatefulParams({
  handle: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
});
export type PlayerMenuParams = Static<typeof PlayerMenuParams>;

export const PlayerMenuResult = ResultObject({
  handle: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  /** False when the player is looking at the world or at its own inventory. */
  open: Type.Boolean(),
  /** Registry id of the menu, or the handler's class name for a modded GUI. */
  type: Type.Optional(Type.String()),
  /** Only agents whose runtime keeps the title (bukkit) report one. */
  title: Type.Optional(Type.String()),
  /** Total slots of the open menu, including the player-inventory rows. */
  size: Type.Optional(Type.Integer()),
  slots: Type.Optional(Type.Array(MenuSlot)),
});
export type PlayerMenuResult = Static<typeof PlayerMenuResult>;

/**
 * One agent-owned fake player in the `player.list` roster (spec/42). Live
 * state fields (`position`/`dimension`/`gameMode`/`health`) are present only
 * while the actor is online.
 */
export const PlayerListEntry = Obj({
  name: Type.String(),
  uuid: Type.String(),
  /** `true` = survives session close (agent-global registry). */
  persist: Type.Boolean(),
  /** Which front door spawned it: an MCTP session or the in-game command. */
  spawnedBy: Type.Union([Type.Literal("mctp"), Type.Literal("command")]),
  online: Type.Boolean(),
  position: Type.Optional(Vec3),
  dimension: Type.Optional(Type.String()),
  gameMode: Type.Optional(Type.String()),
  health: Type.Optional(Type.Number()),
});
export type PlayerListEntry = Static<typeof PlayerListEntry>;

/**
 * `player.list` — enumerate every fake player the agent owns (both persistent
 * actors and this session's session-scoped spawns), so a fresh controller can
 * re-acquire the roster after a reconnect. Real players never appear here.
 */
export const PlayerListParams = StatefulParams({});
export type PlayerListParams = Static<typeof PlayerListParams>;

export const PlayerListResult = ResultObject({
  players: Type.Array(PlayerListEntry),
});
export type PlayerListResult = Static<typeof PlayerListResult>;

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
