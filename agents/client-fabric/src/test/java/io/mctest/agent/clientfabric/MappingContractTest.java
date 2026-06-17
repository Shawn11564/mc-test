package io.mctest.agent.clientfabric;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Arrays;
import org.junit.jupiter.api.Test;

/**
 * Mapping-contract test for the Fabric (Yarn-mapped) {@code mappings/Names.java}, run against the REAL
 * remapped Minecraft on the test classpath (Loom provides it). It reflectively asserts the Yarn
 * {@code net.minecraft.*} / {@code com.mojang.*} symbols the shim depends on resolve with the expected
 * shape for THIS (loader × MC version) — the per-version "mapping drift" the one-file quarantine
 * isolates. The Forge/NeoForge twins assert the same contract under their own mappings; this is the
 * Fabric/Yarn parity guard (e.g. the screenshot class is the Yarn {@code ScreenshotRecorder}, not the
 * Mojmap {@code Screenshot}).
 *
 * <p>Uses {@link Class#forName(String, boolean, ClassLoader)} with {@code initialize=false} (metadata
 * only — headless, no GL/bootstrap). Mapped names appear only as STRINGS, outside the production
 * mappings-quarantine (the import-scan polices {@code src/main} only).
 */
class MappingContractTest {

    private Class<?> load(String name) throws ClassNotFoundException {
        return Class.forName(name, false, getClass().getClassLoader());
    }

    private static boolean hasMethod(Class<?> c, String name) {
        return Arrays.stream(c.getMethods()).anyMatch(m -> m.getName().equals(name));
    }

    @Test
    void clientAndScreenApiResolve() throws Exception {
        assertDoesNotThrow(() -> load("net.minecraft.client.MinecraftClient"));
        // snapshot() walks Screen.children(); typeText() reads ParentElement.getFocused().
        Class<?> screen = load("net.minecraft.client.gui.screen.Screen");
        assertDoesNotThrow(() -> screen.getMethod("children"));
        assertDoesNotThrow(() -> screen.getMethod("getFocused"));
    }

    @Test
    void widgetLabelAndTextResolve() throws Exception {
        // collectElement() reads ClickableWidget.getMessage() → Text.getString() for the label.
        Class<?> widget = load("net.minecraft.client.gui.widget.ClickableWidget");
        assertTrue(hasMethod(widget, "getMessage"));
        Class<?> text = load("net.minecraft.text.Text");
        assertDoesNotThrow(() -> text.getMethod("getString"));
    }

    @Test
    void screenshotRecorderIsTheYarnCaptureClass() throws Exception {
        // Yarn names the framebuffer-capture helper ScreenshotRecorder (Mojmap calls it Screenshot);
        // screenshotPng() uses it + com.mojang NativeImage to PNG-encode.
        assertDoesNotThrow(() -> load("net.minecraft.client.util.ScreenshotRecorder"));
        // Yarn remaps blaze3d's NativeImage into net.minecraft.client.texture (Mojmap keeps com.mojang).
        assertDoesNotThrow(() -> load("net.minecraft.client.texture.NativeImage"));
    }
}
