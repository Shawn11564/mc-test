package io.mctest.agent.clientforge.mappings;

import io.mctest.agent.core.ElementModel;
import io.mctest.agent.core.ElementModel.ScreenSnapshot;
import io.mctest.agent.core.client.ClientBridge;
import io.mctest.agent.core.client.TestIdHolder;
import java.io.ByteArrayOutputStream;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import net.minecraft.SharedConstants;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.components.AbstractButton;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.client.gui.components.events.GuiEventListener;
import net.minecraft.client.gui.screens.ConnectScreen;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.client.multiplayer.ServerData;
import net.minecraft.client.multiplayer.resolver.ServerAddress;
import net.minecraft.client.Screenshot;
import net.minecraft.network.chat.Component;
import net.minecraftforge.client.event.ClientChatReceivedEvent;
import net.minecraftforge.common.MinecraftForge;
import net.minecraftforge.eventbus.api.SubscribeEvent;
import net.minecraftforge.fml.loading.FMLLoader;
import net.minecraftforge.fml.ModList;
import org.lwjgl.glfw.GLFW;

/**
 * The Forge (MCP-SRG / official-name-mapped) {@link ClientBridge}: the ONLY file in this module that
 * touches {@code net.minecraft.*} / {@code com.mojang.*} / GLFW symbols. Everything loader-neutral
 * (selector resolution, retries, assertions, result shapes) lives in {@code io.mctest.agent.core} and is
 * exercised there without Minecraft. M5 fan-out re-implements only this file per (loader × MC version) —
 * Prime Directive 2; a CI import-scan fails if a {@code net.minecraft.*} import leaks outside
 * {@code mappings/}.
 *
 * <p>It walks {@code Minecraft.getInstance().screen} into a loader-neutral {@link ScreenSnapshot} (kind
 * {@code "clientScreen"} or {@code "none"}), reads a stable {@code testId} via
 * {@code widget instanceof TestIdHolder}, maps widget classes to selector {@code role}s (DRIVERS.md
 * §2.2), and bounces every UI mutation onto the render thread via {@code Minecraft#execute}.
 */
public final class Names implements ClientBridge {

    private final Minecraft client = Minecraft.getInstance();

    /** Recent client chat lines (plain text), oldest→newest, captured for {@code world.waitForChat}. */
    private final Deque<String> chatLog = new ArrayDeque<>();
    private static final int CHAT_LOG_LIMIT = 256;

    public Names() {
        // Tap the client's RECEIVED chat/game messages so recentChat() (→ world.waitForChat) has data.
        // Forge routes incoming chat through ClientChatReceivedEvent on the Forge client event bus —
        // the realistic path a SUT confirmation ("Region loaded: TestRegion") takes when the server
        // sends it (as the Bukkit regions plugin does). NOTE: a line a mod inserts directly into the
        // local ChatComponent does NOT route through this event; capturing those would need a
        // ChatComponent accessor (a second per-version mapped seam, which Prime Directive 2 keeps out
        // of this one-file shim). The example client mod's direct HUD insert is a client-only
        // simplification — see examples/regions/mod.
        MinecraftForge.EVENT_BUS.register(this);
    }

    /** Forge client-bus tap: record each incoming chat line as plain text. */
    @SubscribeEvent
    public void onClientChat(ClientChatReceivedEvent event) {
        Component message = event.getMessage();
        if (message != null) {
            recordChat(message.getString());
        }
    }

    // --- version strings (loader-specific; supplied to ClientAgent.buildDispatch by the entrypoint) ---

    /** @return the running Minecraft version (e.g. {@code "1.20.1"}). */
    public String mcVersion() {
        return SharedConstants.getCurrentVersion().getName();
    }

    /** @return the Forge loader version (e.g. {@code "47.2.0"}). */
    public String loaderVersion() {
        return ModList.get().getModContainerById("forge")
                .map(c -> c.getModInfo().getVersion().toString())
                .orElseGet(Names::forgeVersionFallback);
    }

