package com.example.openregions;

import io.mctest.agent.core.McTestFixtureProvider;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * SUT-defined fixtures for OpenRegions, delegated to by the MCTP server agent's
 * {@code fixture.set}/{@code fixture.reset} when a fixture name is one this provider
 * {@link #supports(String)}. The agent routes name+args here; this class mutates the
 * authoritative {@link RegionStore} and records a reversal so the agent can undo the
 * fixture on {@code fixture.reset} or {@code session.close}.
 *
 * <p>Pure Java, no Bukkit types — resolved via the Bukkit {@code ServicesManager} using
 * the agent plugin's copy of {@link McTestFixtureProvider} (shared by softdepend).
 *
 * <p>Supported fixtures:
 * <ul>
 *   <li>{@code regions.createRegion} — args {@code {name}} → adds the region;
 *       result {@code {regionId, handle}}; undo removes it.</li>
 *   <li>{@code regions.deleteRegion} — args {@code {name}} → removes the region;
 *       result {@code {regionId, handle}}; undo restores it.</li>
 * </ul>
 */
public final class RegionsFixtureProvider implements McTestFixtureProvider {

  static final String CREATE = "regions.createRegion";
  static final String DELETE = "regions.deleteRegion";

  private final RegionStore store;
  // handle -> reversal action, so undo(handle) can revert the exact mutation it applied.
  private final Map<String, Runnable> undos = new ConcurrentHashMap<>();

  public RegionsFixtureProvider(RegionStore store) {
    this.store = store;
  }

  @Override
  public boolean supports(String fixture) {
    return CREATE.equals(fixture) || DELETE.equals(fixture);
  }

  @Override
  public Object apply(String fixture, Map<String, Object> args) throws Exception {
    String name = requireName(args);
    String handle = "fx_region_" + name;
    switch (fixture) {
      case CREATE: {
        boolean added = store.add(name);
        // Only reverse what we actually changed: if the region already existed, undo is a no-op.
        undos.put(handle, added ? () -> store.remove(name) : () -> { });
        return result(name, handle);
      }
      case DELETE: {
        boolean removed = store.remove(name);
        undos.put(handle, removed ? () -> store.add(name) : () -> { });
        return result(name, handle);
      }
      default:
        // Should be unreachable — the agent only calls apply for supported() fixtures.
        throw new IllegalArgumentException("unsupported fixture: " + fixture);
    }
  }

  @Override
  public void undo(String handle) throws Exception {
    Runnable reversal = undos.remove(handle);
    if (reversal != null) {
      reversal.run();
    }
  }

  private static Map<String, Object> result(String name, String handle) {
    Map<String, Object> result = new LinkedHashMap<>();
    result.put("regionId", name);
    result.put("handle", handle);
    return result;
  }

  private static String requireName(Map<String, Object> args) {
    Object name = args == null ? null : args.get("name");
    if (name == null) {
      throw new IllegalArgumentException("fixture requires args.name");
    }
    return String.valueOf(name);
  }
}
