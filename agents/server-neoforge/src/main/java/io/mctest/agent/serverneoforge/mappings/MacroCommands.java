package io.mctest.agent.serverneoforge.mappings;

import com.mojang.brigadier.arguments.IntegerArgumentType;
import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.builder.LiteralArgumentBuilder;
import com.mojang.brigadier.builder.RequiredArgumentBuilder;
import com.mojang.brigadier.context.CommandContext;
import com.mojang.brigadier.suggestion.Suggestions;
import com.mojang.brigadier.suggestion.SuggestionsBuilder;
import com.google.gson.JsonObject;
import com.mojang.logging.LogUtils;
import io.mctest.agent.core.EventBus;
import io.mctest.agent.core.McTestException;
import io.mctest.agent.core.McTestSession;
import io.mctest.agent.core.bench.Args;
import io.mctest.agent.core.bench.CommandLog;
import io.mctest.agent.core.bench.Macro;
import io.mctest.agent.core.bench.MacroEditor;
import io.mctest.agent.core.bench.MacroEvents;
import io.mctest.agent.core.bench.MacroLayout;
import io.mctest.agent.core.bench.MacroLibrary;
import io.mctest.agent.core.bench.MacroMenu;
import io.mctest.agent.core.bench.MacroRun;
import io.mctest.agent.core.bench.MacroSource;
import io.mctest.agent.core.bench.MacroSource.EditException;
import io.mctest.agent.core.bench.Problem;
import io.mctest.agent.core.bench.ToldLog;
import io.mctest.agent.serverneoforge.Params;
import io.mctest.agent.serverneoforge.players.FakePlayerManager;
import java.io.IOException;
import java.nio.file.Path;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.time.LocalDate;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.function.Supplier;
import net.minecraft.ChatFormatting;
import net.minecraft.commands.CommandSource;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.commands.SharedSuggestionProvider;
import net.minecraft.network.chat.ClickEvent;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.HoverEvent;
import net.minecraft.network.chat.MutableComponent;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.neoforge.event.CommandEvent;
import net.neoforged.neoforge.event.RegisterCommandsEvent;
import net.neoforged.neoforge.event.entity.player.PlayerEvent;
import net.neoforged.neoforge.event.tick.ServerTickEvent;
import org.slf4j.Logger;

/**
 * The in-game {@code /macro} command (docs/MACROS.md): saved, parameterized command groups for manual play
 * testing, read from the project's {@code .macro} files. A bench convenience next to {@code /actor}. The runner can also start
 * one over MCTP ({@code bench.runMacro}, a spike) and then judges each {@code expect} itself from the evidence
 * the run reports: the agent's own ✔/✘ is only ever a hint (Prime Directive 2 keeps verdicts in the runner).
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
 * <p>Steps run as whoever started the macro, one command per tick, through the real dispatcher: an
 * {@code /actor} line drives an actor exactly as typing it would.
 */
public final class MacroCommands {

    private static final Logger LOGGER = LogUtils.getLogger();

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
    /** The MCTP server's event bus once it is up (null before), for {@code bench.runMacro}'s step events. */
    private final Supplier<EventBus> events;

    private MacroCommands(FakePlayerManager actors, Names names, MacroLibrary library, Supplier<EventBus> events) {
        this.actors = actors;
        this.events = events;
        this.names = names;
        this.library = library;
        Path folder = library.recordFolder();
        this.layout = new MacroLayout(folder == null ? null : folder.resolve(MacroLayout.FILE));
        this.editor = new MacroEditor(library, layout);
    }

