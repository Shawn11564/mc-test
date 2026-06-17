package com.example.openregions.client;

import java.util.ArrayList;
import java.util.List;

/**
 * Tiny client-side region model shared by the OpenRegions client Screens. This is the MOD's own
 * in-memory state, deliberately distinct from the server plugin's {@code RegionStore}: a client mod
 * cannot author server-truth, so the rendered test asserts the GUI/chat surface here and seeds the
 * server's authoritative state via a {@code fixture} step (see examples/regions/README.md).
 *
 * <p>Seeded with the same regions the plugin seeds ({@code TestRegion}, {@code Spawn}, {@code Market})
 * so both forms present identical entries. One shared instance outlives the short-lived Screens.
 */
public final class RegionsModel {

  /** Shared client-session instance (Screens are recreated on every create/delete; state persists). */
  public static final RegionsModel INSTANCE = new RegionsModel();

  private final List<String> regions = new ArrayList<>(List.of("TestRegion", "Spawn", "Market"));
  private String active;

  private RegionsModel() {}

  /** Snapshot of region names in insertion order. */
  public synchronized List<String> names() {
    return List.copyOf(regions);
  }

  /** Add a region. Returns true if newly added (false if blank or already present). */
  public synchronized boolean add(String name) {
    if (name == null || name.isBlank() || regions.contains(name)) {
      return false;
    }
    return regions.add(name);
  }

  /** Remove a region. Returns true if it was present. */
  public synchronized boolean remove(String name) {
    return regions.remove(name);
  }

  /** Marks {@code name} as the active region (the last one loaded). */
  public synchronized void setActive(String name) {
    this.active = name;
  }

  /** The active region name, or {@code null} if none has been loaded. */
  public synchronized String getActive() {
    return active;
  }
}