    /** Fallback Forge version straight off {@code FMLLoader} when the mod container isn't queryable. */
    private static String forgeVersionFallback() {
        return FMLLoader.versionInfo() != null ? FMLLoader.versionInfo().forgeVersion() : null;
    }

    // --- ClientBridge: screen introspection ---

    @Override
    public ScreenSnapshot snapshot() {
        Screen screen = client.screen;
        ScreenSnapshot snap = new ScreenSnapshot();
        if (screen == null) {
            snap.kind = "none";
            return snap;
        }
        snap.kind = "clientScreen";
        snap.screenId = screen.getClass().getName();
        Component title = screen.getTitle();
        if (title != null) {
            snap.title = title.getString();
            snap.titleRaw = title.getString();
        }
        int index = 0;
        for (GuiEventListener child : screen.children()) {
            collectElement(child, snap.elements, index);
            index++;
        }
        return snap;
    }

    /** Maps one client widget into the loader-neutral {@link ElementModel.Element} shape. */
    private void collectElement(GuiEventListener child, List<ElementModel.Element> out, int index) {
        if (child instanceof AbstractWidget widget) {
            ElementModel.Element el = new ElementModel.Element();
            el.elementId = "el-" + index;
            el.role = roleOf(widget);
            Component message = widget.getMessage();
            if (message != null) {
                el.label = message.getString();
                el.rawLabel = message.getString();
            }
            el.enabled = widget.active;
            el.visible = widget.visible;
            el.testId = readTestId(widget);
            out.add(el);
        }
    }

    /** Reads a stable {@code testId} from cooperating SUT widgets (DRIVERS.md §2.2 / PROTOCOL.md §7.3.2). */
    private static String readTestId(Object widget) {
        return widget instanceof TestIdHolder ? ((TestIdHolder) widget).mcTestId() : null;
    }

    /** Widget class → selector {@code role} (PROTOCOL.md role enum; DRIVERS.md §2.2). */
    private static String roleOf(AbstractWidget widget) {
        if (widget instanceof EditBox) {
            return "input";
        }
        if (widget instanceof Button || widget instanceof AbstractButton) {
            return "button";
        }
        return "listItem";
    }

    // --- ClientBridge: actions (all UI mutation scheduled on the render thread) ---

    @Override
    public boolean clickElement(String elementId, String button, String clickType) {
        Screen before = client.screen;
        AbstractWidget widget = findWidget(before, elementId);
        if (widget == null) {
            return false;
        }
        // Click at the widget centre on the render thread; onPress/onClick fires the SUT handler.
        double cx = widget.getX() + widget.getWidth() / 2.0;
        double cy = widget.getY() + widget.getHeight() / 2.0;
        int mouseButton = glfwMouseButton(button);
        // Click AND read the resulting screen ON the render thread, then block for the result —
        // client.execute() only enqueues, so reading screen off-thread would race the click and report
        // screenChanged=false even when the screen changed (suppressing event.screenChanged).
        return callOnClient(() -> {
            widget.mouseClicked(cx, cy, mouseButton);
            return client.screen != before;
        });
    }

    @Override
    public boolean typeText(String elementId, String text, boolean clear, boolean submit) {
        Screen screen = client.screen;
        AbstractWidget target = elementId != null ? findWidget(screen, elementId) : focusedField(screen);
        if (target instanceof EditBox field) {
            runOnClient(() -> {
                field.setFocused(true);
                if (clear) {
                    field.setValue("");
                }
                // Replay per-char so SUT change-listeners fire (DRIVERS.md §2.2).
                for (int i = 0; i < text.length(); i++) {
                    field.charTyped(text.charAt(i), 0);
                }
                if (submit) {
                    field.keyPressed(GLFW.GLFW_KEY_ENTER, 0, 0);
                }
            });
        }
        return false;
    }

    @Override
    public boolean pressKey(String keyName, int glfwKeyCode, List<String> modifiers) {
        Screen before = client.screen;
        int mods = glfwModifiers(modifiers);
        // Dispatch the key AND sample screen on the render thread (see clickElement).
        return callOnClient(() -> {
            if (client.screen != null) {
                client.screen.keyPressed(glfwKeyCode, 0, mods);
            }
            return client.screen != before;
        });
    }

