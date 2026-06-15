package com.example.openregions;

import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Tiny, thread-safe in-memory store of region names — the authoritative runtime
 * state the MCTP server agent reads via {@code truth.assertPluginState} (query
 * {@code regions.exists}) and mutates via the {@code regions.createRegion} fixture.
 *
 * <p>This is the single source of "real" plugin state: clicking "TestRegion" in the
 * GUI adds to it, the {@link RegionsFixtureProvider} adds/removes via fixtures, and the
 * {@link RegionsStateProvider} queries it. The store is plain Java with no Bukkit types
 * so the same logic is testable and the SPI classloader contract stays clean.
 */
public final class RegionStore {

  // Insertion-ordered for a stable regions.list; reads/writes are off the main thread
  // (the MCTP server runs its own threads), so guard with the instance monitor.
  private final Set<String> regions = new LinkedHashSet<>();

  /** Add a region. Returns true if it was newly added (false if already present). */
  public synchronized boolean add(String name) {
    return regions.add(name);
  }

  /** Remove a region. Returns true if it was present and removed. */
  public synchronized boolean remove(String name) {
    return regions.remove(name);
  }

  /** Whether a region with this exact name exists. */
  public synchronized boolean has(String name) {
    return regions.contains(name);
  }

  /** Number of regions currently defined. */
  public synchronized int size() {
    return regions.size();
  }

  /** Immutable snapshot of region names in insertion order. */
  public synchronized List<String> names() {
    return Collections.unmodifiableList(new CopyOnWriteArrayList<>(regions));
  }
}
