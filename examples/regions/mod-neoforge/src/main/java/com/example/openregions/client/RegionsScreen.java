package com.example.openregions.client;

import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;

/**
 * Root OpenRegions client Screen (title "OpenRegions"), opened by {@code /or} — the NeoForge twin of the
 * Fabric/Forge {@code RegionsScreen}. Holds a single "Regions" button; pressing it opens
 * {@link RegionsListScreen}. A plain NeoForge mod with no mc-test coupling: the agent resolves the button
 * by its visible label.
 */
public final class RegionsScreen extends Screen {

    static final String TITLE = "OpenRegions";

    public RegionsScreen() {
        super(Component.literal(TITLE));
    }

    @Override
    protected void init() {
        int w = 150;
        int h = 20;
        int x = (this.width - w) / 2;
        int y = this.height / 3;

        this.addRenderableWidget(
                Button.builder(Component.literal("Regions"), b -> {
                    if (this.minecraft != null) {
                        this.minecraft.setScreen(new RegionsListScreen());
                    }
                }).bounds(x, y, w, h).build());
    }
}