    /**
     * Registers {@code /macro} and {@code /m}; call once at mod init. Macros come from {@code MCTEST_MACROS}.
     *
     * @param events the MCTP server's event bus once it is up, for {@link #runMacro}.
     * @return the instance, whose {@link #runMacro} the agent registers as {@code bench.runMacro}.
     */
    public static MacroCommands install(FakePlayerManager actors, Names names, Supplier<EventBus> events) {
        MacroLibrary library = new MacroLibrary(MacroLibrary.folders(System.getenv("MCTEST_MACROS"), Path.of("macros")));
        MacroCommands macros = new MacroCommands(actors, names, library, events);
        names.setToldListener(macros.told::record);
        NeoForge.EVENT_BUS.addListener(macros::register);
        NeoForge.EVENT_BUS.addListener((ServerTickEvent.Post e) -> macros.tick(e.getServer()));
        NeoForge.EVENT_BUS.addListener(macros::typed);
        NeoForge.EVENT_BUS.addListener((PlayerEvent.PlayerLoggedOutEvent e) -> {
            if (e.getEntity() instanceof ServerPlayer p) {
                MacroMenus.dropBook(p);
            }
        });
        LOGGER.info("[mc-test] Macros are read from {}", library.folders());
        return macros;
    }

    // --- MCTP: bench.runMacro, a run the runner judges (spike) ---

    /**
     * {@code bench.runMacro} params {@code { sessionId, name, args?, as? }}: starts macro {@code name} with
     * {@code args} (as typed after {@code /m <name>}) as the console, or as the agent-owned actor {@code as}, and
     * answers at once with its {@code runId}. Every step then arrives as an {@code event.macroStep} (once with
     * {@code phase:"start"}, once with {@code phase:"end"}) and the run's end as {@code event.macroEnd}. A
     * {@code waitfor}/{@code expect} ends with its {@code check}: the evidence window the runner judges.
     */
    public JsonObject runMacro(McTestSession session, JsonObject params) throws McTestException {
        String name = Params.requireString(params, "name");
        String args = Params.optString(params, "args", "");
        String as = Params.optString(params, "as", null);
        if (as != null && !actors.isActor(as)) {
            throw McTestException.invalidParams("bench.runMacro: " + as + " is not an agent-owned actor");
        }
        String runId = "mr_" + UUID.randomUUID().toString().substring(0, 8);
        String error = names.call(() -> {
            if (server == null) {
                return "the server isn't ticking yet";
            }
            CommandSourceStack source;
            if (as == null) {
                source = server.createCommandSourceStack();
            } else {
                ServerPlayer player = server.getPlayerList().getPlayerByName(as);
                if (player == null) {
                    return as + " isn't online";
                }
                source = player.createCommandSourceStack();
            }
            Macro macro = library.get(name);
            if (macro == null) {
                return "no macro named " + name;
            }
            Map<String, String> vars;
            try {
                vars = Args.bind(macro, Args.tokenize(args), builtIns(source));
            } catch (Args.BindException e) {
                return e.getMessage();
            }
            String who = source.getTextName();
            MacroRun current = runs.get(who);
            if (current != null && !current.finished()) {
                return "already running " + current.title() + " as " + who;
            }
            MacroRun run = new MacroRun(library, macro, vars, builtIns(source), new Host(who), told)
                    .observe(new MacroEvents(runId, events));
            runs.put(who, run);
            return null;
        }, Params.timeoutMs(params, 5000));
        if (error != null) {
            throw McTestException.invalidParams("bench.runMacro: " + error);
        }
        JsonObject result = new JsonObject();
        result.addProperty("ok", true);
        result.addProperty("runId", runId);
        return result;
    }

    // --- registration ---

