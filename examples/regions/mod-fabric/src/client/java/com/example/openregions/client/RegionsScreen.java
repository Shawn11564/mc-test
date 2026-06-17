package com.example.openregions.client;

import io.mctest.agent.core.client.TestIdHolder;

import net.minecraft.client.gui.screen.Screen;
import net.minecraft.client.gui.widget.ButtonWidget;
import net.minecraft.text.Text;

/**
 * Root OpenRegions client Screen (title "OpenRegions"), opened by {@code /or} — the client-Screen twin
 * of the plugin's root chest menu.
 *
 * <p>Holds a single "Regions" button carrying the canonical testId {@code "regions:root:regions"} (the
 * SAME id the plugin stamps onto its "Regions" item), so an agent can resolve it by either the visible
 * label or the testId. Pressing it opens {@link RegionsListScreen}.
 */
public final class RegionsScreen extends Screen {

  static final String TITLE = "OpenRegions";

  public RegionsScreen() {
    super(Text.literal(TITLE));
  }

  @Override
  protected void init() {
    int buttonWidth = 150;
    int buttonHeight = 20;
    int x = (this.width - buttonWidth) / 2;
    int y = this.height / 3;

    this.addDrawableChild(new TestIdButton(
        "regions:root:regions",
        x, y, buttonWidth, buttonHeight,
        Text.literal("Regions"),
        button -> {
          if (this.client != null) {
            this.client.setScreen(new RegionsListScreen());
          }
        }));
  }

  /** A {@link ButtonWidget} that exposes a stable mc-test testId via {@link TestIdHolder}. */
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
}
