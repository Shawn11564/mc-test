package com.example.openregions.client;

import com.mojang.brigadier.CommandDispatcher;

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.command.v2.ClientCommandManager;
import net.fabricmc.fabric.api.client.command.v2.ClientCommandRegistrationCallback;
import net.fabricmc.fabric.api.client.command.v2.FabricClientCommandSource;
import net.minecraft.client.MinecraftClient;

/**
 * OpenRegions (mod form) — the canonical "regions" SUT in CLIENT-GUI form.
 *
 * <p>This is the client-side twin of {@code OpenRegionsPlugin} (the chest-menu plugin). Where the
 * plugin draws a server-driven container GUI a headless bot can reach, this mod draws a real
 * <em>client</em> {@code Screen} that ONLY the in-process client driver can see — so it is the
 * negative-control SUT proving "clientScreens" is genuinely needed (the headless bot provably
 * cannot inspect or click these widgets).
 *
 * <p>{@code /or} (a CLIENT command — no server round-trip needed) opens {@link RegionsScreen}, whose
 * "Regions" button leads to {@link RegionsListScreen}: a list of region entries (load), a name field
 * + "Create", and "Delete". Loading/creating/deleting prints {@code Region loaded/created/deleted:
 * <name>} via a chat line that round-trips through the server, driving the chat half of the
 * assertions. Widgets implement {@code io.mctest.agent.core.client.TestIdHolder} so an agent can read
 * stable testIds — exactly the testIds the plugin stamps — but the cross-loader test selects by label
 * + the input's role, so it does not depend on testId visibility across mod classloaders.
 *
 * <p>The server-truth half (does region X exist on the server?) is authored separately: a client mod
 * cannot mutate server state, so the rendered test SEEDS the server via a {@code fixture} step
 * (handled by the Paper-side {@code server-bukkit} agent + the plugin's fixture provider) and asserts
 * {@code regions.exists} against that. With no server agent the {@code assertPluginState} step honestly
 * skips with {@code unmet:[pluginState]} — the chat half still proves the GUI flow.
 */
public final class OpenRegionsClient implements ClientModInitializer {

  @Override
  public void onInitializeClient() {
    ClientCommandRegistrationCallback.EVENT.register((dispatcher, registryAccess) -> registerOrCommand(dispatcher));
  }

  private static void registerOrCommand(CommandDispatcher<FabricClientCommandSource> dispatcher) {
    dispatcher.register(
        ClientCommandManager.literal("or").executes(ctx -> {
          // Open the root Screen on the client/render thread.
          MinecraftClient client = ctx.getSource().getClient();
          client.execute(() -> client.setScreen(new RegionsScreen()));
          return 1;
        }));
  }
}