    private void register(RegisterCommandsEvent event) {
        LiteralArgumentBuilder<CommandSourceStack> root = Commands.literal("macro")
                .requires(src -> src.hasPermission(2))
                .executes(ctx -> openMenu(ctx, null));
        root.then(Commands.literal("menu").executes(ctx -> openMenu(ctx, null))
                .then(Commands.argument("name", StringArgumentType.word()).suggests(this::suggestNames)
                        .executes(ctx -> openMenu(ctx, name(ctx)))));
        root.then(Commands.literal("help").executes(this::help));
        root.then(Commands.literal("run").then(runArguments()));
        root.then(Commands.literal("again")
                .executes(ctx -> again(ctx, ""))
                .then(Commands.argument("args", StringArgumentType.greedyString())
                        .executes(ctx -> again(ctx, StringArgumentType.getString(ctx, "args")))));
        root.then(Commands.literal("list")
                .executes(ctx -> list(ctx, ""))
                .then(Commands.argument("filter", StringArgumentType.word())
                        .executes(ctx -> list(ctx, StringArgumentType.getString(ctx, "filter")))));
        root.then(Commands.literal("show").then(Commands.argument("name", StringArgumentType.word())
                .suggests(this::suggestNames)
                .executes(this::show)));
        root.then(Commands.literal("reload").executes(this::reload));
        root.then(Commands.literal("stop").executes(this::stop));
        root.then(Commands.literal("continue").executes(this::resume));
        root.then(Commands.literal("record")
                .then(Commands.literal("start").executes(this::recordStart))
                .then(Commands.literal("cancel").executes(this::recordCancel))
                .then(Commands.literal("save").then(Commands.argument("name", StringArgumentType.word())
                        .executes(this::recordSave))));
        root.then(Commands.literal("last").then(Commands.argument("count", IntegerArgumentType.integer(1, CommandLog.KEEP))
                .then(Commands.literal("as").then(Commands.argument("name", StringArgumentType.word())
                        .executes(this::saveLast)))));
        registerEditing(root);
        event.getDispatcher().register(root);

        // The short form, unless a mod already owns /m.
        if (event.getDispatcher().getRoot().getChild("m") == null) {
            event.getDispatcher().register(Commands.literal("m").requires(src -> src.hasPermission(2))
                    .executes(ctx -> openMenu(ctx, null))
                    .then(runArguments()));
            shortForm = true;
        } else {
            shortForm = false;
            LOGGER.info("[mc-test] /m is taken by another mod; use /macro run <name>");
        }
    }

    /** {@code /macro edit …}, {@code new}, {@code copy}, {@code delete}, {@code undo}: changing the files (§8). */
    private void registerEditing(LiteralArgumentBuilder<CommandSourceStack> root) {
        root.then(Commands.literal("new").then(Commands.argument("header", StringArgumentType.greedyString())
                .executes(ctx -> edit(ctx, who -> editor.create(who, text(ctx, "header"), null)))));
        root.then(Commands.literal("copy").then(nameArgument()
                .then(Commands.argument("copy", StringArgumentType.word())
                        .executes(ctx -> edit(ctx, who -> editor.copy(who, name(ctx), text(ctx, "copy")))))));
        root.then(Commands.literal("delete").then(nameArgument()
                .executes(ctx -> edit(ctx, who -> editor.delete(who, name(ctx))))));
        root.then(Commands.literal("undo").executes(ctx -> edit(ctx, editor::undo)));
        root.then(Commands.literal("book").then(Commands.literal("cancel").executes(this::bookCancel)));
        root.then(Commands.literal("edit").then(nameArgument()
                .then(Commands.literal("step").then(number("n").then(stepArgument()
                        .executes(ctx -> edit(ctx, who -> editor.setStep(who, name(ctx), n(ctx, "n"), text(ctx, "step")))))))
                .then(Commands.literal("add").then(stepArgument()
                        .executes(ctx -> edit(ctx, who -> editor.addStep(who, name(ctx), text(ctx, "step"))))))
                .then(Commands.literal("insert").then(number("n").then(stepArgument()
                        .executes(ctx -> edit(ctx, who -> editor.insertStep(who, name(ctx), n(ctx, "n"), text(ctx, "step")))))))
                .then(Commands.literal("remove").then(number("n")
                        .executes(ctx -> edit(ctx, who -> editor.removeStep(who, name(ctx), n(ctx, "n"))))))
                .then(Commands.literal("move").then(number("n").then(number("to")
                        .executes(ctx -> edit(ctx, who -> editor.moveStep(who, name(ctx), n(ctx, "n"), n(ctx, "to")))))))
                .then(Commands.literal("header").then(Commands.argument("header", StringArgumentType.greedyString())
                        .executes(ctx -> edit(ctx, who -> editor.setHeader(who, name(ctx), text(ctx, "header"))))))
                .then(Commands.literal("describe")
                        .executes(ctx -> edit(ctx, who -> editor.describe(who, name(ctx), "")))
                        .then(Commands.argument("text", StringArgumentType.greedyString())
                                .executes(ctx -> edit(ctx, who -> editor.describe(who, name(ctx), text(ctx, "text"))))))
                .then(Commands.literal("book").executes(this::book))));
    }

