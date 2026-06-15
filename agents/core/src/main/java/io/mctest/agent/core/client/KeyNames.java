package io.mctest.agent.core.client;

import java.util.Locale;

/**
 * Maps a semantic key name ({@code "enter"}, {@code "escape"}, {@code "e"}, {@code "f3"}, …) to its
 * GLFW key code (PROTOCOL.md §7.3 {@code screen.pressKey}). This is loader-NEUTRAL data: the GLFW codes
 * are stable across Minecraft versions, so resolution lives in the core and the per-loader
 * {@link ClientBridge} only consumes the resolved {@code int} code. Modifiers ({@code shift}/{@code
 * ctrl}/{@code alt}) do not affect the base key code and are passed through separately by the bridge.
 */
public final class KeyNames {

    private KeyNames() {
    }

    // GLFW key codes (subset; see the GLFW header) — stable across MC versions.
    private static final int GLFW_KEY_SPACE = 32;
    private static final int GLFW_KEY_ESCAPE = 256;
    private static final int GLFW_KEY_ENTER = 257;
    private static final int GLFW_KEY_TAB = 258;
    private static final int GLFW_KEY_BACKSPACE = 259;
    private static final int GLFW_KEY_RIGHT = 262;
    private static final int GLFW_KEY_LEFT = 263;
    private static final int GLFW_KEY_DOWN = 264;
    private static final int GLFW_KEY_UP = 265;

    /**
     * @return GLFW key code for a semantic name ({@code "enter"}, {@code "escape"}, {@code "e"},
     *         {@code "f3"}, {@code "tab"}, {@code "space"}, a-z, 0-9), or {@code -1} if unknown.
     *         Case-insensitive; accepts {@code "key.inventory"}-style ids by stripping the {@code "key."}
     *         prefix and matching the remainder.
     */
    public static int glfwCode(String name) {
        if (name == null) {
            return -1;
        }
        String n = name.trim().toLowerCase(Locale.ROOT);
        if (n.isEmpty()) {
            return -1;
        }
        // Accept "key.inventory"-style ids by stripping the "key." prefix.
        if (n.startsWith("key.")) {
            n = n.substring("key.".length());
        }

        switch (n) {
            case "escape":
            case "esc":
                return GLFW_KEY_ESCAPE;
            case "enter":
            case "return":
                return GLFW_KEY_ENTER;
            case "tab":
                return GLFW_KEY_TAB;
            case "backspace":
                return GLFW_KEY_BACKSPACE;
            case "space":
                return GLFW_KEY_SPACE;
            case "left":
                return GLFW_KEY_LEFT;
            case "right":
                return GLFW_KEY_RIGHT;
            case "up":
                return GLFW_KEY_UP;
            case "down":
                return GLFW_KEY_DOWN;
            default:
                break;
        }

        // F1..F12 → 290..301.
        if (n.length() >= 2 && n.charAt(0) == 'f') {
            try {
                int fn = Integer.parseInt(n.substring(1));
                if (fn >= 1 && fn <= 12) {
                    return 290 + (fn - 1);
                }
            } catch (NumberFormatException ignored) {
                // fall through to single-char handling.
            }
        }

        // Single letter a-z → 65..90 (GLFW uses the ASCII uppercase code).
        if (n.length() == 1) {
            char c = n.charAt(0);
            if (c >= 'a' && c <= 'z') {
                return 'A' + (c - 'a');
            }
            // Single digit 0-9 → 48..57.
            if (c >= '0' && c <= '9') {
                return c;
            }
        }

        return -1;
    }
}
