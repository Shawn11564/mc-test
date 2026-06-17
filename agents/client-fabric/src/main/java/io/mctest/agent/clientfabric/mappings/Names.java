package io.mctest.agent.clientfabric.mappings;

import io.mctest.agent.core.ElementModel;
import io.mctest.agent.core.ElementModel.ScreenSnapshot;
import io.mctest.agent.core.client.ClientBridge;
import io.mctest.agent.core.client.TestIdHolder;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import net.fabricmc.fabric.api.client.message.v1.ClientReceiveMessageEvents;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.Element;
import net.minecraft.client.gui.ParentElement;
import net.minecraft.client.gui.screen.Screen;
import net.minecraft.client.gui.screen.TitleScreen;
import net.minecraft.client.gui.screen.multiplayer.ConnectScreen;
import net.minecraft.client.gui.widget.ButtonWidget;
import net.minecraft.client.gui.widget.ClickableWidget;
import net.minecraft.client.gui.widget.PressableWidget;
import net.minecraft.client.gui.widget.TextFieldWidget;
import net.minecraft.client.network.ServerAddress;
import net.minecraft.client.network.ServerInfo;
import net.minecraft.client.util.ScreenshotRecorder;
import net.minecraft.text.Text;
import org.lwjgl.glfw.GLFW;

/**
 * The Fabric (Yarn-mapped) {@link ClientBridge}: the ONLY file in this module that touches
 * {@code net.minecraft.*} / Yarn symbols. Everything loader-neutral (selector resolution, retries,
 * assertions, result shapes) lives in {@code io.mctest.agent.core} and is exercised there without
 * Minecraft. M5 fan-out re-implements only this file per (loader × MC version) — Prime Directive 2; a
 * CI import-scan fails if a {@code net.minecraft.*} import leaks outside {@code mappings/}.
 *
 * <p>It walks {@code MinecraftClient.getInstance().currentScreen} into a loader-neutral
 * {@link ScreenSnapshot} (kind {@code "clientScreen"} or {@code "none"}), reads a stable {@code testId}
 * via {@code widget instanceof TestIdHolder}, maps widget classes to selector {@code role}s
 * (DRIVERS.md §2.2), and bounces every UI mutation onto the render thread via
 * {@code MinecraftClient#execute}.
 */
public final class Names implements ClientBridge {

    private final MinecraftClient client = MinecraftClient.getInstance();

    /** Recent client chat lines (plain text), oldest→newest, captured for {@code world.waitForChat}. */
    private final Deque<String> chatLog = new ArrayDeque<>();
    private static final int CHAT_LOG_LIMIT = 256;

    public Names() {
        // Tap the client's RECEIVED chat/game messages so recentChat() (→ world.waitForChat) has data.
        // These events fire for messages the client receives over the network — the realistic path a SUT
        // confirmation ("Region loaded: TestRegion") takes when the server sends it (as the Bukkit regions
        // plugin does). NOTE: a line a mod inserts directly into the local ChatHud (ChatHud.addMessage)
        // does NOT route through these events; capturing those would need a ChatHud accessor (a second
        // per-version mapped class, which Prime Directive 2 keeps out of this one-file shim). The example
        // client mod's direct HUD insert is a client-only simplification — see examples/regions/mod.
        ClientReceiveMessageEvents.GAME.register((message, overlay) -> recordChat(message.getString()));
        ClientReceiveMessageEvents.CHAT.register((message, signedMessage, sender, params, receptionTime) ->
                recordChat(message.getString()));
    }

    // --- version strings (loader-specific; supplied to ClientAgent.buildDispatch by the entrypoint) ---

    /** @return the running Minecraft version (e.g. {@code "1.21.1"}). */
    public String mcVersion() {
        return FabricLoader.getInstance().getModContainer("minecraft")
                .map(m -> m.getMetadata().getVersion().getFriendlyString())
                .orElse(null);
    }

    /** @return the Fabric loader version (e.g. {@code "0.16.5"}). */
    public String loaderVersion() {
        return FabricLoader.getInstance().getModContainer("fabricloader")
                .map(m -> m.getMetadata().getVersion().getFriendlyString())
                .orElse(null);
    }

    // --- ClientBridge: screen introspection ---

    @Override
    public ScreenSnapshot snapshot() {
        Screen screen = client.currentScreen;
        ScreenSnapshot snap = new ScreenSnapshot();
        if (screen == null) {
            snap.kind = "none";
            return snap;
        }
        snap.kind = "clientScreen";
        snap.screenId = screen.getClass().getName();
        Text title = screen.getTitle();
        if (title != null) {
            snap.title = title.getString();
            snap.titleRaw = title.getString();
        }
        int index = 0;
        for (Element child : screen.children()) {
            collectElement(child, snap.elements, index);
            index++;
        }
        return snap;
    }