    private RequiredArgumentBuilder<CommandSourceStack, String> nameArgument() {
        return Commands.argument("name", StringArgumentType.word()).suggests(this::suggestNames);
    }

    private static RequiredArgumentBuilder<CommandSourceStack, String> stepArgument() {
        return Commands.argument("step", StringArgumentType.greedyString());
    }

    private static RequiredArgumentBuilder<CommandSourceStack, Integer> number(String name) {
        return Commands.argument(name, IntegerArgumentType.integer(1));
    }

    private static String name(CommandContext<CommandSourceStack> ctx) {
        return StringArgumentType.getString(ctx, "name");
    }

    private static String text(CommandContext<CommandSourceStack> ctx, String argument) {
        return StringArgumentType.getString(ctx, argument);
    }

    private static int n(CommandContext<CommandSourceStack> ctx, String argument) {
        return IntegerArgumentType.getInteger(ctx, argument);
    }

    private CompletableFuture<Suggestions> suggestNames(CommandContext<CommandSourceStack> ctx, SuggestionsBuilder builder) {
        return SharedSuggestionProvider.suggest(library.all().keySet(), builder);
    }

    private RequiredArgumentBuilder<CommandSourceStack, String> runArguments() {
        return Commands.argument("name", StringArgumentType.word())
                .suggests(this::suggestNames)
                .executes(ctx -> run(ctx, ""))
                .then(Commands.argument("args", StringArgumentType.greedyString())
                        .suggests(this::suggestArgs)
                        .executes(ctx -> run(ctx, StringArgumentType.getString(ctx, "args"))));
    }

    /** Unfilled {@code param=}s, and player names (bare, or after the {@code =} being typed). */
    private CompletableFuture<Suggestions> suggestArgs(CommandContext<CommandSourceStack> ctx, SuggestionsBuilder builder) {
        Macro macro = library.all().get(StringArgumentType.getString(ctx, "name"));
        if (macro == null) {
            return builder.buildFuture();
        }
        String typed = builder.getRemaining();
        int lastSpace = typed.lastIndexOf(' ');
        String current = typed.substring(lastSpace + 1);
        SuggestionsBuilder at = builder.createOffset(builder.getStart() + lastSpace + 1);
        List<String> players = new ArrayList<>(ctx.getSource().getOnlinePlayerNames());
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
        return SharedSuggestionProvider.suggest(options, at);
    }

    // --- running ---

    private int run(CommandContext<CommandSourceStack> ctx, String args) {
        return result(ctx, run(ctx.getSource(), name(ctx), args));
    }

