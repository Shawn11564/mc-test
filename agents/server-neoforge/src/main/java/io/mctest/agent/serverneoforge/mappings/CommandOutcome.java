package io.mctest.agent.serverneoforge.mappings;

import java.util.function.Consumer;
import net.minecraft.ChatFormatting;
import net.minecraft.commands.CommandSource;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.TextColor;

/**
 * Whether one command worked, for the macro runner (docs/MACROS.md §5). A command can fail three ways: it
 * never runs (a syntax error: the dispatcher reports it and calls nothing back), it throws (vanilla's
 * "No items were found"), or it returns 0 after telling its source off in red, which is how most mods'
 * commands refuse. Returning 0 alone isn't a failure: {@code /gamerule doDaylightCycle false} returns 0.
 */
public final class CommandOutcome {

    private static final TextColor RED = TextColor.fromLegacyFormat(ChatFormatting.RED);

    private final String who;
    private final String command;
    private boolean ran;
    private boolean success;
    private int result;
    private boolean saidFailure;

    public CommandOutcome(String who, String command) {
        this.who = who;
        this.command = command;
    }

    /**
     * {@code source}, reporting its result to this outcome. Messages still reach {@code delegate} (the player
     * or the console) unchanged; {@code tap}, if given, sees each one too.
     */
    public CommandSourceStack watch(CommandSourceStack source, CommandSource delegate, Consumer<Component> tap) {
        return source.withSource(new Watching(delegate, tap)).withCallback((ok, value) -> {
            ran = true;
            success = ok;
            result = value;
        });
    }

    public boolean failed() {
        return !ran || !success || (result == 0 && saidFailure);
    }

    /** Why it failed, for the macro's stop message; the command's own red message says the rest. */
    public String why() {
        String what = who + "'s /" + command;
        return !ran ? what + " didn't run" : what + " failed";
    }

    private final class Watching implements CommandSource {
        private final CommandSource delegate;
        private final Consumer<Component> tap;

        Watching(CommandSource delegate, Consumer<Component> tap) {
            this.delegate = delegate;
            this.tap = tap;
        }

        @Override
        public void sendSystemMessage(Component message) {
            if (RED.equals(message.getStyle().getColor())) {
                saidFailure = true;
            }
            if (tap != null) {
                tap.accept(message);
            }
            delegate.sendSystemMessage(message);
        }

        @Override
        public boolean acceptsSuccess() {
            return delegate.acceptsSuccess();
        }

        @Override
        public boolean acceptsFailure() {
            return delegate.acceptsFailure();
        }

        @Override
        public boolean shouldInformAdmins() {
            return delegate.shouldInformAdmins();
        }

        @Override
        public boolean alwaysAccepts() {
            return delegate.alwaysAccepts();
        }
    }
}
