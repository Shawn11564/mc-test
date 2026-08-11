package io.mctest.agent.core.client;

import io.mctest.agent.core.ElementModel.ScreenSnapshot;
import java.util.List;

/**
 * The stable, loader-neutral façade between the shared client-side screen logic ({@code /agents/core})
 * and the real Minecraft client (DRIVERS.md §2.3). This is the <em>only</em> thing each per-loader
 * client shim's {@code mappings/Names.java} implements: it binds the Yarn/MCP-SRG/Mojmap obfuscation
 * tax behind these methods so {@link ScreenHandlers} and the rest of the core stay version-independent
 * (Prime Directive 2). All selector resolution, retries, waits, and assertions live above this façade
 * in the runner; the bridge exposes primitives only.
 */
public interface ClientBridge {

    /** Walk the live client Screen into a loader-neutral snapshot. {@code kind="none"} snapshot when no screen open. */
    ScreenSnapshot snapshot();

    /** Click the element with this elementId (from a prior snapshot) on the client thread. @return screen changed. */
    boolean clickElement(String elementId, String button, String clickType);

    /**
     * Type into the focused field (elementId null) or the field with this elementId first.
     *
     * @return whether a text-input widget was actually found and typed into. {@code false} (no focused
     *     field, or the resolved element is not a text-input widget — e.g. a sign-edit screen with no
     *     {@code TextFieldWidget}/{@code EditBox}) must propagate to {@code ELEMENT_NOT_FOUND}; the
     *     caller must never report {@code ok: true} for a no-op type.
     */
    boolean typeText(String elementId, String text, boolean clear, boolean submit);

    /**
     * Fallback for screens that own their own text editing and expose <b>no text-input widget</b>.
     * The vanilla <b>sign editor</b> is the canonical case: it has no {@code TextFieldWidget}/
     * {@code EditBox} at all and drives a {@code SelectionManager} straight from
     * {@code Screen#charTyped}, so {@link #typeText} can only ever return {@code false} there —
     * which (correctly, per the plan-A fix) turns every sign-typing step into
     * {@code ELEMENT_NOT_FOUND}. This method replays {@code text} as character events on the open
     * screen instead, making signs typeable without reopening that false-green hole.
     *
     * <p>Whether to try this is decided in core ({@link ScreenHandlers}), not per loader: it is only
     * attempted when the author gave NO selector (a selector naming a specific non-text widget must
     * still fail — the author asked for that element), and its {@code false} still propagates to
     * {@code ELEMENT_NOT_FOUND}.
     *
     * @return whether the screen actually <b>consumed</b> the characters. Implementations MUST
     *     derive this from {@code charTyped}'s own boolean return rather than assuming success: a
     *     screen that ignores text is not typeable, and reporting {@code true} there would restore
     *     exactly the silent no-op this pairs with the plan-A fix to prevent.
     *     The default is {@code false} — "this bridge has no screen-level fallback".
     */
    default boolean typeIntoScreen(String text, boolean clear, boolean submit) {
        return false;
    }

    /** Press a semantic key already resolved to a GLFW code by core. @return screen changed. */
    boolean pressKey(String keyName, int glfwKeyCode, List<String> modifiers);

    /** Close the current screen (ESC). @return whether a screen was open. */
    boolean closeScreen();

    /** PNG bytes of the current framebuffer, or null if no framebuffer (rendering absent). */
    byte[] screenshotPng();

    /** Whether a live framebuffer exists (drives screenshot/rendering advertisement). */
    boolean hasFramebuffer();

    // world / chat (client-side)

    void joinServer(String host, int port, String username);

    void leaveServer();

    void runCommand(String command);   // no leading '/'

    void sendChat(String message);

    /** Recent chat lines, plain text, oldest→newest (for world.waitForChat). */
    List<String> recentChat();
}
