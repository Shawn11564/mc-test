/**
 * `@mc-test/protocol` — the MC Test Protocol (MCTP) contract.
 *
 * The single shared wire contract for mc-test: TypeScript types + JSON Schema
 * for every MCTP method/event, the capability vocabulary + `matchCapabilities`,
 * the semantic `Selector` + `describeSelector`, the error model, and the
 * authoring model (`Test`/`Step`/`Target`). Pure data + functions — no
 * dependency on any game, Mineflayer, or the JVM.
 *
 * PROTOCOL.md is the authoritative prose spec; this package is its executable
 * form (types and JSON Schema derive from the same TypeBox objects, so they
 * cannot drift).
 */
export * from "./constants.js";
export * from "./common.js";
export * from "./selectors.js";
export * from "./capabilities.js";
export * from "./mctp.js";
export * from "./methods.js";
export * from "./authoring.js";
