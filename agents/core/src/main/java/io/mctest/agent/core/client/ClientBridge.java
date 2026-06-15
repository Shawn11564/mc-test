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

    /** Type into the focused field (elementId null) or the field with this elementId first. */
    boolean typeText(String elementId, String text, boolean clear, boolean submit);

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