    /** Maps one client widget into the loader-neutral {@link ElementModel.Element} shape. */
    private void collectElement(Element child, List<ElementModel.Element> out, int index) {
        if (child instanceof ClickableWidget widget) {
            ElementModel.Element el = new ElementModel.Element();
            el.elementId = "el-" + index;
            el.role = roleOf(widget);
            Text message = widget.getMessage();
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
    private static String roleOf(ClickableWidget widget) {
        if (widget instanceof TextFieldWidget) {
            return "input";
        }
        if (widget instanceof ButtonWidget || widget instanceof PressableWidget) {
            return "button";
        }
        return "listItem";
    }

    // --- ClientBridge: actions (all UI mutation scheduled on the render thread) ---

    @Override
    public boolean clickElement(String elementId, String button, String clickType) {
        Screen before = client.currentScreen;
        ClickableWidget widget = findWidget(before, elementId);
        if (widget == null) {
            return false;
        }
        // Click at the widget centre on the render thread; onPress/onClick fires the SUT handler.
        double cx = widget.getX() + widget.getWidth() / 2.0;
        double cy = widget.getY() + widget.getHeight() / 2.0;
        int mouseButton = glfwMouseButton(button);
        // Click AND read the resulting screen ON the render thread, then block for the result —
        // client.execute() only enqueues, so reading currentScreen off-thread would race the click
        // and report screenChanged=false even when the screen changed (suppressing event.screenChanged).
        return callOnClient(() -> {
            widget.mouseClicked(cx, cy, mouseButton);
            return client.currentScreen != before;
        });
    }

    @Override
    public boolean typeText(String elementId, String text, boolean clear, boolean submit) {
        Screen screen = client.currentScreen;
        ClickableWidget target = elementId != null ? findWidget(screen, elementId) : focusedField(screen);
        if (target instanceof TextFieldWidget field) {
            runOnClient(() -> {
                field.setFocused(true);
                if (clear) {
                    field.setText("");
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
        Screen before = client.currentScreen;
        int mods = glfwModifiers(modifiers);
        // Dispatch the key AND sample currentScreen on the render thread (see clickElement).
        return callOnClient(() -> {
            if (client.currentScreen != null) {
                client.currentScreen.keyPressed(glfwKeyCode, 0, mods);
            }
            return client.currentScreen != before;
        });
    }

    @Override
    public boolean closeScreen() {
        // Close AND confirm on the render thread that a screen was actually open and is now gone.
        return callOnClient(() -> {
            if (client.currentScreen == null) {
                return false;
            }
            client.setScreen(null);
            return client.currentScreen == null;
        });
    }

    // --- ClientBridge: framebuffer ---

    @Override
    public byte[] screenshotPng() {
        if (!hasFramebuffer()) {
            return null;
        }
        try {
            // ScreenshotRecorder.takeScreenshot copies the framebuffer into a NativeImage; encode PNG.
            // NativeImage.writeTo only accepts File/Path (the OutputStream overload was removed at
            // 1.20.x), so we round-trip through a temp file to obtain the PNG bytes.
            return callOnClient(() -> {
                try {
                    var image = ScreenshotRecorder.takeScreenshot(client.getFramebuffer());
                    java.nio.file.Path tmp = java.nio.file.Files.createTempFile("mctp-shot", ".png");
                    image.writeTo(tmp);
                    image.close();
                    byte[] bytes = java.nio.file.Files.readAllBytes(tmp);
                    java.nio.file.Files.deleteIfExists(tmp);
                    return bytes;
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
        return client.getWindow() != null && client.getFramebuffer() != null;
    }

    // --- ClientBridge: world / chat ---

    @Override
    public void joinServer(String host, int port, String username) {
        ServerInfo info = new ServerInfo(username, host + ":" + port, ServerInfo.ServerType.OTHER);
        ServerAddress address = new ServerAddress(host, port);
        runOnClient(() -> ConnectScreen.connect(
                new TitleScreen(), client, address, info, false, null));
        // world.join must mean "joined AND ready". ConnectScreen.connect only INITIATES the connection;
        // client.player stays null for several render ticks afterwards. Without this wait, a command or
        // chat issued immediately after join (e.g. /or) runs while client.player is null and is SILENTLY
        // DROPPED by runCommand/sendChat — the screen never opens and waitForScreen times out. Poll OFF
        // the render thread (joinServer runs on the MCTP handler thread, not the render thread) so the
        // render thread stays free to spawn the player; bounded so a failed connect still returns.
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
        runOnClient(client::disconnect);
    }

    @Override
    public void runCommand(String command) {
        // command has no leading '/'; sendCommand sends a slash command to the server.
        runOnClient(() -> {
            if (client.player != null && client.player.networkHandler != null) {
                client.player.networkHandler.sendCommand(command);
            }
        });
    }

    @Override
    public void sendChat(String message) {
        runOnClient(() -> {
            if (client.player != null && client.player.networkHandler != null) {
                client.player.networkHandler.sendChatMessage(message);
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
     * Records a plain client chat line (oldest→newest, ring-buffered) from the constructor's
     * {@code ClientReceiveMessageEvents} taps, so {@code world.waitForChat} can poll {@link #recentChat()}.
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

    // --- helpers (Yarn-mapped; confined to this file) ---

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
     * primitive must observe the action's effect (e.g. {@code currentScreen} after a click). The MCTP
     * handler thread is never the render thread, so the {@code execute}+{@code join} cannot self-deadlock;
     * the {@code isOnThread()} guard keeps it correct even if a future caller is already on-thread.
     */
    private <T> T callOnClient(java.util.function.Supplier<T> body) {
        if (client.isOnThread()) {
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
    private ClickableWidget findWidget(Screen screen, String elementId) {
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
        for (Element child : screen.children()) {
            if (index == wanted && child instanceof ClickableWidget widget) {
                return widget;
            }
            index++;
        }
        return null;
    }

    /** Best-effort focused text field on the current screen (for {@code typeText} with no selector). */
    private ClickableWidget focusedField(Screen screen) {
        if (screen instanceof ParentElement parent) {
            Element focused = parent.getFocused();
            if (focused instanceof TextFieldWidget field) {
                return field;
            }
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
