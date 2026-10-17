package io.mctest.agent.serverfabric.mappings;

import com.mojang.brigadier.ParseResults;
import com.mojang.brigadier.arguments.IntegerArgumentType;
import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.builder.LiteralArgumentBuilder;
import com.mojang.brigadier.builder.RequiredArgumentBuilder;
import com.mojang.brigadier.context.CommandContext;
import com.mojang.brigadier.suggestion.Suggestions;
import com.mojang.brigadier.suggestion.SuggestionsBuilder;
import com.mojang.logging.LogUtils;
import io.mctest.agent.core.bench.Args;
import io.mctest.agent.core.bench.CommandLog;
import io.mctest.agent.core.bench.Macro;
import io.mctest.agent.core.bench.MacroEditor;
import io.mctest.agent.core.bench.MacroLayout;
import io.mctest.agent.core.bench.MacroLibrary;
import io.mctest.agent.core.bench.MacroMenu;
import io.mctest.agent.core.bench.MacroRun;
import io.mctest.agent.core.bench.MacroSource;
import io.mctest.agent.core.bench.MacroSource.EditException;
import io.mctest.agent.core.bench.Problem;
import io.mctest.agent.core.bench.ToldLog;
import io.mctest.agent.serverfabric.players.FakePlayerManager;
import java.io.IOException;
import java.nio.file.Path;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import net.fabricmc.fabric.api.networking.v1.ServerPlayConnectionEvents;
import java.util.UUID;
import java.util.Deque;
import java.util.ArrayDeque;
import java.nio.file.Files;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CompletableFuture;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.minecraft.command.CommandSource;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.command.CommandManager;
import net.minecraft.server.command.CommandOutput;
import net.minecraft.server.command.ServerCommandSource;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.text.ClickEvent;
import net.minecraft.text.HoverEvent;
import net.minecraft.text.MutableText;
import net.minecraft.text.Text;
import net.minecraft.util.Formatting;
import org.slf4j.Logger;

/**
 * The in-game {@code /macro} command (docs/MACROS.md) on Fabric: saved, parameterized command groups for manual
 * play testing, read from the project's {@code .macro} files. The Yarn twin of server-neoforge's
 * {@code MacroCommands}; the engine (parsing, arguments, running, the told-log, recording) is the shared
 * game-free {@code io.mctest.agent.core.bench}. A bench convenience next to {@code /actor}, not a test path.
 *
 * <pre>
 * /macro                        — the macro menu: every macro, drag them around, open one to see and edit it
 * /m &lt;name&gt; [args]              — run a macro (/macro run &lt;name&gt; [args] where /m is taken)
 * /macro again [args]           — run the last one again, with some arguments changed
 * /macro list [filter]          /macro show &lt;name&gt;      /macro reload
 * /macro stop                   /macro continue        — end a macro, or go on after a pause
 * /macro record start|save &lt;name&gt;|cancel             /macro last &lt;n&gt; as &lt;name&gt;
 * /macro new &lt;name&gt; [params]    /macro copy &lt;name&gt; &lt;new&gt;   /macro delete &lt;name&gt;   /macro undo
 * /macro edit &lt;name&gt; step|insert &lt;n&gt; &lt;step&gt; | add &lt;step&gt; | remove &lt;n&gt; | move &lt;n&gt; &lt;to&gt;
 *                    | header &lt;name&gt; [params] | describe [text] | book
 * </pre>
 *
 * <p>Fabric API has no "command executed" event, so recording hears typed commands through
 * {@code mixin/CommandManagerMixin}, at the head of {@code CommandManager.execute}: the same point NeoForge
 * fires {@code CommandEvent}.
 */
public final class MacroCommands {

    private static final Logger LOGGER = LogUtils.getLogger();

    /** Set by {@link #install}; called by the mixin for every command the dispatcher executes. */
    private static volatile MacroCommands instance;

    private final FakePlayerManager actors;
    private final Names names;
    private final MacroLibrary library;
    private final MacroLayout layout;
    private final MacroEditor editor;
    private final ToldLog told = new ToldLog();
    private final CommandLog commandLog = new CommandLog();
    private final Map<String, MacroRun> runs = new LinkedHashMap<>();
    /** Each invoker's last macro and its arguments, for {@code /macro again}. */
    private final Map<String, Map.Entry<String, Map<String, String>>> lastRun = new HashMap<>();
    private MinecraftServer server;
    /** True while a macro step runs, so its commands aren't recorded as typed. */
    private boolean running;
    /** Whether {@code /m} is ours. */
    private boolean shortForm;

    /** Menu actions that wait for the click being handled to finish (opening, closing a menu). */
    private final Deque<Runnable> later = new ArrayDeque<>();
    /** Who asked for text through chat from the menu, and when: the menu opens again once their command works. */
    private final Map<String, Long> reopen = new HashMap<>();

    private MacroCommands(FakePlayerManager actors, Names names, MacroLibrary library) {
        this.actors = actors;
        this.names = names;
        this.library = library;
        Path folder = library.recordFolder();
        this.layout = new MacroLayout(folder == null ? null : folder.resolve(MacroLayout.FILE));
        this.editor = new MacroEditor(library, layout);
    }

