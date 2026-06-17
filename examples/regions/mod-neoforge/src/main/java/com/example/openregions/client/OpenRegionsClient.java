package com.example.openregions.client;

import com.mojang.brigadier.CommandDispatcher;

import net.minecraft.client.Minecraft;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.common.Mod;
import net.neoforged.neoforge.client.event.RegisterClientCommandsEvent;
import net.neoforged.neoforge.common.NeoForge;

/**
 * OpenRegions (NeoForge mod form) — the canonical "regions" SUT as a real client Screen, the NeoForge
 * twin of the Fabric/Forge mods.
 *
 * <p>{@code /or} is registered as a CLIENT command via {@link RegisterClientCommandsEvent} (fired on the
 * NeoForge game event bus), so the client-command handler intercepts it before the server and opens
 * {@link RegionsScreen} — taking precedence over the Paper plugin's server-side {@code /or}. The whole
 * mod is {@code dist = CLIENT}, so it never loads on a dedicated server.
 */
@Mod(value = "openregions", dist = Dist.CLIENT)
public final class OpenRegionsClient {

    public OpenRegionsClient(IEventBus modEventBus) {
        // RegisterClientCommandsEvent fires on the GAME bus (NeoForge.EVENT_BUS), not the mod bus.
        NeoForge.EVENT_BUS.addListener(this::onRegisterClientCommands);
    }

    private void onRegisterClientCommands(RegisterClientCommandsEvent event) {
        CommandDispatcher<CommandSourceStack> dispatcher = event.getDispatcher();
        dispatcher.register(
                Commands.literal("or").executes(ctx -> {
                    Minecraft mc = Minecraft.getInstance();
                    mc.execute(() -> mc.setScreen(new RegionsScreen()));
                    return 1;
                }));
    }
}
