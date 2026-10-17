package io.mctest.agent.serverfabric.mappings;

import java.util.function.Consumer;
import net.minecraft.server.command.CommandOutput;
import net.minecraft.server.command.ServerCommandSource;
import net.minecraft.text.Text;
import net.minecraft.text.TextColor;
import net.minecraft.util.Formatting;

/**
 * Whether one command worked, for the macro runner (docs/MACROS.md §5). A command can fail three ways: it
 * never runs (a syntax error: the dispatcher reports it and calls nothing back), it throws (vanilla's
 * "No items were found"), or it returns 0 after telling its source off in red, which is how most mods'
 * commands refuse. Returning 0 alone isn't a failure: {@code /gamerule doDaylightCycle false} returns 0.
 * The Yarn twin of server-neoforge's {@code CommandOutcome}.
 */
public final class CommandOutcome {

    private static final TextColor RED = TextColor.fromFormatting(Formatting.RED);

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
    public ServerCommandSource watch(ServerCommandSource source, CommandOutput delegate, Consumer<Text> tap) {
        return source.withOutput(new Watching(delegate, tap)).withReturnValueConsumer((ok, value) -> {
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

    private final class Watching implements CommandOutput {
        private final CommandOutput delegate;
        private final Consumer<Text> tap;

        Watching(CommandOutput delegate, Consumer<Text> tap) {
            this.delegate = delegate;
            this.tap = tap;
        }

        @Override
        public void sendMessage(Text message) {
            if (RED.equals(message.getStyle().getColor())) {
                saidFailure = true;
            }
            if (tap != null) {
                tap.accept(message);
            }
            delegate.sendMessage(message);
        }

        @Override
        public boolean shouldReceiveFeedback() {
            return delegate.shouldReceiveFeedback();
        }

        @Override
        public boolean shouldTrackOutput() {
            return delegate.shouldTrackOutput();
        }

        @Override
        public boolean shouldBroadcastConsoleToOps() {
            return delegate.shouldBroadcastConsoleToOps();
        }

        @Override
        public boolean cannotBeSilenced() {
            return delegate.cannotBeSilenced();
        }
    }
}
