package com.example.openregions;

import io.mctest.agent.core.McTestStateProvider;
import java.util.Map;

/**
 * Exposes OpenRegions' authoritative state to the MCTP server agent's
 * {@code truth.assertPluginState} primitive. The agent resolves this via the Bukkit
 * {@code ServicesManager} (looked up by the shared {@link McTestStateProvider} class)
 * and evaluates the runner-supplied predicate against the returned value.
 *
 * <p>Pure Java, no Bukkit types — the implemented interface comes from the agent
 * plugin's copy of {@code mc-test-agent-core} (we compile against it at provided scope
 * and declare {@code softdepend: [mc-test-agent]}), so the {@code Class} used to register
 * and the one the agent looks up are identical at runtime.
 *
 * <p>Supported queries:
 * <ul>
 *   <li>{@code regions.exists} — args {@code {name}} → {@link Boolean} (region exists)</li>
 *   <li>{@code regions.count} — → {@link Integer} (number of regions)</li>
 *   <li>{@code regions.list} — → {@link java.util.List} of region names</li>
 * </ul>
 */
public final class RegionsStateProvider implements McTestStateProvider {

  private final RegionStore store;

  public RegionsStateProvider(RegionStore store) {
    this.store = store;
  }

  @Override
  public Object query(String query, Map<String, Object> args) throws Exception {
    switch (query) {
      case "regions.exists":
        return store.has(requireName(args));
      case "regions.count":
        return store.size();
      case "regions.list":
        return store.names();
      default:
        // Unknown query — the agent maps this to -32006 ASSERT_FAILED.
        throw new IllegalArgumentException("unknown query: " + query);
    }
  }

  private static String requireName(Map<String, Object> args) {
    Object name = args == null ? null : args.get("name");
    if (name == null) {
      throw new IllegalArgumentException("regions.exists requires args.name");
    }
    return String.valueOf(name);
  }
}
