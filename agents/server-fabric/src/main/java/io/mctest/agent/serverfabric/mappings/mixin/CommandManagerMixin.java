package io.mctest.agent.serverfabric.mappings.mixin;

import com.mojang.brigadier.ParseResults;
import io.mctest.agent.serverfabric.mappings.MacroCommands;
import net.minecraft.server.command.CommandManager;
import net.minecraft.server.command.ServerCommandSource;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Hears every command the dispatcher is about to execute, for {@code /macro record} and {@code /macro last}
 * (docs/MACROS.md §6). Fabric API has no "command executed" event; this is where NeoForge fires its
 * {@code CommandEvent}. Observes only: the command runs exactly as before.
 */
@Mixin(CommandManager.class)
public abstract class CommandManagerMixin {

    @Inject(method = "execute", at = @At("HEAD"))
    private void mctest$executing(ParseResults<ServerCommandSource> parse, String command, CallbackInfo ci) {
        MacroCommands.executing(parse);
    }
}
