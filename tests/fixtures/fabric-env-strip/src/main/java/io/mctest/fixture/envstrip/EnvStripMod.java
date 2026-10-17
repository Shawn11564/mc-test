package io.mctest.fixture.envstrip;

import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.minecraft.server.command.CommandManager;
import net.minecraft.text.Text;

/**
 * {@code /covfix plain} runs {@link Plain}, {@code /covfix shared} runs {@link Shared}: one check each, so the
 * coverage spike can tell them apart.
 */
public final class EnvStripMod implements ModInitializer {

    @Override
    public void onInitialize() {
        CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) -> dispatcher.register(
                CommandManager.literal("covfix")
                        .then(CommandManager.literal("plain").executes(ctx -> {
                            ctx.getSource().sendFeedback(() -> Text.literal(Plain.describe(3)), false);
                            return 1;
                        }))
                        .then(CommandManager.literal("shared").executes(ctx -> {
                            ctx.getSource().sendFeedback(() -> Text.literal(Shared.serverSide(4)), false);
                            return 1;
                        }))));
    }
}
