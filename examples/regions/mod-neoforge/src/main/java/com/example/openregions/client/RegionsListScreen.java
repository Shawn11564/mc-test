package com.example.openregions.client;

import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;

/**
 * The OpenRegions list Screen (title "Regions") — the CRUD surface of the NeoForge SUT, mirroring the
 * Fabric/Forge {@code RegionsListScreen}.
 *
 * <p>One button per region (click → load: marks active + prints "Region loaded: &lt;name&gt;"), a name
 * field (role "input"), a "Create" button (adds the typed region + prints "Region created: &lt;name&gt;")
 * and a "Delete" button (removes the active region + prints "Region deleted: &lt;name&gt;"). Chat lines
 * round-trip through the server via {@code connection.sendChat} so the client agent's chat observer sees
 * them; the server-truth half is seeded separately via a fixture. A plain NeoForge mod with no mc-test
 * coupling — the agent selects by visible label and by the input's role.
 */
public final class RegionsListScreen extends Screen {

    static final String TITLE = "Regions";

    private EditBox nameField;

    public RegionsListScreen() {
        super(Component.literal(TITLE));
    }

    @Override
    protected void init() {
        int w = 150;
        int h = 20;
        int x = (this.width - w) / 2;
        int y = this.height / 6;

        for (String name : RegionsModel.INSTANCE.names()) {
            final String region = name;
            this.addRenderableWidget(
                    Button.builder(Component.literal(region), b -> onLoad(region)).bounds(x, y, w, h).build());
            y += h + 4;
        }

        y += 6;
        this.nameField = new EditBox(this.font, x, y, w, h, Component.literal("Region name"));
        this.nameField.setMaxLength(64);
        this.addRenderableWidget(this.nameField);
        y += h + 4;

        this.addRenderableWidget(
                Button.builder(Component.literal("Create"), b -> onCreate()).bounds(x, y, w, h).build());
        y += h + 4;
        this.addRenderableWidget(
                Button.builder(Component.literal("Delete"), b -> onDelete()).bounds(x, y, w, h).build());
    }

    private void onLoad(String name) {
        RegionsModel.INSTANCE.setActive(name);
        sendChat("Region loaded: " + name);
    }

    private void onCreate() {
        String name = this.nameField == null ? "" : this.nameField.getValue().trim();
        if (RegionsModel.INSTANCE.add(name)) {
            sendChat("Region created: " + name);
            reopen();
        }
    }

    private void onDelete() {
        String active = RegionsModel.INSTANCE.getActive();
        if (active != null && RegionsModel.INSTANCE.remove(active)) {
            RegionsModel.INSTANCE.setActive(null);
            sendChat("Region deleted: " + active);
            reopen();
        }
    }

    /** Re-create the screen so the entry list reflects a create/delete (model state persists). */
    private void reopen() {
        if (this.minecraft != null) {
            this.minecraft.setScreen(new RegionsListScreen());
        }
    }

    /** Send a chat line that round-trips through the server, so the client agent's chat tap sees it. */
    private void sendChat(String line) {
        Minecraft mc = this.minecraft;
        if (mc == null) {
            return;
        }
        if (mc.player != null && mc.player.connection != null) {
            mc.player.connection.sendChat(line);
        } else if (mc.gui != null) {
            mc.gui.getChat().addMessage(Component.literal(line)); // disconnected demo fallback
        }
    }
}