    @Override
    public boolean closeScreen() {
        // Close AND confirm on the render thread that a screen was actually open and is now gone.
        return callOnClient(() -> {
            if (client.screen == null) {
                return false;
            }
            client.setScreen(null);
            return client.screen == null;
        });
    }

    // --- ClientBridge: framebuffer ---

    @Override
    public byte[] screenshotPng() {
        if (!hasFramebuffer()) {
            return null;
        }
        try {
            // Screenshot.takeScreenshot copies the framebuffer into a NativeImage; encode PNG.
            return callOnClient(() -> {
                try {
                    var image = Screenshot.takeScreenshot(client.getMainRenderTarget());
                    ByteArrayOutputStream out = new ByteArrayOutputStream();
                    out.write(image.asByteArray());
                    image.close();
                    return out.toByteArray();
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
        } catch (RuntimeException e) {
            return null;
        }
    }

    @Override
    public boolean hasFramebuffer() {
        // A real rendered client has a window + framebuffer; a dedicated/headless JVM does not.
        return client.getWindow() != null && client.getMainRenderTarget() != null;
    }

    // --- ClientBridge: world / chat ---

    @Override
    public void joinServer(String host, int port, String username) {
        // Wait for the client's INITIAL resource reload (which compiles the core shaders) to FINISH and
        // the title screen to come up before connecting. Connecting mid-reload makes the world start
        // rendering while `ShaderInstance`s are still null → a render-thread NPE in LevelRenderer
        // (the crash report's "Last reload … Finished: No"). The LoadingOverlay is present for the
        // duration of that reload; once it's gone AND a screen is set, the client is idle at the title
        // screen and safe to connect. Polled off the render thread (we're on the MCTP handler thread),
        // bounded so a stuck load still returns and the join fails honestly rather than hanging.
        long readyDeadline = System.currentTimeMillis() + 120000L;
        while ((client.getOverlay() != null || client.screen == null)
                && System.currentTimeMillis() < readyDeadline) {
            try {
                Thread.sleep(50);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
        }
        // MC 1.20.1's ServerData(name, ip, boolean isLan) predates the 1.20.2+ ServerData.Type enum.
        ServerData info = new ServerData(username, host + ":" + port, false);
        ServerAddress address = new ServerAddress(host, port);
        runOnClient(() -> ConnectScreen.startConnecting(
                new TitleScreen(), client, address, info, false));
        // world.join must mean "joined AND ready". ConnectScreen.startConnecting only INITIATES the
        // connection; client.player stays null for several render ticks afterwards. Without this wait,
        // a command/chat issued immediately after join (e.g. /or) runs while client.player is null and
        // is SILENTLY DROPPED by runCommand/sendChat. Poll OFF the render thread (this runs on the MCTP
        // handler thread) so the render thread stays free to spawn the player; bounded so a failed
        // connect still returns.
        long deadline = System.currentTimeMillis() + 30000L;
        while (client.player == null && System.currentTimeMillis() < deadline) {
            try {
                Thread.sleep(50);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
        }
    }

    @Override
    public void leaveServer() {
        // Tear down the client's connection to the integrated/dedicated server (returns to the menu).
        runOnClient(() -> {
            if (client.level != null) {
                client.level.disconnect();
            }
            client.clearLevel();
        });
    }

    @Override
    public void runCommand(String command) {
        // command has no leading '/'; sendCommand sends a slash command to the server.
        runOnClient(() -> {
            if (client.player != null && client.player.connection != null) {
                client.player.connection.sendCommand(command);
            }
        });
    }

    @Override
    public void sendChat(String message) {
        runOnClient(() -> {
            if (client.player != null && client.player.connection != null) {
                client.player.connection.sendChat(message);
            }
        });
    }

    @Override
    public List<String> recentChat() {
        synchronized (chatLog) {
            return new ArrayList<>(chatLog);
        }
    }

    /**
     * Records a plain client chat line (oldest→newest, ring-buffered) from the {@code @SubscribeEvent}
     * {@code ClientChatReceivedEvent} tap, so {@code world.waitForChat} can poll {@link #recentChat()}.
     */
    private void recordChat(String plain) {
        if (plain == null) {
            return;
        }
        synchronized (chatLog) {
            chatLog.addLast(plain);
            while (chatLog.size() > CHAT_LOG_LIMIT) {
                chatLog.removeFirst();
            }
        }
    }

    // --- helpers (MCP-SRG / official-mapped; confined to this file) ---

    /**
     * Runs {@code body} on the client/render thread and BLOCKS until it finishes. {@code client.execute}
     * only enqueues (it returns immediately off-thread), so any caller that reads post-action client
     * state must go through here — otherwise the read races the still-queued action.
     */
    private void runOnClient(Runnable body) {
        callOnClient(() -> {
            body.run();
            return null;
        });
    }

    /**
     * Schedules {@code body} on the render thread and blocks for its result. Used wherever a bridge
     * primitive must observe the action's effect (e.g. {@code screen} after a click). The MCTP handler
     * thread is never the render thread, so the {@code execute}+{@code join} cannot self-deadlock; the
     * {@code isSameThread()} guard keeps it correct even if a future caller is already on-thread.
     */
    private <T> T callOnClient(java.util.function.Supplier<T> body) {
        if (client.isSameThread()) {
            return body.get();
        }
        CompletableFuture<T> future = new CompletableFuture<>();
        client.execute(() -> {
            try {
                future.complete(body.get());
            } catch (RuntimeException e) {
                future.completeExceptionally(e);
            }
        });
        return future.join();
    }

    /** Resolves the widget core addressed by {@code el-<n>} against the screen's child list order. */
    private AbstractWidget findWidget(Screen screen, String elementId) {
        if (screen == null || elementId == null || !elementId.startsWith("el-")) {
            return null;
        }
        int wanted;
        try {
            wanted = Integer.parseInt(elementId.substring("el-".length()));
        } catch (NumberFormatException e) {
            return null;
        }
        int index = 0;
        for (GuiEventListener child : screen.children()) {
            if (index == wanted && child instanceof AbstractWidget widget) {
                return widget;
            }
            index++;
        }
        return null;
    }

    /** Best-effort focused text field on the current screen (for {@code typeText} with no selector). */
    private AbstractWidget focusedField(Screen screen) {
        // Screen IS-A ContainerEventHandler in 1.20.1, so getFocused() is available directly (an
        // `instanceof ContainerEventHandler` pattern would be an always-true compile error).
        if (screen == null) {
            return null;
        }
        GuiEventListener focused = screen.getFocused();
        if (focused instanceof EditBox field) {
            return field;
        }
        return null;
    }

    /** Maps the MCTP {@code button} token to a GLFW mouse button (left default). */
    private static int glfwMouseButton(String button) {
        if (button != null && button.equalsIgnoreCase("right")) {
            return GLFW.GLFW_MOUSE_BUTTON_RIGHT;
        }
        if (button != null && button.equalsIgnoreCase("middle")) {
            return GLFW.GLFW_MOUSE_BUTTON_MIDDLE;
        }
        return GLFW.GLFW_MOUSE_BUTTON_LEFT;
    }

    /** ORs the semantic modifier names into the GLFW modifier bitmask. */
    private static int glfwModifiers(List<String> modifiers) {
        int mods = 0;
        if (modifiers != null) {
            for (String m : modifiers) {
                if (m == null) {
                    continue;
                }
                switch (m.toLowerCase(java.util.Locale.ROOT)) {
                    case "shift" -> mods |= GLFW.GLFW_MOD_SHIFT;
                    case "ctrl", "control" -> mods |= GLFW.GLFW_MOD_CONTROL;
                    case "alt" -> mods |= GLFW.GLFW_MOD_ALT;
                    case "super", "meta" -> mods |= GLFW.GLFW_MOD_SUPER;
                    default -> {
                        // Unknown modifier — ignore (core already resolved the primary key code).
                    }
                }
            }
        }
        return mods;
    }
}
