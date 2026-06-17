package io.mctest.agent.clientforge;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Arrays;
import org.junit.jupiter.api.Test;

/**
 * Mapping-contract test for the Forge (MCP-SRG / official-mapped) {@code mappings/Names.java}, run
 * against the REAL remapped Minecraft on the test classpath (ForgeGradle provides it). It reflectively
 * asserts that the exact {@code net.minecraft.*} symbols the shim depends on resolve with the shape the
 * shim expects for THIS (loader × MC version) — the per-version "mapping drift" that the one-file
 * quarantine isolates. These are REGRESSION GUARDS for the drift fixed when the shim was first compiled
 * (it had never been built): {@code Screenshot}'s package, {@code ServerData}'s 1.20.1 constructor, and
 * {@code Screen}'s focus API. A future MC bump that moves any of these fails HERE with a clear message
 * instead of a raw compiler error.
 *
 * <p>Uses {@link Class#forName(String, boolean, ClassLoader)} with {@code initialize=false} (reflection
 * metadata only — no class initialization, so no GL/bootstrap is triggered; this runs headless in plain
 * {@code ./gradlew test}). It references mapped names only as STRINGS, so it stays outside the
 * production mappings-quarantine (the import-scan polices {@code src/main} only).
 */
class MappingContractTest {

    private Class<?> load(String name) throws ClassNotFoundException {
        return Class.forName(name, false, getClass().getClassLoader());
    }

    private static boolean hasMethod(Class<?> c, String name) {
        return Arrays.stream(c.getMethods()).anyMatch(m -> m.getName().equals(name));
    }

    @Test
    void screenshotLivesUnderClientPackage() throws Exception {
        // 1.20.1 Mojmap: Screenshot is net.minecraft.client.Screenshot — NOT .client.renderer.Screenshot
        // (the wrong import the never-compiled shim shipped with). Guard both the right and the wrong path.
        Class<?> screenshot = load("net.minecraft.client.Screenshot");
        assertTrue(hasMethod(screenshot, "takeScreenshot"),
                "Screenshot.takeScreenshot(framebuffer) is the framebuffer capture screenshotPng() uses");
        assertThrows(ClassNotFoundException.class, () -> load("net.minecraft.client.renderer.Screenshot"),
                "Screenshot must NOT be under net.minecraft.client.renderer in 1.20.1");
    }

    @Test
    void serverDataHasBooleanLanConstructor() throws Exception {
        // joinServer() builds ServerData(name, ip, boolean isLan) in 1.20.1 (predates the 1.20.2+
        // ServerData.Type enum). If a bump reintroduces Type, this guard flags the constructor change.
        Class<?> serverData = load("net.minecraft.client.multiplayer.ServerData");
        assertDoesNotThrow(() -> serverData.getConstructor(String.class, String.class, boolean.class));
    }

    @Test
    void screenExposesChildrenAndFocus() throws Exception {
        // snapshot() walks Screen.children(); focusedField() reads Screen.getFocused() directly (Screen
        // IS-A ContainerEventHandler in 1.20.1, so no `instanceof ContainerEventHandler` is needed).
        Class<?> screen = load("net.minecraft.client.gui.screens.Screen");
        assertDoesNotThrow(() -> screen.getMethod("children"));
        assertDoesNotThrow(() -> screen.getMethod("getFocused"));
    }

    @Test
    void widgetLabelAndComponentTextResolve() throws Exception {
        // collectElement() reads AbstractWidget.getMessage() → Component.getString() for the label.
        Class<?> widget = load("net.minecraft.client.gui.components.AbstractWidget");
        assertTrue(hasMethod(widget, "getMessage"));
        Class<?> component = load("net.minecraft.network.chat.Component");
        assertDoesNotThrow(() -> component.getMethod("getString"));
    }
}