    /** Starts a macro: null when it started, else why not. */
    private String run(CommandSourceStack source, String name, String args) {
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

    private int again(CommandContext<CommandSourceStack> ctx, String args) {
        return result(ctx, again(ctx.getSource(), args));
    }

    private String again(CommandSourceStack source, String args) {
        Map.Entry<String, Map<String, String>> last = lastRun.get(source.getTextName());
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

    private String start(CommandSourceStack source, Macro macro, Map<String, String> vars) {
        String who = source.getTextName();
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
        if (s.getTickCount() % 5 == 0) {
            MacroMenus.pollBooks(s, this::saveBook);
        }
        if (s.getTickCount() % 10 == 0) {
            MacroMenus.redraw(s);
        }
        if (runs.isEmpty()) {
            return;
        }
        Iterator<Map.Entry<String, MacroRun>> it = new ArrayList<>(runs.entrySet()).iterator();
        while (it.hasNext()) {
            Map.Entry<String, MacroRun> e = it.next();
            boolean going;
            try {
                going = e.getValue().tick(s.getTickCount());
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

    private static Map<String, String> builtIns(CommandSourceStack source) {
        Map<String, String> builtIns = new HashMap<>();
        builtIns.put("me", source.getTextName());
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
            CommandSource delegate;
            CommandSourceStack source;
            ServerPlayer player = server.getPlayerList().getPlayerByName(who);
            if (player != null) {
                delegate = player;
                source = player.createCommandSourceStack();
            } else if (who.equals(server.createCommandSourceStack().getTextName())) {
                delegate = server;
                source = server.createCommandSourceStack();
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
                server.getCommands().performPrefixedCommand(
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
            ServerPlayer player = server == null ? null : server.getPlayerList().getPlayerByName(who);
            if (player != null) {
                player.sendSystemMessage(line(level, text));
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

    private static Component line(MacroRun.Level level, String text) {
        return switch (level) {
            case START -> Component.literal("▶ " + text + " ").withStyle(ChatFormatting.GOLD)
                    .append(button("[stop]", "/macro stop", "End this macro"));
            case STEP -> Component.literal("  " + text).withStyle(ChatFormatting.DARK_GRAY);
            case INFO -> Component.literal("  " + text).withStyle(ChatFormatting.GRAY);
            case PASS -> Component.literal("  ✔ " + text).withStyle(ChatFormatting.GREEN);
            case FAIL -> Component.literal("  ✘ " + text).withStyle(ChatFormatting.RED);
            case PAUSE -> Component.literal("  ⏸ " + text + " ").withStyle(ChatFormatting.YELLOW)
                    .append(button("[continue]", "/macro continue", "Go on with the macro"));
            case DONE -> Component.literal("✔ " + text + " ").withStyle(ChatFormatting.GREEN)
                    .append(button("[again]", "/macro again", "Run it again with the same arguments"));
            case STOPPED -> Component.literal("■ " + text + " ").withStyle(ChatFormatting.RED)
                    .append(button("[again]", "/macro again", "Run it again with the same arguments"));
        };
    }

    private static MutableComponent button(String label, String command, String hover) {
        return Component.literal(label).withStyle(style -> style.withColor(ChatFormatting.AQUA)
                .withClickEvent(new ClickEvent(ClickEvent.Action.RUN_COMMAND, command))
                .withHoverEvent(new HoverEvent(HoverEvent.Action.SHOW_TEXT, Component.literal(hover))));
    }

    private int stop(CommandContext<CommandSourceStack> ctx) {
        MacroRun run = runs.remove(ctx.getSource().getTextName());
        if (run == null || run.finished()) {
            return error(ctx, "No macro is running");
        }
        run.stop();
        return 1;
    }

    private int resume(CommandContext<CommandSourceStack> ctx) {
        MacroRun run = runs.get(ctx.getSource().getTextName());
        if (run == null || !run.resume()) {
            return error(ctx, "No macro is paused");
        }
        return 1;
    }

    // --- browsing ---

    private int list(CommandContext<CommandSourceStack> ctx, String filter) {
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
                send(ctx, Component.literal(file).withStyle(ChatFormatting.GOLD));
            }
            String about = m.description().isEmpty() ? "" : " — " + m.description().get(0);
            MutableComponent hover = Component.literal(m.usage()).withStyle(ChatFormatting.YELLOW);
            for (String d : m.description()) {
                hover.append(Component.literal("\n" + d).withStyle(ChatFormatting.GRAY));
            }
            hover.append(Component.literal("\nClick to fill in the command").withStyle(ChatFormatting.DARK_GRAY));
            send(ctx, Component.literal(" ").append(Component.literal(m.name()).withStyle(style -> style
                    .withColor(ChatFormatting.AQUA)
                    .withClickEvent(new ClickEvent(ClickEvent.Action.SUGGEST_COMMAND, runPrefix() + m.name() + " "))
                    .withHoverEvent(new HoverEvent(HoverEvent.Action.SHOW_TEXT, hover))))
                    .append(Component.literal(about).withStyle(ChatFormatting.GRAY)));
            shown++;
        }
        if (shown == 0) {
            send(ctx, Component.literal(all.isEmpty() ? "No macros in " + library.folders() : "No macro matches "
                    + filter).withStyle(ChatFormatting.GRAY));
        }
        long errors = library.problems().stream().filter(Problem::isError).count();
        if (errors > 0) {
            send(ctx, Component.literal(errors + " problem(s) in the macro files — /macro reload lists them")
                    .withStyle(ChatFormatting.RED));
        }
        return shown;
    }

    private int show(CommandContext<CommandSourceStack> ctx) {
        Macro m = library.get(StringArgumentType.getString(ctx, "name"));
        if (m == null) {
            return error(ctx, "No macro named " + StringArgumentType.getString(ctx, "name"));
        }
        send(ctx, Component.literal(runPrefix() + m.usage()).withStyle(style -> style.withColor(ChatFormatting.YELLOW)
                .withClickEvent(new ClickEvent(ClickEvent.Action.SUGGEST_COMMAND, runPrefix() + m.name() + " "))));
        for (String d : m.description()) {
            send(ctx, Component.literal("  " + d).withStyle(ChatFormatting.GRAY));
        }
        List<String> steps = steps(m.name());
        for (int i = 0; i < steps.size(); i++) {
            send(ctx, Component.literal("  " + (i + 1) + "  ").withStyle(ChatFormatting.DARK_GRAY)
                    .append(Component.literal(steps.get(i)).withStyle(ChatFormatting.WHITE)));
        }
        send(ctx, Component.literal("  " + m.file() + ":" + m.line() + ", " + steps.size() + " steps ")
                .withStyle(ChatFormatting.DARK_GRAY)
                .append(button("[open]", "/macro menu " + m.name(), "See and change it in the macro menu")));
        return 1;
    }

    private int reload(CommandContext<CommandSourceStack> ctx) {
        library.reload();
        for (Problem p : library.problems()) {
            send(ctx, Component.literal(p.toString()).withStyle(p.isError() ? ChatFormatting.RED : ChatFormatting.YELLOW));
        }
        send(ctx, Component.literal(library.all().size() + " macros from " + library.folders())
                .withStyle(ChatFormatting.GREEN));
        return library.all().size();
    }

    // --- recording ---

    /** Remembers what operators type (not actors, not macro steps), for recording. */
    private void typed(CommandEvent event) {
        if (running) {
            return;
        }
        CommandSourceStack source = event.getParseResults().getContext().getSource();
        ServerPlayer player = source.getPlayer();
        if (player == null || actors.isActor(player.getGameProfile().getName())
                || Commands.getParseException(event.getParseResults()) != null) {
            return;
        }
        String command = event.getParseResults().getReader().getString();
        String first = command.startsWith("/") ? command.substring(1) : command;
        if (first.startsWith("macro ") || first.equals("macro") || first.startsWith("m ")) {
            return;
        }
        commandLog.typed(player.getGameProfile().getName(), command);
    }

    private int recordStart(CommandContext<CommandSourceStack> ctx) {
        commandLog.startRecording(ctx.getSource().getTextName());
        send(ctx, Component.literal("Recording. Type the commands, then /macro record save <name>.")
                .withStyle(ChatFormatting.GOLD));
        return 1;
    }

    private int recordCancel(CommandContext<CommandSourceStack> ctx) {
        if (commandLog.stopRecording(ctx.getSource().getTextName()) == null) {
            return error(ctx, "You aren't recording");
        }
        send(ctx, Component.literal("Recording thrown away.").withStyle(ChatFormatting.GRAY));
        return 1;
    }

    private int recordSave(CommandContext<CommandSourceStack> ctx) {
        String who = ctx.getSource().getTextName();
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

    private int saveLast(CommandContext<CommandSourceStack> ctx) {
        String who = ctx.getSource().getTextName();
        String name = StringArgumentType.getString(ctx, "name");
        if (library.get(name) != null) {
            return error(ctx, "There's already a macro named " + name);
        }
        List<String> commands = commandLog.last(who, IntegerArgumentType.getInteger(ctx, "count"));
        return save(ctx, name, commands, "Saved from " + who + "'s last commands on " + LocalDate.now() + ".");
    }

    private int save(CommandContext<CommandSourceStack> ctx, String name, List<String> commands, String comment) {
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
        String text = CommandLog.toMacro(name, commands, actorNames, ctx.getSource().getTextName(), comment);
        Path file = folder.resolve("recorded" + MacroLibrary.EXTENSION);
        try {
            CommandLog.append(file, text);
        } catch (IOException e) {
            return error(ctx, "Couldn't write " + file + ": " + e.getMessage());
        }
        library.reload();
        Macro saved = library.get(name);
        send(ctx, Component.literal("Saved " + commands.size() + " commands as ").withStyle(ChatFormatting.GREEN)
                .append(Component.literal(saved != null ? saved.usage() : name).withStyle(style -> style
                        .withColor(ChatFormatting.AQUA)
                        .withClickEvent(new ClickEvent(ClickEvent.Action.SUGGEST_COMMAND, runPrefix() + name + " "))))
                .append(Component.literal(" in " + file).withStyle(ChatFormatting.GRAY)));
        return 1;
    }

    // --- the menu, and editing (docs/MACROS.md §8) ---

    /** How long after the menu asks for text through chat the menu still opens again when it comes. */
    private static final long REOPEN_MS = 10 * 60 * 1000;

    private int openMenu(CommandContext<CommandSourceStack> ctx, String name) {
        ServerPlayer player = ctx.getSource().getPlayer();
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
    private int edit(CommandContext<CommandSourceStack> ctx, EditAction action) {
        CommandSourceStack source = ctx.getSource();
        String who = source.getTextName();
        MacroEditor.Done done;
        try {
            done = action.apply(who);
        } catch (EditException e) {
            return error(ctx, e.getMessage());
        }
        LOGGER.info("[macro {}] edit: {}", who, done.message());
        send(ctx, edited(done, who));
        for (Problem w : done.warnings()) {
            send(ctx, Component.literal("  " + w).withStyle(ChatFormatting.YELLOW));
        }
        Long asked = reopen.remove(who);
        ServerPlayer player = source.getPlayer();
        if (asked != null && player != null && System.currentTimeMillis() - asked < REOPEN_MS) {
            MenuHost host = new MenuHost(player);
            MacroMenus.open(player, library.get(done.macro()) != null ? MacroMenu.macro(host, done.macro()) : MacroMenu.macros(host));
        }
        return 1;
    }

    private MutableComponent edited(MacroEditor.Done done, String who) {
        String message = done.message();
        MutableComponent line = Component.literal("[macro] " + Character.toUpperCase(message.charAt(0))
                + message.substring(1) + " ").withStyle(ChatFormatting.GREEN);
        if (library.get(done.macro()) != null) {
            line.append(button("[open]", "/macro menu " + done.macro(), "See it in the macro menu")).append(" ");
        }
        if (editor.undoable(who) != null) {
            line.append(button("[undo]", "/macro undo", "Undo: " + editor.undoable(who)));
        }
        return line;
    }

    private int book(CommandContext<CommandSourceStack> ctx) {
        ServerPlayer player = ctx.getSource().getPlayer();
        if (player == null) {
            return error(ctx, "A book is for players");
        }
        return result(ctx, new MenuHost(player).editInBook(name(ctx)));
    }

    private int bookCancel(CommandContext<CommandSourceStack> ctx) {
        ServerPlayer player = ctx.getSource().getPlayer();
        if (player == null || !MacroMenus.hasBook(player)) {
            return error(ctx, "You aren't editing a macro in a book");
        }
        MacroMenus.dropBook(player);
        send(ctx, Component.literal("[macro] Took the book back; nothing was saved").withStyle(ChatFormatting.GRAY));
        return 1;
    }

    /** A book's pages, saved as the macro once the player pressed Done: null when saved, else why not. */
    private String saveBook(ServerPlayer player, String macro, List<String> pages) {
        String who = player.getName().getString();
        try {
            MacroEditor.Done done = editor.replace(who, macro, MacroSource.fromBook(pages));
            LOGGER.info("[macro {}] edit: {} from a book", who, done.message());
            player.sendSystemMessage(edited(done, who));
            MacroMenus.open(player, MacroMenu.macro(new MenuHost(player), done.macro()));
            return null;
        } catch (EditException e) {
            player.sendSystemMessage(Component.literal("[macro] Not saved: " + e.getMessage()
                    + ". Fix the book and press Done again, or ").withStyle(ChatFormatting.RED)
                    .append(button("[cancel]", "/macro book cancel", "Take the book back without saving")));
            return e.getMessage();
        }
    }

    private int help(CommandContext<CommandSourceStack> ctx) {
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
            send(ctx, Component.literal(l[0]).withStyle(ChatFormatting.AQUA)
                    .append(Component.literal(" — " + l[1]).withStyle(ChatFormatting.GRAY)));
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

        MenuHost(ServerPlayer player) {
            this.id = player.getUUID();
            this.who = player.getName().getString();
        }

        private ServerPlayer player() {
            return server == null ? null : server.getPlayerList().getPlayer(id);
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
            ServerPlayer p = player();
            if (p != null) {
                String why = MacroCommands.this.again(p.createCommandSourceStack(), "");
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
            ServerPlayer p = player();
            return p == null ? "You left" : MacroCommands.this.run(p.createCommandSourceStack(), macro, "");
        }

        @Override
        public void suggest(String prompt, String command, boolean reopenAfter) {
            if (reopenAfter) {
                reopen.put(who, System.currentTimeMillis());
            } else {
                reopen.remove(who);
            }
            later.add(() -> {
                ServerPlayer p = player();
                if (p == null) {
                    return;
                }
                p.closeContainer();
                p.sendSystemMessage(Component.literal("✎ " + prompt + ": ").withStyle(ChatFormatting.YELLOW)
                        .append(Component.literal("[click to fill in]").withStyle(style -> style
                                .withColor(ChatFormatting.AQUA)
                                .withClickEvent(new ClickEvent(ClickEvent.Action.SUGGEST_COMMAND, command))
                                .withHoverEvent(new HoverEvent(HoverEvent.Action.SHOW_TEXT, Component.literal(command))))));
            });
        }

        @Override
        public String editInBook(String macro) {
            ServerPlayer p = player();
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
                p.sendSystemMessage(Component.literal("[macro] Right-click the book to edit " + m.name()
                        + "; Done saves it. ").withStyle(ChatFormatting.GREEN)
                        .append(button("[cancel]", "/macro book cancel", "Take the book back without saving")));
            }
            return why;
        }

        @Override
        public void open(MacroMenu.Screen screen) {
            later.add(() -> {
                ServerPlayer p = player();
                if (p != null) {
                    MacroMenus.open(p, screen);
                }
            });
        }

        @Override
        public void close() {
            later.add(() -> {
                ServerPlayer p = player();
                if (p != null) {
                    p.closeContainer();
                }
            });
        }

        @Override
        public void tell(String text, boolean error) {
            ServerPlayer p = player();
            if (p != null) {
                p.sendSystemMessage(Component.literal("[macro] " + text)
                        .withStyle(error ? ChatFormatting.RED : ChatFormatting.GREEN));
            }
        }

        @Override
        public String runPrefix() {
            return MacroCommands.this.runPrefix();
        }
    }

    // --- plumbing ---

    private static int result(CommandContext<CommandSourceStack> ctx, String why) {
        return why == null ? 1 : error(ctx, why);
    }

    /** How to call a macro on this server: {@code /m}, unless another mod owns it. */
    private String runPrefix() {
        return shortForm ? "/m " : "/macro run ";
    }

    private static void send(CommandContext<CommandSourceStack> ctx, Component line) {
        ctx.getSource().sendSystemMessage(line);
    }

    private static int error(CommandContext<CommandSourceStack> ctx, String message) {
        ctx.getSource().sendFailure(Component.literal("[macro] " + message));
        return 0;
    }
}