    /** Registers {@code /macro} and {@code /m}; call once at mod init. Macros come from {@code MCTEST_MACROS}. */
    public static void install(FakePlayerManager actors) {
        MacroLibrary library = new MacroLibrary(MacroLibrary.folders(System.getenv("MCTEST_MACROS"), Path.of("macros")));
        MacroCommands macros = new MacroCommands(actors, actors.names(), library);
        actors.names().setToldListener(macros.told::record);
        CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) ->
                macros.register(dispatcher));
        ServerTickEvents.END_SERVER_TICK.register(macros::tick);
        ServerPlayConnectionEvents.DISCONNECT.register((handler, server) -> MacroMenus.dropBook(handler.player));
        instance = macros;
        LOGGER.info("[mc-test] Macros are read from {}", library.folders());
    }

    /** From {@code mixin/CommandManagerMixin}: a command is about to execute. */
    public static void executing(ParseResults<ServerCommandSource> parse) {
        MacroCommands macros = instance;
        if (macros != null) {
            macros.typed(parse);
        }
    }

    // --- registration ---

    private void register(com.mojang.brigadier.CommandDispatcher<ServerCommandSource> dispatcher) {
        LiteralArgumentBuilder<ServerCommandSource> root = CommandManager.literal("macro")
                .requires(src -> src.hasPermissionLevel(2))
                .executes(ctx -> openMenu(ctx, null));
        root.then(CommandManager.literal("menu").executes(ctx -> openMenu(ctx, null))
                .then(CommandManager.argument("name", StringArgumentType.word()).suggests(this::suggestNames)
                        .executes(ctx -> openMenu(ctx, name(ctx)))));
        root.then(CommandManager.literal("help").executes(this::help));
        root.then(CommandManager.literal("run").then(runArguments()));
        root.then(CommandManager.literal("again")
                .executes(ctx -> again(ctx, ""))
                .then(CommandManager.argument("args", StringArgumentType.greedyString())
                        .executes(ctx -> again(ctx, StringArgumentType.getString(ctx, "args")))));
        root.then(CommandManager.literal("list")
                .executes(ctx -> list(ctx, ""))
                .then(CommandManager.argument("filter", StringArgumentType.word())
                        .executes(ctx -> list(ctx, StringArgumentType.getString(ctx, "filter")))));
        root.then(CommandManager.literal("show").then(CommandManager.argument("name", StringArgumentType.word())
                .suggests(this::suggestNames)
                .executes(this::show)));
        root.then(CommandManager.literal("reload").executes(this::reload));
        root.then(CommandManager.literal("stop").executes(this::stop));
        root.then(CommandManager.literal("continue").executes(this::resume));
        root.then(CommandManager.literal("record")
                .then(CommandManager.literal("start").executes(this::recordStart))
                .then(CommandManager.literal("cancel").executes(this::recordCancel))
                .then(CommandManager.literal("save").then(CommandManager.argument("name", StringArgumentType.word())
                        .executes(this::recordSave))));
        root.then(CommandManager.literal("last").then(CommandManager.argument("count",
                        IntegerArgumentType.integer(1, CommandLog.KEEP))
                .then(CommandManager.literal("as").then(CommandManager.argument("name", StringArgumentType.word())
                        .executes(this::saveLast)))));
        registerEditing(root);
        dispatcher.register(root);

        // The short form, unless a mod already owns /m.
        if (dispatcher.getRoot().getChild("m") == null) {
            dispatcher.register(CommandManager.literal("m").requires(src -> src.hasPermissionLevel(2))
                    .executes(ctx -> openMenu(ctx, null))
                    .then(runArguments()));
            shortForm = true;
        } else {
            shortForm = false;
            LOGGER.info("[mc-test] /m is taken by another mod; use /macro run <name>");
        }
    }

    /** {@code /macro edit …}, {@code new}, {@code copy}, {@code delete}, {@code undo}: changing the files (§8). */
    private void registerEditing(LiteralArgumentBuilder<ServerCommandSource> root) {
        root.then(CommandManager.literal("new").then(CommandManager.argument("header", StringArgumentType.greedyString())
                .executes(ctx -> edit(ctx, who -> editor.create(who, text(ctx, "header"), null)))));
        root.then(CommandManager.literal("copy").then(nameArgument()
                .then(CommandManager.argument("copy", StringArgumentType.word())
                        .executes(ctx -> edit(ctx, who -> editor.copy(who, name(ctx), text(ctx, "copy")))))));
        root.then(CommandManager.literal("delete").then(nameArgument()
                .executes(ctx -> edit(ctx, who -> editor.delete(who, name(ctx))))));
        root.then(CommandManager.literal("undo").executes(ctx -> edit(ctx, editor::undo)));
        root.then(CommandManager.literal("book").then(CommandManager.literal("cancel").executes(this::bookCancel)));
        root.then(CommandManager.literal("edit").then(nameArgument()
                .then(CommandManager.literal("step").then(number("n").then(stepArgument()
                        .executes(ctx -> edit(ctx, who -> editor.setStep(who, name(ctx), n(ctx, "n"), text(ctx, "step")))))))
                .then(CommandManager.literal("add").then(stepArgument()
                        .executes(ctx -> edit(ctx, who -> editor.addStep(who, name(ctx), text(ctx, "step"))))))
                .then(CommandManager.literal("insert").then(number("n").then(stepArgument()
                        .executes(ctx -> edit(ctx, who -> editor.insertStep(who, name(ctx), n(ctx, "n"), text(ctx, "step")))))))
                .then(CommandManager.literal("remove").then(number("n")
                        .executes(ctx -> edit(ctx, who -> editor.removeStep(who, name(ctx), n(ctx, "n"))))))
                .then(CommandManager.literal("move").then(number("n").then(number("to")
                        .executes(ctx -> edit(ctx, who -> editor.moveStep(who, name(ctx), n(ctx, "n"), n(ctx, "to")))))))
                .then(CommandManager.literal("header").then(CommandManager.argument("header", StringArgumentType.greedyString())
                        .executes(ctx -> edit(ctx, who -> editor.setHeader(who, name(ctx), text(ctx, "header"))))))
                .then(CommandManager.literal("describe")
                        .executes(ctx -> edit(ctx, who -> editor.describe(who, name(ctx), "")))
                        .then(CommandManager.argument("text", StringArgumentType.greedyString())
                                .executes(ctx -> edit(ctx, who -> editor.describe(who, name(ctx), text(ctx, "text"))))))
                .then(CommandManager.literal("book").executes(this::book))));
    }

    private RequiredArgumentBuilder<ServerCommandSource, String> nameArgument() {
        return CommandManager.argument("name", StringArgumentType.word()).suggests(this::suggestNames);
    }

    private static RequiredArgumentBuilder<ServerCommandSource, String> stepArgument() {
        return CommandManager.argument("step", StringArgumentType.greedyString());
    }

    private static RequiredArgumentBuilder<ServerCommandSource, Integer> number(String name) {
        return CommandManager.argument(name, IntegerArgumentType.integer(1));
    }

    private static String name(CommandContext<ServerCommandSource> ctx) {
        return StringArgumentType.getString(ctx, "name");
    }

    private static String text(CommandContext<ServerCommandSource> ctx, String argument) {
        return StringArgumentType.getString(ctx, argument);
    }

    private static int n(CommandContext<ServerCommandSource> ctx, String argument) {
        return IntegerArgumentType.getInteger(ctx, argument);
    }

    private CompletableFuture<Suggestions> suggestNames(CommandContext<ServerCommandSource> ctx, SuggestionsBuilder builder) {
        return CommandSource.suggestMatching(library.all().keySet(), builder);
    }

    private RequiredArgumentBuilder<ServerCommandSource, String> runArguments() {
        return CommandManager.argument("name", StringArgumentType.word())
                .suggests(this::suggestNames)
                .executes(ctx -> run(ctx, ""))
                .then(CommandManager.argument("args", StringArgumentType.greedyString())
                        .suggests(this::suggestArgs)
                        .executes(ctx -> run(ctx, StringArgumentType.getString(ctx, "args"))));
    }

    /** Unfilled {@code param=}s, and player names (bare, or after the {@code =} being typed). */
    private CompletableFuture<Suggestions> suggestArgs(CommandContext<ServerCommandSource> ctx, SuggestionsBuilder builder) {
        Macro macro = library.all().get(StringArgumentType.getString(ctx, "name"));
        if (macro == null) {
            return builder.buildFuture();
        }
        String typed = builder.getRemaining();
        int lastSpace = typed.lastIndexOf(' ');
        String current = typed.substring(lastSpace + 1);
        SuggestionsBuilder at = builder.createOffset(builder.getStart() + lastSpace + 1);
        List<String> players = new ArrayList<>(ctx.getSource().getPlayerNames());
        int eq = current.indexOf('=');
        List<String> options = new ArrayList<>();
        if (eq > 0) {
            for (String p : players) {
                options.add(current.substring(0, eq + 1) + p);
            }
        } else {
            for (Macro.Param p : macro.params()) {
                if (!typed.contains(p.name() + "=")) {
                    options.add(p.name() + "=");
                }
            }
            options.addAll(players);
        }
        return CommandSource.suggestMatching(options, at);
    }

    // --- running ---

    private int run(CommandContext<ServerCommandSource> ctx, String args) {
        return result(ctx, run(ctx.getSource(), name(ctx), args));
    }

    /** Starts a macro: null when it started, else why not. */
    private String run(ServerCommandSource source, String name, String args) {
        Macro macro = library.get(name);
        if (macro == null) {
            return "No macro named " + name + " — /macro list shows them";
        }
        Map<String, String> vars;
        try {
            vars = Args.bind(macro, Args.tokenize(args), builtIns(source));
        } catch (Args.BindException e) {
            return e.getMessage();
        }
        return start(source, macro, vars);
    }

    private int again(CommandContext<ServerCommandSource> ctx, String args) {
        return result(ctx, again(ctx.getSource(), args));
    }

    private String again(ServerCommandSource source, String args) {
        Map.Entry<String, Map<String, String>> last = lastRun.get(source.getName());
        if (last == null) {
            return "You haven't run a macro yet";
        }
        Macro macro = library.get(last.getKey());
        if (macro == null) {
            return "Macro " + last.getKey() + " is gone (renamed or deleted?)";
        }
        Map<String, String> vars;
        try {
            vars = Args.bind(macro, Args.rebind(macro, last.getValue(), Args.tokenize(args)), builtIns(source));
        } catch (Args.BindException e) {
            return e.getMessage();
        }
        return start(source, macro, vars);
    }

    private String start(ServerCommandSource source, Macro macro, Map<String, String> vars) {
        String who = source.getName();
        MacroRun current = runs.get(who);
        if (current != null && !current.finished()) {
            return "Already running " + current.title() + " — /macro stop first";
        }
        server = source.getServer();
        Map<String, String> args = new LinkedHashMap<>(vars);
        args.keySet().removeAll(Args.BUILT_INS);
        lastRun.put(who, Map.entry(macro.name(), args));
        MacroRun run = new MacroRun(library, macro, vars, builtIns(source), new Host(who), told);
        runs.put(who, run);
        return null;
    }

    private void tick(MinecraftServer s) {
        server = s;
        while (!later.isEmpty()) {
            later.poll().run();
        }
        if (s.getTicks() % 5 == 0) {
            MacroMenus.pollBooks(s, this::saveBook);
        }
        if (s.getTicks() % 10 == 0) {
            MacroMenus.redraw(s);
        }
        if (runs.isEmpty()) {
            return;
        }
        for (Map.Entry<String, MacroRun> e : new ArrayList<>(runs.entrySet())) {
            boolean going;
            try {
                going = e.getValue().tick(s.getTicks());
            } catch (RuntimeException ex) {
                LOGGER.warn("[mc-test] Macro {} crashed", e.getValue().title(), ex);
                e.getValue().stop();
                going = false;
            }
            if (!going) {
                runs.remove(e.getKey(), e.getValue());
            }
        }
    }

    private static Map<String, String> builtIns(ServerCommandSource source) {
        Map<String, String> builtIns = new HashMap<>();
        builtIns.put("me", source.getName());
        return builtIns;
    }

    /** Runs one macro's steps as the player (or console) who started it. */
    private final class Host implements MacroRun.Host {
        private final String who;

        Host(String who) {
            this.who = who;
        }

        @Override
        public String runCommand(String command) {
            CommandOutput delegate;
            ServerCommandSource source;
            ServerPlayerEntity player = server.getPlayerManager().getPlayer(who);
            if (player != null) {
                delegate = player;
                source = player.getCommandSource();
            } else if (who.equals(server.getCommandSource().getName())) {
                delegate = server;
                source = server.getCommandSource();
            } else {
                return who + " left the game";
            }
            String text = command.startsWith("/") ? command.substring(1) : command;
            CommandOutcome mine = new CommandOutcome(who, text);
            List<CommandOutcome> actorCommands = new ArrayList<>();
            names.setActorCommandObserver((actor, actorCommand) -> {
                CommandOutcome outcome = new CommandOutcome(actor, actorCommand);
                actorCommands.add(outcome);
                return outcome;
            });
            running = true;
            try {
                server.getCommandManager().executeWithPrefix(
                        mine.watch(source, delegate, message -> told.record(who, message.getString())), text);
            } finally {
                running = false;
                names.setActorCommandObserver(null);
            }
            if (mine.failed()) {
                return "see the red message above";
            }
            for (CommandOutcome outcome : actorCommands) {
                if (outcome.failed()) {
                    return outcome.why();
                }
            }
            return null;
        }

        @Override
        public void show(MacroRun.Level level, String text) {
            LOGGER.info("[macro {}] {}{}", who, logPrefix(level), text);
            ServerPlayerEntity player = server == null ? null : server.getPlayerManager().getPlayer(who);
            if (player != null) {
                player.sendMessage(line(level, text));
            }
        }
    }

    /** How each kind of line reads in the server log (DONE and STOPPED lines already say so). */
    private static String logPrefix(MacroRun.Level level) {
        return switch (level) {
            case START -> "start ";
            case STEP -> "step ";
            case PASS -> "pass ";
            case FAIL -> "FAIL ";
            case PAUSE -> "paused: ";
            case INFO, DONE, STOPPED -> "";
        };
    }

    private static Text line(MacroRun.Level level, String text) {
        return switch (level) {
            case START -> Text.literal("▶ " + text + " ").formatted(Formatting.GOLD)
                    .append(button("[stop]", "/macro stop", "End this macro"));
            case STEP -> Text.literal("  " + text).formatted(Formatting.DARK_GRAY);
            case INFO -> Text.literal("  " + text).formatted(Formatting.GRAY);
            case PASS -> Text.literal("  ✔ " + text).formatted(Formatting.GREEN);
            case FAIL -> Text.literal("  ✘ " + text).formatted(Formatting.RED);
            case PAUSE -> Text.literal("  ⏸ " + text + " ").formatted(Formatting.YELLOW)
                    .append(button("[continue]", "/macro continue", "Go on with the macro"));
            case DONE -> Text.literal("✔ " + text + " ").formatted(Formatting.GREEN)
                    .append(button("[again]", "/macro again", "Run it again with the same arguments"));
            case STOPPED -> Text.literal("■ " + text + " ").formatted(Formatting.RED)
                    .append(button("[again]", "/macro again", "Run it again with the same arguments"));
        };
    }

    private static MutableText button(String label, String command, String hover) {
        return Text.literal(label).styled(style -> style.withColor(Formatting.AQUA)
                .withClickEvent(new ClickEvent(ClickEvent.Action.RUN_COMMAND, command))
                .withHoverEvent(new HoverEvent(HoverEvent.Action.SHOW_TEXT, Text.literal(hover))));
    }

    private int stop(CommandContext<ServerCommandSource> ctx) {
        MacroRun run = runs.remove(ctx.getSource().getName());
        if (run == null || run.finished()) {
            return error(ctx, "No macro is running");
        }
        run.stop();
        return 1;
    }

    private int resume(CommandContext<ServerCommandSource> ctx) {
        MacroRun run = runs.get(ctx.getSource().getName());
        if (run == null || !run.resume()) {
            return error(ctx, "No macro is paused");
        }
        return 1;
    }

    // --- browsing ---

    private int list(CommandContext<ServerCommandSource> ctx, String filter) {
        Map<String, Macro> all = library.all();
        String needle = filter.toLowerCase(Locale.ROOT);
        int shown = 0;
        String file = null;
        for (Macro m : all.values()) {
            if (!needle.isEmpty() && !m.name().toLowerCase(Locale.ROOT).contains(needle)) {
                continue;
            }
            if (!m.file().equals(file)) {
                file = m.file();
                send(ctx, Text.literal(file).formatted(Formatting.GOLD));
            }
            String about = m.description().isEmpty() ? "" : " — " + m.description().get(0);
            MutableText hover = Text.literal(m.usage()).formatted(Formatting.YELLOW);
            for (String d : m.description()) {
                hover.append(Text.literal("\n" + d).formatted(Formatting.GRAY));
            }
            hover.append(Text.literal("\nClick to fill in the command").formatted(Formatting.DARK_GRAY));
            send(ctx, Text.literal(" ").append(Text.literal(m.name()).styled(style -> style
                    .withColor(Formatting.AQUA)
                    .withClickEvent(new ClickEvent(ClickEvent.Action.SUGGEST_COMMAND, runPrefix() + m.name() + " "))
                    .withHoverEvent(new HoverEvent(HoverEvent.Action.SHOW_TEXT, hover))))
                    .append(Text.literal(about).formatted(Formatting.GRAY)));
            shown++;
        }
        if (shown == 0) {
            send(ctx, Text.literal(all.isEmpty() ? "No macros in " + library.folders() : "No macro matches "
                    + filter).formatted(Formatting.GRAY));
        }
        long errors = library.problems().stream().filter(Problem::isError).count();
        if (errors > 0) {
            send(ctx, Text.literal(errors + " problem(s) in the macro files — /macro reload lists them")
                    .formatted(Formatting.RED));
        }
        return shown;
    }

    private int show(CommandContext<ServerCommandSource> ctx) {
        Macro m = library.get(StringArgumentType.getString(ctx, "name"));
        if (m == null) {
            return error(ctx, "No macro named " + StringArgumentType.getString(ctx, "name"));
        }
        send(ctx, Text.literal(runPrefix() + m.usage()).styled(style -> style.withColor(Formatting.YELLOW)
                .withClickEvent(new ClickEvent(ClickEvent.Action.SUGGEST_COMMAND, runPrefix() + m.name() + " "))));
        for (String d : m.description()) {
            send(ctx, Text.literal("  " + d).formatted(Formatting.GRAY));
        }
        List<String> steps = steps(m.name());
        for (int i = 0; i < steps.size(); i++) {
            send(ctx, Text.literal("  " + (i + 1) + "  ").formatted(Formatting.DARK_GRAY)
                    .append(Text.literal(steps.get(i)).formatted(Formatting.WHITE)));
        }
        send(ctx, Text.literal("  " + m.file() + ":" + m.line() + ", " + steps.size() + " steps ")
                .formatted(Formatting.DARK_GRAY)
                .append(button("[open]", "/macro menu " + m.name(), "See and change it in the macro menu")));
        return 1;
    }

    private int reload(CommandContext<ServerCommandSource> ctx) {
        library.reload();
        for (Problem p : library.problems()) {
            send(ctx, Text.literal(p.toString()).formatted(p.isError() ? Formatting.RED : Formatting.YELLOW));
        }
        send(ctx, Text.literal(library.all().size() + " macros from " + library.folders())
                .formatted(Formatting.GREEN));
        return library.all().size();
    }

    // --- recording ---

    /** Remembers what operators type (not actors, not macro steps), for recording. */
    private void typed(ParseResults<ServerCommandSource> parse) {
        if (running) {
            return;
        }
        ServerCommandSource source = parse.getContext().getSource();
        ServerPlayerEntity player = source.getPlayer();
        if (player == null || actors.isActor(player.getGameProfile().getName())
                || CommandManager.getException(parse) != null) {
            return;
        }
        String command = parse.getReader().getString();
        String first = command.startsWith("/") ? command.substring(1) : command;
        if (first.startsWith("macro ") || first.equals("macro") || first.startsWith("m ")) {
            return;
        }
        commandLog.typed(player.getGameProfile().getName(), command);
    }

    private int recordStart(CommandContext<ServerCommandSource> ctx) {
        commandLog.startRecording(ctx.getSource().getName());
        send(ctx, Text.literal("Recording. Type the commands, then /macro record save <name>.")
                .formatted(Formatting.GOLD));
        return 1;
    }

    private int recordCancel(CommandContext<ServerCommandSource> ctx) {
        if (commandLog.stopRecording(ctx.getSource().getName()) == null) {
            return error(ctx, "You aren't recording");
        }
        send(ctx, Text.literal("Recording thrown away.").formatted(Formatting.GRAY));
        return 1;
    }

    private int recordSave(CommandContext<ServerCommandSource> ctx) {
        String who = ctx.getSource().getName();
        if (!commandLog.isRecording(who)) {
            return error(ctx, "You aren't recording — /macro record start");
        }
        String name = StringArgumentType.getString(ctx, "name");
        if (library.get(name) != null) {
            return error(ctx, "There's already a macro named " + name);
        }
        List<String> commands = commandLog.stopRecording(who);
        return save(ctx, name, commands, "Recorded by " + who + " on " + LocalDate.now() + ".");
    }

    private int saveLast(CommandContext<ServerCommandSource> ctx) {
        String who = ctx.getSource().getName();
        String name = StringArgumentType.getString(ctx, "name");
        if (library.get(name) != null) {
            return error(ctx, "There's already a macro named " + name);
        }
        List<String> commands = commandLog.last(who, IntegerArgumentType.getInteger(ctx, "count"));
        return save(ctx, name, commands, "Saved from " + who + "'s last commands on " + LocalDate.now() + ".");
    }

    private int save(CommandContext<ServerCommandSource> ctx, String name, List<String> commands, String comment) {
        if (commands.isEmpty()) {
            return error(ctx, "No commands to save");
        }
        Path folder = library.recordFolder();
        if (folder == null) {
            return error(ctx, "No macro folder is set (MCTEST_MACROS)");
        }
        List<String> actorNames = new ArrayList<>();
        for (FakePlayerManager.ActorRecord r : actors.records()) {
            actorNames.add(r.name);
        }
        String text = CommandLog.toMacro(name, commands, actorNames, ctx.getSource().getName(), comment);
        Path file = folder.resolve("recorded" + MacroLibrary.EXTENSION);
        try {
            CommandLog.append(file, text);
        } catch (IOException e) {
            return error(ctx, "Couldn't write " + file + ": " + e.getMessage());
        }
        library.reload();
        Macro saved = library.get(name);
        send(ctx, Text.literal("Saved " + commands.size() + " commands as ").formatted(Formatting.GREEN)
                .append(Text.literal(saved != null ? saved.usage() : name).styled(style -> style
                        .withColor(Formatting.AQUA)
                        .withClickEvent(new ClickEvent(ClickEvent.Action.SUGGEST_COMMAND, runPrefix() + name + " "))))
                .append(Text.literal(" in " + file).formatted(Formatting.GRAY)));
        return 1;
    }

    // --- the menu, and editing (docs/MACROS.md §8) ---

    /** How long after the menu asks for text through chat the menu still opens again when it comes. */
    private static final long REOPEN_MS = 10 * 60 * 1000;

    private int openMenu(CommandContext<ServerCommandSource> ctx, String name) {
        ServerPlayerEntity player = ctx.getSource().getPlayer();
        if (player == null) {
            return error(ctx, "The macro menu is for players; /macro help lists the commands");
        }
        if (player.isSpectator()) {
            return error(ctx, "A spectator can't click in a menu; leave spectator mode first (/actor back if you're viewing an actor)");
        }
        if (name != null && library.get(name) == null) {
            return error(ctx, "No macro named " + name);
        }
        MenuHost host = new MenuHost(player);
        MacroMenus.open(player, name == null ? MacroMenu.macros(host) : MacroMenu.macro(host, name));
        return 1;
    }

    @FunctionalInterface
    private interface EditAction {
        MacroEditor.Done apply(String who) throws EditException;
    }

    /** Runs one edit command, says what it did, and opens the menu again if the menu asked for it. */
    private int edit(CommandContext<ServerCommandSource> ctx, EditAction action) {
        ServerCommandSource source = ctx.getSource();
        String who = source.getName();
        MacroEditor.Done done;
        try {
            done = action.apply(who);
        } catch (EditException e) {
            return error(ctx, e.getMessage());
        }
        LOGGER.info("[macro {}] edit: {}", who, done.message());
        send(ctx, edited(done, who));
        for (Problem w : done.warnings()) {
            send(ctx, Text.literal("  " + w).formatted(Formatting.YELLOW));
        }
        Long asked = reopen.remove(who);
        ServerPlayerEntity player = source.getPlayer();
        if (asked != null && player != null && System.currentTimeMillis() - asked < REOPEN_MS) {
            MenuHost host = new MenuHost(player);
            MacroMenus.open(player, library.get(done.macro()) != null ? MacroMenu.macro(host, done.macro()) : MacroMenu.macros(host));
        }
        return 1;
    }

    private MutableText edited(MacroEditor.Done done, String who) {
        String message = done.message();
        MutableText line = Text.literal("[macro] " + Character.toUpperCase(message.charAt(0))
                + message.substring(1) + " ").formatted(Formatting.GREEN);
        if (library.get(done.macro()) != null) {
            line.append(button("[open]", "/macro menu " + done.macro(), "See it in the macro menu")).append(" ");
        }
        if (editor.undoable(who) != null) {
            line.append(button("[undo]", "/macro undo", "Undo: " + editor.undoable(who)));
        }
        return line;
    }

    private int book(CommandContext<ServerCommandSource> ctx) {
        ServerPlayerEntity player = ctx.getSource().getPlayer();
        if (player == null) {
            return error(ctx, "A book is for players");
        }
        return result(ctx, new MenuHost(player).editInBook(name(ctx)));
    }

    private int bookCancel(CommandContext<ServerCommandSource> ctx) {
        ServerPlayerEntity player = ctx.getSource().getPlayer();
        if (player == null || !MacroMenus.hasBook(player)) {
            return error(ctx, "You aren't editing a macro in a book");
        }
        MacroMenus.dropBook(player);
        send(ctx, Text.literal("[macro] Took the book back; nothing was saved").formatted(Formatting.GRAY));
        return 1;
    }

    /** A book's pages, saved as the macro once the player pressed Done: null when saved, else why not. */
    private String saveBook(ServerPlayerEntity player, String macro, List<String> pages) {
        String who = player.getName().getString();
        try {
            MacroEditor.Done done = editor.replace(who, macro, MacroSource.fromBook(pages));
            LOGGER.info("[macro {}] edit: {} from a book", who, done.message());
            player.sendMessage(edited(done, who));
            MacroMenus.open(player, MacroMenu.macro(new MenuHost(player), done.macro()));
            return null;
        } catch (EditException e) {
            player.sendMessage(Text.literal("[macro] Not saved: " + e.getMessage()
                    + ". Fix the book and press Done again, or ").formatted(Formatting.RED)
                    .append(button("[cancel]", "/macro book cancel", "Take the book back without saving")));
            return e.getMessage();
        }
    }

    private int help(CommandContext<ServerCommandSource> ctx) {
        String[][] lines = {
            {"/macro", "the menu: every macro; drag them around, open one to see and change it"},
            {runPrefix() + "<name> [values]", "run a macro"},
            {"/macro again [values]", "run your last macro again, changing some values"},
            {"/macro list [filter] · show <name>", "list them · print one with its steps"},
            {"/macro stop · continue", "end your macro · go on after a pause"},
            {"/macro record start · save <name> · cancel", "record the commands you type"},
            {"/macro new <name> [params]", "a new, empty macro"},
            {"/macro edit <name> add|step <n>|insert <n> <step>", "add, change or insert a step"},
            {"/macro edit <name> remove <n> · move <n> <to>", "delete or move a step"},
            {"/macro edit <name> header|describe|book", "rename, describe, or edit it all in a book"},
            {"/macro copy <name> <new> · delete <name> · undo", "copy, delete, undo your last change"},
        };
        for (String[] l : lines) {
            send(ctx, Text.literal(l[0]).formatted(Formatting.AQUA)
                    .append(Text.literal(" — " + l[1]).formatted(Formatting.GRAY)));
        }
        return 1;
    }

    /** The macro's steps as written in its file. */
    private List<String> steps(String name) {
        try {
            Path file = library.path(name);
            return file == null ? List.of() : MacroSource.steps(Files.readString(file, StandardCharsets.UTF_8), name);
        } catch (IOException | EditException e) {
            return List.of();
        }
    }

    /** What the menu's screens ask of the game, for one player. */
    private final class MenuHost implements MacroMenu.Host {
        private final UUID id;
        private final String who;

        MenuHost(ServerPlayerEntity player) {
            this.id = player.getUuid();
            this.who = player.getName().getString();
        }

        private ServerPlayerEntity player() {
            return server == null ? null : server.getPlayerManager().getPlayer(id);
        }

        @Override
        public String who() {
            return who;
        }

        @Override
        public MacroLibrary library() {
            return library;
        }

        @Override
        public MacroEditor editor() {
            return editor;
        }

        @Override
        public MacroLayout layout() {
            return layout;
        }

        @Override
        public String running() {
            MacroRun r = runs.get(who);
            return r == null || r.finished() ? null : r.title();
        }

        @Override
        public boolean paused() {
            MacroRun r = runs.get(who);
            return r != null && r.paused();
        }

        @Override
        public void stop() {
            MacroRun r = runs.remove(who);
            if (r != null) {
                r.stop();
            }
        }

        @Override
        public void resume() {
            MacroRun r = runs.get(who);
            if (r != null) {
                r.resume();
            }
        }

        @Override
        public String last() {
            Map.Entry<String, Map<String, String>> last = lastRun.get(who);
            if (last == null) {
                return null;
            }
            StringBuilder out = new StringBuilder(last.getKey());
            last.getValue().forEach((k, v) -> out.append(' ').append(k).append('=').append(v));
            return out.toString();
        }

        @Override
        public void again() {
            ServerPlayerEntity p = player();
            if (p != null) {
                String why = MacroCommands.this.again(p.getCommandSource(), "");
                if (why != null) {
                    tell(why, true);
                }
            }
        }

        @Override
        public boolean recording() {
            return commandLog.isRecording(who);
        }

        @Override
        public int recorded() {
            return commandLog.recorded(who);
        }

        @Override
        public void startRecording() {
            commandLog.startRecording(who);
            tell("Recording. Type the commands, then save them from /macro or with /macro record save <name>", false);
        }

        @Override
        public void cancelRecording() {
            commandLog.stopRecording(who);
            tell("Recording thrown away", false);
        }

        @Override
        public String run(String macro) {
            ServerPlayerEntity p = player();
            return p == null ? "You left" : MacroCommands.this.run(p.getCommandSource(), macro, "");
        }

        @Override
        public void suggest(String prompt, String command, boolean reopenAfter) {
            if (reopenAfter) {
                reopen.put(who, System.currentTimeMillis());
            } else {
                reopen.remove(who);
            }
            later.add(() -> {
                ServerPlayerEntity p = player();
                if (p == null) {
                    return;
                }
                p.closeHandledScreen();
                p.sendMessage(Text.literal("✎ " + prompt + ": ").formatted(Formatting.YELLOW)
                        .append(Text.literal("[click to fill in]").styled(style -> style
                                .withColor(Formatting.AQUA)
                                .withClickEvent(new ClickEvent(ClickEvent.Action.SUGGEST_COMMAND, command))
                                .withHoverEvent(new HoverEvent(HoverEvent.Action.SHOW_TEXT, Text.literal(command))))));
            });
        }

        @Override
        public String editInBook(String macro) {
            ServerPlayerEntity p = player();
            Macro m = library.get(macro);
            Path file = library.path(macro);
            if (p == null || m == null || file == null) {
                return "No macro named " + macro;
            }
            String block;
            try {
                block = MacroSource.block(Files.readString(file, StandardCharsets.UTF_8), m.name());
            } catch (IOException | EditException e) {
                return "Can't read " + m.file() + ": " + e.getMessage();
            }
            String why = MacroMenus.giveBook(p, m.name(), block, m.file());
            if (why == null) {
                close();
                p.sendMessage(Text.literal("[macro] Right-click the book to edit " + m.name()
                        + "; Done saves it. ").formatted(Formatting.GREEN)
                        .append(button("[cancel]", "/macro book cancel", "Take the book back without saving")));
            }
            return why;
        }

        @Override
        public void open(MacroMenu.Screen screen) {
            later.add(() -> {
                ServerPlayerEntity p = player();
                if (p != null) {
                    MacroMenus.open(p, screen);
                }
            });
        }

        @Override
        public void close() {
            later.add(() -> {
                ServerPlayerEntity p = player();
                if (p != null) {
                    p.closeHandledScreen();
                }
            });
        }

        @Override
        public void tell(String text, boolean error) {
            ServerPlayerEntity p = player();
            if (p != null) {
                p.sendMessage(Text.literal("[macro] " + text)
                        .formatted(error ? Formatting.RED : Formatting.GREEN));
            }
        }

        @Override
        public String runPrefix() {
            return MacroCommands.this.runPrefix();
        }
    }

    // --- plumbing ---

    private static int result(CommandContext<ServerCommandSource> ctx, String why) {
        return why == null ? 1 : error(ctx, why);
    }

    /** How to call a macro on this server: {@code /m}, unless another mod owns it. */
    private String runPrefix() {
        return shortForm ? "/m " : "/macro run ";
    }

    private static void send(CommandContext<ServerCommandSource> ctx, Text line) {
        ctx.getSource().sendMessage(line);
    }

    private static int error(CommandContext<ServerCommandSource> ctx, String message) {
        ctx.getSource().sendError(Text.literal("[macro] " + message));
        return 0;
    }
}
