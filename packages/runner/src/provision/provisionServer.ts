/**
 * Loader-aware server-provisioning router (F5). The CLI calls `provisionServer`
 * with a unified options object; it dispatches on the loader family to either the
 * Bukkit-family `provisionPaper` (plugins → `plugins/`) or the modded
 * `provisionModded` (mods → `mods/`, Fabric launcher / Forge-NeoForge installer).
 * Both return the same `ProvisionedServer` shape, so the engine is loader-agnostic.
 */
import { provisionPaper, type PluginSpec } from "./PaperProvisioner.js";
import { provisionModded, loaderFamily, type ModSpec } from "./ModdedProvisioner.js";
import type { AgentSpec, ProvisionedServer } from "./serverCommon.js";

export interface ServerProvisionOptions {
  loader: string;
  mc: string;
  /**
   * Force the Bukkit/Paper server path even when `loader` names a mod loader. The rendered-client
   * rows (`driver: inprocess`) set `loader` to the CLIENT loader (fabric/forge/neoforge) but boot a
   * PAPER server (`server: { paper }`) for the rendered client to connect to — so the SERVER family is
   * decided by `server.paper`, NOT the client loader. The CLI passes its `serverIsBukkit` here; when
   * omitted the router falls back to `loaderFamily(loader)`.
   */
  serverIsBukkit?: boolean;
  /** Loader version (Fabric loader; REQUIRED for Forge/NeoForge). */
  loaderVersion?: string;
  /** Paper build pin (bukkit family). */
  build?: number | "latest";
  /** Explicit server jar: bukkit jar (F2) OR a Fabric `fabric-server-launch.jar`. */
  serverJar?: string;
  /** Explicit Forge/NeoForge installer jar (else resolved from maven by loaderVersion). */
  installerJar?: string;
  bindHost: string;
  gamePort: number;
  instanceDir: string;
  cacheDir: string;
  /** Bukkit-family SUT plugins (ignored for modded). */
  plugins?: PluginSpec[];
  /** Modded SUT mods + deps (ignored for bukkit). */
  mods?: ModSpec[];
  agents?: AgentSpec[];
  worldSnapshotPath?: string;
  levelName?: string;
  serverProps?: Record<string, string | number | boolean>;
  ops?: string[];
  eulaAccepted: boolean;
  javaPath?: string;
  bootTimeoutMs?: number;
  onLog?: (line: string) => void;
  /** Mod ids whose boot-log load to verify (F5). */
  expectModIds?: string[];
  /** Share heavy regenerables across runs of the same build (item D; Paper + Fabric/Quilt/vanilla). */
  shareRuntime?: boolean;
}

/**
 * Decide whether the SERVER is Paper/Bukkit (PURE, unit-tested). An explicit `serverIsBukkit` (the CLI's
 * resolution, which is `true` whenever `server.paper` is set — e.g. the rendered-client rows that name a
 * mod loader for the CLIENT but boot a Paper server) wins; otherwise it falls back to the loader family.
 */
export function serverUsesBukkit(serverIsBukkit: boolean | undefined, loader: string): boolean {
  return serverIsBukkit ?? loaderFamily(loader) === "bukkit";
}

/**
 * Provision a server, routing to Paper when a Paper server is explicitly requested (the rendered-client
 * rows, via `serverIsBukkit`) or the loader is bukkit-family; otherwise the modded path.
 */
export function provisionServer(opts: ServerProvisionOptions): Promise<ProvisionedServer> {
  if (serverUsesBukkit(opts.serverIsBukkit, opts.loader)) {
    return provisionPaper({
      mc: opts.mc,
      ...(opts.build !== undefined ? { build: opts.build } : {}),
      ...(opts.serverJar ? { serverJar: opts.serverJar } : {}),
      bindHost: opts.bindHost,
      gamePort: opts.gamePort,
      instanceDir: opts.instanceDir,
      cacheDir: opts.cacheDir,
      plugins: opts.plugins ?? [],
      ...(opts.agents ? { agents: opts.agents } : {}),
      ...(opts.worldSnapshotPath ? { worldSnapshotPath: opts.worldSnapshotPath } : {}),
      ...(opts.levelName ? { levelName: opts.levelName } : {}),
      ...(opts.serverProps ? { serverProps: opts.serverProps } : {}),
      ...(opts.ops ? { ops: opts.ops } : {}),
      eulaAccepted: opts.eulaAccepted,
      ...(opts.javaPath ? { javaPath: opts.javaPath } : {}),
      ...(opts.bootTimeoutMs !== undefined ? { bootTimeoutMs: opts.bootTimeoutMs } : {}),
      ...(opts.onLog ? { onLog: opts.onLog } : {}),
      ...(opts.shareRuntime !== undefined ? { shareRuntime: opts.shareRuntime } : {}),
    });
  }
  return provisionModded({
    loader: opts.loader,
    mc: opts.mc,
    ...(opts.loaderVersion ? { loaderVersion: opts.loaderVersion } : {}),
    ...(opts.serverJar ? { serverJar: opts.serverJar } : {}),
    ...(opts.installerJar ? { installerJar: opts.installerJar } : {}),
    bindHost: opts.bindHost,
    gamePort: opts.gamePort,
    instanceDir: opts.instanceDir,
    cacheDir: opts.cacheDir,
    mods: opts.mods ?? [],
    ...(opts.agents ? { agents: opts.agents } : {}),
    ...(opts.worldSnapshotPath ? { worldSnapshotPath: opts.worldSnapshotPath } : {}),
    ...(opts.levelName ? { levelName: opts.levelName } : {}),
    ...(opts.serverProps ? { serverProps: opts.serverProps } : {}),
    ...(opts.ops ? { ops: opts.ops } : {}),
    eulaAccepted: opts.eulaAccepted,
    ...(opts.javaPath ? { javaPath: opts.javaPath } : {}),
    ...(opts.bootTimeoutMs !== undefined ? { bootTimeoutMs: opts.bootTimeoutMs } : {}),
    ...(opts.onLog ? { onLog: opts.onLog } : {}),
    ...(opts.expectModIds ? { expectModIds: opts.expectModIds } : {}),
    ...(opts.shareRuntime !== undefined ? { shareRuntime: opts.shareRuntime } : {}),
  });
}
