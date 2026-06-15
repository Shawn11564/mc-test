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
 * <p>{@code /or} (a CLIENT command — no server round-trip needed) opens {@link RegionsScreen} with
 * a "Regions" button leading to {@link RegionsListScreen}'s "TestRegion" entry. Clicking
 * "TestRegion" prints {@code Region loaded: TestRegion} to the client chat HUD, driving the
 * chat half of the canonical assertion. The widgets implement
 * {@code io.mctest.agent.core.client.TestIdHolder} so the client agent reads stable testIds
 * ({@code regions:root:regions}, {@code regions:entry:TestRegion}) — exactly the testIds the
 * plugin stamps onto its items.
 *
 * <p>The server-truth half (does region "TestRegion" exist on the server?) pairs with a server
 * agent — mocked in M4 CI, the real {@code server-fabric} agent in M5. Until then the
 * {@code assertPluginState} step honestly skips with {@code unmet:[pluginState]}.
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
