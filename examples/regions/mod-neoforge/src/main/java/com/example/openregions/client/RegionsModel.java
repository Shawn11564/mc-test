package com.example.openregions.client;

import java.util.ArrayList;
import java.util.List;

/**
 * Tiny client-side region model shared by the OpenRegions client Screens (the MOD's own in-memory
 * state, distinct from the server plugin's RegionStore — a client mod cannot author server-truth). Pure
 * Java, no Minecraft types, so it is identical across the Fabric/Forge/NeoForge SUT forms. Seeded with
 * the same regions the plugin seeds so every form presents identical entries.
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
