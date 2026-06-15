package io.mctest.agent.core.client;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import io.mctest.agent.core.Capabilities;

/**
 * Builds the client agent's advertised {@link Capabilities} bundle (DRIVERS.md §2.1, PROTOCOL.md §6).
 * A client mod always offers {@code chat, command, containerGui, clientScreens, typeText, pressKey,
 * testIdTags}; it offers {@code screenshot} and {@code rendering} ONLY when a live framebuffer exists
 * (a headless-but-rendering-absent client must not falsely advertise pixel capture). It never offers
 * the server-truth half ({@code worldTruth}/{@code pluginState}/{@code fixtures}/{@code fakePlayers}) —
 * that is the server agent's job, paired in the same session.
 */
public final class ClientCapabilities {

    private ClientCapabilities() {
    }

    /**
     * @param hasFramebuffer whether a live framebuffer exists (a real rendered client). When false the
     *                       {@code screenshot}/{@code rendering} keys are omitted so a {@code screenshot}
     *                       step honestly skips on a render-less client instead of failing mid-run.
     * @return the advertised capability set for a client-mod agent.
     */
    public static Capabilities build(boolean hasFramebuffer) {
        JsonObject clientScreensDetail = new JsonObject();
        clientScreensDetail.addProperty("widgetTree", true);

        Capabilities caps = new Capabilities()
                .advertise("chat")
                .advertise("command")
                .advertise("containerGui")
                .advertise("clientScreens", clientScreensDetail)
                .advertise("typeText")
                .advertise("pressKey")
                .advertise("testIdTags");

        if (hasFramebuffer) {
            JsonObject screenshotDetail = new JsonObject();
            JsonArray formats = new JsonArray();
            formats.add("png");
            // Canonical capability-detail key is `formats` (plural), PROTOCOL.md §6.3.
            screenshotDetail.add("formats", formats);
            caps.advertise("screenshot", screenshotDetail);
            caps.advertise("rendering");
        }
        return caps;
    }
}
