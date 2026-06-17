package io.mctest.agent.clientneoforge;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Arrays;
import org.junit.jupiter.api.Test;

/**
 * Mapping-contract test for the NeoForge (Mojmap-mapped) {@code mappings/Names.java}, run against the
 * REAL remapped Minecraft on the test classpath (NeoGradle provides it). It reflectively asserts the
 * {@code net.minecraft.*} / {@code com.mojang.*} symbols the shim depends on resolve with the expected
 * shape for THIS (loader × MC version). The headline guard pins the drift fixed when the shim was first
 * compiled (it had never been built): {@code NativeImage.writeToChannel(...)} is PRIVATE in Mojmap
 * 1.21.x, so {@code screenshotPng()} must use the PUBLIC {@code asByteArray()} — this test fails loudly
 * if a bump makes {@code asByteArray()} non-public again.
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
    void nativeImageAsByteArrayIsPublic() throws Exception {
        // The regression guard: writeToChannel(WritableByteChannel) is PRIVATE in Mojmap 1.21.x, so
        // screenshotPng() encodes via the public asByteArray(). getMethod() only finds PUBLIC methods, so
        // this throws NoSuchMethodException if asByteArray() ever stops being public.
        Class<?> nativeImage = load("com.mojang.blaze3d.platform.NativeImage");
        assertDoesNotThrow(() -> nativeImage.getMethod("asByteArray"),
                "NativeImage.asByteArray() must be public (writeToChannel is private)");
    }

    @Test
    void screenshotLivesUnderClientPackage() throws Exception {
        Class<?> screenshot = load("net.minecraft.client.Screenshot");
        assertTrue(hasMethod(screenshot, "takeScreenshot"),
                "Screenshot.takeScreenshot(framebuffer) is the capture screenshotPng() uses");
    }

    @Test
    void screenExposesChildrenAndFocus() throws Exception {
        // snapshot() walks Screen.children(); focusedField() reads Screen.getFocused().
        Class<?> screen = load("net.minecraft.client.gui.screens.Screen");
        assertDoesNotThrow(() -> screen.getMethod("children"));
        assertDoesNotThrow(() -> screen.getMethod("getFocused"));
    }

    @Test
    void widgetLabelAndComponentTextResolve() throws Exception {
        Class<?> widget = load("net.minecraft.client.gui.components.AbstractWidget");
        assertTrue(hasMethod(widget, "getMessage"));
        Class<?> component = load("net.minecraft.network.chat.Component");
        assertDoesNotThrow(() -> component.getMethod("getString"));
    }
}
