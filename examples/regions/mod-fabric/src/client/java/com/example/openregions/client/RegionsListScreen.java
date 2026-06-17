package com.example.openregions.client;

import io.mctest.agent.core.client.TestIdHolder;

import net.minecraft.client.MinecraftClient;
import net.minecraft.client.font.TextRenderer;
import net.minecraft.client.gui.screen.Screen;
import net.minecraft.client.gui.widget.ButtonWidget;
import net.minecraft.client.gui.widget.TextFieldWidget;
import net.minecraft.text.Text;

/**
 * The OpenRegions list Screen (title "Regions") — the CRUD surface of the client SUT.
 *
 * <p>Renders one entry per region from {@link RegionsModel} (click → load: marks active + prints
 * "Region loaded: &lt;name&gt;"), a text field for a new region name, a "Create" button (adds the
 * typed region + prints "Region created: &lt;name&gt;") and a "Delete" button (removes the active
 * region + prints "Region deleted: &lt;name&gt;"). Create/Delete mutate the model then re-open the
 * screen so the entry list reflects the change. Chat lines ROUND-TRIP through the server (so the
 * client agent's chat observer receives them); the server-truth half is asserted separately via a
 * seeded fixture (a client mod cannot author server state — see examples/regions/README.md).
 *
 * <p>Widgets carry the canonical testIds the plugin also stamps ({@code regions:entry:<name>},
 * {@code regions:action:create}, {@code regions:action:delete}, {@code regions:input:name}) via
 * {@link TestIdHolder}; the cross-loader test selects by visible label + the input's role, so it
 * never depends on testId being visible across mod classloaders.
 */
public final class RegionsListScreen extends Screen {

  static final String TITLE = "Regions";

  private TextFieldWidget nameField;

  public RegionsListScreen() {
    super(Text.literal(TITLE));
  }

  @Override
  protected void init() {
    int w = 150;
    int h = 20;
    int x = (this.width - w) / 2;
    int y = this.height / 6;

    // One button per region — clicking loads it.
    for (String name : RegionsModel.INSTANCE.names()) {
      final String region = name;
      this.addDrawableChild(new TestIdButton(
          "regions:entry:" + region, x, y, w, h, Text.literal(region), button -> onLoad(region)));
      y += h + 4;
    }

    y += 6;
    // The new-region name field (role "input" — what the cross-loader test selects + types into).
    this.nameField = new TestIdField(
        "regions:input:name", this.textRenderer, x, y, w, h, Text.literal("Region name"));
    this.nameField.setMaxLength(64);
    this.addDrawableChild(this.nameField);
    y += h + 4;

    this.addDrawableChild(new TestIdButton(
        "regions:action:create", x, y, w, h, Text.literal("Create"), button -> onCreate()));
    y += h + 4;
    this.addDrawableChild(new TestIdButton(
        "regions:action:delete", x, y, w, h, Text.literal("Delete"), button -> onDelete()));
  }

  private void onLoad(String name) {
    RegionsModel.INSTANCE.setActive(name);
    sendChat("Region loaded: " + name);
  }

  private void onCreate() {
    String name = this.nameField == null ? "" : this.nameField.getText().trim();
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
    if (this.client != null) {
      this.client.setScreen(new RegionsListScreen());
    }
  }

  /**
   * Send a chat line that ROUND-TRIPS through the server, so the client RECEIVES it
   * (ClientReceiveMessageEvents → the client agent's recentChat → world.waitForChat). A direct
   * ChatHud.addMessage would be local-only and the agent would never observe it.
   */
  private void sendChat(String line) {
    MinecraftClient client = this.client;
    if (client == null) {
      return;
    }
    if (client.player != null && client.player.networkHandler != null) {
      client.player.networkHandler.sendChatMessage(line);
    } else if (client.inGameHud != null) {
      client.inGameHud.getChatHud().addMessage(Text.literal(line)); // disconnected demo fallback
    }
  }

  /** A {@link ButtonWidget} exposing its stable mc-test testId via {@link TestIdHolder}. */
  static final class TestIdButton extends ButtonWidget implements TestIdHolder {
    private final String testId;

    TestIdButton(String testId, int x, int y, int width, int height, Text message, PressAction onPress) {
      super(x, y, width, height, message, onPress, ButtonWidget.DEFAULT_NARRATION_SUPPLIER);
      this.testId = testId;
    }

    @Override
    public String mcTestId() {
      return testId;
    }
  }

  /** A {@link TextFieldWidget} exposing its stable mc-test testId via {@link TestIdHolder}. */
  static final class TestIdField extends TextFieldWidget implements TestIdHolder {
    private final String testId;

    TestIdField(String testId, TextRenderer tr, int x, int y, int width, int height, Text text) {
      super(tr, x, y, width, height, text);
      this.testId = testId;
    }

    @Override
    public String mcTestId() {
      return testId;
    }
  }
}
