package com.example.openregions.client;

import com.mojang.brigadier.CommandDispatcher;

import net.minecraft.client.Minecraft;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraftforge.client.event.RegisterClientCommandsEvent;
import net.minecraftforge.common.MinecraftForge;
import net.minecraftforge.eventbus.api.SubscribeEvent;
import net.minecraftforge.fml.common.Mod;

/**
 * OpenRegions (Forge mod form) — the canonical "regions" SUT as a real client Screen, the Forge twin of
 * the Fabric mod.
 *
 * <p>{@code /or} is registered as a CLIENT command via {@link RegisterClientCommandsEvent}, so the Forge
 * client-command handler intercepts it before it reaches the server and opens {@link RegionsScreen} —
 * taking precedence over the Paper plugin's server-side {@code /or}. (The agent's {@code runCommand} →
 * {@code connection.sendCommand("or")} hits exactly that intercept path.) Client-side only: the event
 * fires only on a physical client, so the Screen classes never load on a dedicated server.
 */
@Mod("openregions")
public final class OpenRegionsClient {

    public OpenRegionsClient() {
        // Register on the FORGE game event bus (not the mod bus) — RegisterClientCommandsEvent lives there.
        MinecraftForge.EVENT_BUS.register(this);
    }

    @SubscribeEvent
    public void onRegisterClientCommands(RegisterClientCommandsEvent event) {
        CommandDispatcher<CommandSourceStack> dispatcher = event.getDispatcher();
        dispatcher.register(
                Commands.literal("or").executes(ctx -> {
                    Minecraft mc = Minecraft.getInstance();
                    mc.execute(() -> mc.setScreen(new RegionsScreen()));
                    return 1;
                }));
    }
}
