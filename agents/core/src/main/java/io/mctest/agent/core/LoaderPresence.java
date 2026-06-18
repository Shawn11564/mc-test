package io.mctest.agent.core;

/**
 * Loader-level mod/plugin presence check (F5). Implemented per loader in its mappings facade /
 * via its stable API — Bukkit {@code PluginManager.getPlugin}, Fabric {@code FabricLoader.isModLoaded},
 * Forge/NeoForge {@code ModList.isLoaded}. Lets {@link BuiltInStateQueries} answer the SUT-agnostic
 * {@code mod.loaded}/{@code plugin.loaded} query against the loader itself, so a DOWNLOADED third-party
 * mod (which registers no {@link McTestStateProvider}) can still be asserted present.
 */
@FunctionalInterface
public interface LoaderPresence {
    /** @return true if a mod/plugin with the given id is loaded by the running loader. */
    boolean isLoaded(String id);
}
