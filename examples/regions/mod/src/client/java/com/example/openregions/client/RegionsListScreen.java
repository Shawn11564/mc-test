package com.example.openregions.client;

import io.mctest.agent.core.client.TestIdHolder;

import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.screen.Screen;
import net.minecraft.client.gui.widget.ButtonWidget;
import net.minecraft.text.Text;

/**
 * The OpenRegions list Screen (title "Regions") holding a single "TestRegion" entry.
 *
 * <p>The entry is a {@link TestIdEntry} carrying the canonical testId
 * {@code "regions:entry:TestRegion"} (matching the plugin's stamped item). Clicking it prints
 * {@code "Region loaded: TestRegion"} to the client chat HUD — driving the chat half of the
 * canonical assertion ({@code assertChat contains "Region loaded"}) — then closes the screen.
 *
 * <p>The server-truth half ("does region TestRegion exist?") is the paired server agent's job
 * (M5 {@code server-fabric}); this client mod only owns the GUI + chat surface.
 */
public final class RegionsListScreen extends Screen {

  static final String TITLE = "Regions";
  static final String CHAT_LINE = "Region loaded: TestRegion";

  public RegionsListScreen() {
    super(Text.literal(TITLE));
  }

  @Override
  protected void init() {
    int entryWidth = 150;
    int entryHeight = 20;
    int x = (this.width - entryWidth) / 2;
    int y = this.height / 3;

    this.addDrawableChild(new TestIdEntry(
        "regions:entry:TestRegion",
        x, y, entryWidth, entryHeight,
        Text.literal("TestRegion"),
        button -> onTestRegionClicked()));
  }

  private void onTestRegionClicked() {
    MinecraftClient client = this.client;
    if (client == null) {
      return;
    }
    // Confirm via a chat line that ROUND-TRIPS through the server, so the client RECEIVES it
    // (ClientReceiveMessageEvents → the client agent's recentChat → world.waitForChat). This mirrors
    // the realistic path a server-sent "Region loaded" message takes; a direct ChatHud.addMessage would
    // be local-only and the agent would never observe it (see agents/client-fabric Names#recentChat).
    if (client.player != null && client.player.networkHandler != null) {
      client.player.networkHandler.sendChatMessage(CHAT_LINE);
    } else if (client.inGameHud != null) {
      // Disconnected (standalone GUI demo): fall back to a local HUD line for human-visible UX only.
      client.inGameHud.getChatHud().addMessage(Text.literal(CHAT_LINE));
    }
    client.setScreen(null);
  }

  /** The "TestRegion" list entry, exposing its stable mc-test testId via {@link TestIdHolder}. */
  static final class TestIdEntry extends ButtonWidget implements TestIdHolder {

    private final String testId;

    TestIdEntry(String testId, int x, int y, int width, int height, Text message, PressAction onPress) {
      super(x, y, width, height, message, onPress, ButtonWidget.DEFAULT_NARRATION_SUPPLIER);
      this.testId = testId;
    }

    @Override
    public String mcTestId() {
      return testId;
    }
  }
}
