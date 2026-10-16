package io.mctest.agent.serverfabric.mappings;

import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.ParseResults;
import com.mojang.brigadier.arguments.IntegerArgumentType;
import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.builder.LiteralArgumentBuilder;
import com.mojang.brigadier.builder.RequiredArgumentBuilder;
import com.mojang.brigadier.context.CommandContext;
import com.mojang.brigadier.context.CommandContextBuilder;
import com.mojang.brigadier.context.StringRange;
import com.mojang.brigadier.context.SuggestionContext;
import com.mojang.brigadier.exceptions.CommandSyntaxException;
import com.mojang.brigadier.suggestion.Suggestion;
import com.mojang.brigadier.suggestion.Suggestions;
import com.mojang.brigadier.suggestion.SuggestionsBuilder;
import com.mojang.brigadier.tree.CommandNode;
import io.mctest.agent.core.McTestException;
import io.mctest.agent.core.Menus;
import io.mctest.agent.serverfabric.players.FakePlayerManager;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CompletableFuture;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.minecraft.entity.Entity;
import net.minecraft.command.CommandSource;
import net.minecraft.server.command.CommandManager;
import net.minecraft.server.command.ServerCommandSource;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.text.Text;
import net.minecraft.util.math.Vec3d;

/**
 * The in-game {@code /actor} command (spec/42 §4) — the manual front door onto the SAME fake-player
 * primitives {@code player.act} drives, so a human play-testing never alt-tabs. Registered by the
 * agent sidecar only (never part of a project jar), gated to permission level 2 (ops). Spawns are
 * PERSISTENT by that front door's nature: they die only on {@code /actor remove},
 * {@code player.despawnFake}, or server stop.
 *
 * <p>Command handlers execute on the server thread, so they call the {@link Names} primitives
 * directly — no {@code call()} bounce. The puppetability guard is
 * {@link FakePlayerManager#isActor(String)}: a name outside the agent-owned roster (i.e. any real
 * player) is refused before any primitive runs.
 *
 * <pre>
 * /actor spawn &lt;name&gt; [gamemode]      /actor remove &lt;name&gt;|all       /actor list
 * /actor &lt;name&gt; here                  — teleport to the caller
 * /actor &lt;name&gt; look                  — face the caller's eyes
 * /actor &lt;name&gt; chat &lt;message…&gt;       /actor &lt;name&gt; cmd &lt;command…&gt;
 * /actor &lt;name&gt; attack &lt;target&gt;       /actor &lt;name&gt; use &lt;target&gt;     (player name or uuid)
 * /actor &lt;name&gt; useblock              — right-click the block the actor faces
 * /actor &lt;name&gt; slot &lt;n&gt; [mode]       /actor &lt;name&gt; give &lt;item [count]&gt;   /actor &lt;name&gt; hold [item]
 * /actor &lt;name&gt; menu                  — what the open GUI shows, with slot numbers
 * /actor &lt;name&gt; click &lt;text…&gt;         — click the slot whose name/lore says that
 * /actor &lt;name&gt; rclick|shiftclick &lt;text…&gt;
 * /actor &lt;name&gt; sneak|sprint on|off   /actor &lt;name&gt; gamemode &lt;mode&gt;
 * </pre>
 *
 * <p>Tab completion: actor names after {@code /actor} and {@code /actor remove}, online players for
 * {@code attack}/{@code use}, and after {@code cmd} the forwarded command itself, completed as the actor
 * would see it (its own permission level), so the suggestions match what the command will run as.
 *
 * <p>Lives in {@code mappings/} because Brigadier registration names {@code net.minecraft.*} command
 * types (the CI import-scan quarantine); the game-free registry logic stays in
 * {@link FakePlayerManager}.
 */
public final class ActorCommands {

    private ActorCommands() {
    }

    /** Registers the {@code /actor} tree; call once at mod init (before the server starts). */
    public static void install(FakePlayerManager fpm) {
        CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) -> {
            LiteralArgumentBuilder<ServerCommandSource> root = CommandManager.literal("actor")
                    .requires(src -> src.hasPermissionLevel(2));

            root.then(CommandManager.literal("spawn")
                    .then(CommandManager.argument("name", StringArgumentType.word())
                            .executes(ctx -> spawn(ctx, fpm, null))
                            .then(CommandManager.argument("gamemode", StringArgumentType.word())
                                    .executes(ctx -> spawn(ctx, fpm,
                                            StringArgumentType.getString(ctx, "gamemode"))))));

            root.then(CommandManager.literal("remove")
                    .then(CommandManager.literal("all").executes(ctx -> {
                        int n = fpm.commandRemoveAll();
                        feedback(ctx, "removed " + n + " actor" + (n == 1 ? "" : "s"));
                        return n;
                    }))
                    .then(CommandManager.argument("name", StringArgumentType.word())
                            .suggests((ctx, builder) -> suggestActors(fpm, builder))
                            .executes(ctx -> {
                                String name = StringArgumentType.getString(ctx, "name");
                                if (!fpm.commandRemove(name)) {
                                    return notAnActor(ctx, name);
                                }
                                feedback(ctx, "removed " + name);
                                return 1;
                            })));

            root.then(CommandManager.literal("list").executes(ctx -> {
                List<FakePlayerManager.ActorRecord> records = fpm.records();
                if (records.isEmpty()) {
                    feedback(ctx, "no actors (spawn one with /actor spawn <name>)");
                    return 0;
                }
                for (FakePlayerManager.ActorRecord r : records) {
                    feedback(ctx, r.name + (r.persist ? "" : " [session]") + " · via " + r.spawnedBy);
                }
                return records.size();
            }));

            // /actor <name> <verb …> — every verb goes through the isActor guard first.
            RequiredArgumentBuilder<ServerCommandSource, String> actor =
                    CommandManager.argument("name", StringArgumentType.word())
                            .suggests((ctx, builder) -> suggestActors(fpm, builder));

            actor.then(CommandManager.literal("here").executes(ctx -> verb(ctx, fpm, (names, name) -> {
                Vec3d pos = ctx.getSource().getPosition();
                String world = ctx.getSource().getWorld().getRegistryKey().getValue().toString();
                names.actTeleport(name, world, pos.x, pos.y, pos.z);
                return "teleported to " + ctx.getSource().getName();
            })));

            actor.then(CommandManager.literal("look").executes(ctx -> verb(ctx, fpm, (names, name) -> {
                Entity caller = ctx.getSource().getEntity();
                Vec3d eye = caller != null ? caller.getEyePos() : ctx.getSource().getPosition();
                names.actLookAt(name, eye.x, eye.y, eye.z);
                return "looking at " + ctx.getSource().getName();
            })));

            actor.then(CommandManager.literal("chat")
                    .then(CommandManager.argument("message", StringArgumentType.greedyString())
                            .executes(ctx -> verb(ctx, fpm, (names, name) -> {
                                names.actChat(name, StringArgumentType.getString(ctx, "message"));
                                return "chatted";
                            }))));

            actor.then(CommandManager.literal("cmd")
                    .then(CommandManager.argument("command", StringArgumentType.greedyString())
                            .suggests((ctx, builder) -> suggestCommand(ctx, fpm, builder))
                            .executes(ctx -> verb(ctx, fpm, (names, name) -> {
                                names.actCommand(name, StringArgumentType.getString(ctx, "command"));
                                return "dispatched";
                            }))));

            actor.then(CommandManager.literal("attack")
                    .then(CommandManager.argument("target", StringArgumentType.word())
                            .suggests((ctx, builder) -> CommandSource.suggestMatching(
                                    ctx.getSource().getPlayerNames(), builder))
                            .executes(ctx -> verb(ctx, fpm, (names, name) ->
                                    names.actAttackEntity(name,
                                            StringArgumentType.getString(ctx, "target"))))));

            actor.then(CommandManager.literal("use")
                    .then(CommandManager.argument("target", StringArgumentType.word())
                            .suggests((ctx, builder) -> CommandSource.suggestMatching(
                                    ctx.getSource().getPlayerNames(), builder))
                            .executes(ctx -> verb(ctx, fpm, (names, name) ->
                                    names.actInteractEntity(name,
                                            StringArgumentType.getString(ctx, "target"))))));

            actor.then(CommandManager.literal("useblock").executes(ctx ->
                    verb(ctx, fpm, Names::actUseBlockFacing)));

            actor.then(CommandManager.literal("slot")
                    .then(CommandManager.argument("n", IntegerArgumentType.integer(0))
                            .executes(ctx -> verb(ctx, fpm, (names, name) -> {
                                names.actClickMenuSlot(name, IntegerArgumentType.getInteger(ctx, "n"),
                                        0, "PICKUP");
                                return "clicked";
                            }))
                            .then(CommandManager.argument("mode", StringArgumentType.word())
                                    .executes(ctx -> verb(ctx, fpm, (names, name) -> {
                                        String mode = StringArgumentType.getString(ctx, "mode");
                                        names.actClickMenuSlot(name,
                                                IntegerArgumentType.getInteger(ctx, "n"),
                                                Menus.button(mode, 0), Menus.clickMode(mode));
                                        return "clicked";
                                    })))));

            // Clicking a modded GUI by the text it shows — the whole point of spec/42's click-text
            // surface, and the only one that works without counting squares in a screenshot.
            actor.then(CommandManager.literal("click")
                    .then(CommandManager.argument("text", StringArgumentType.greedyString())
                            .executes(ctx -> verb(ctx, fpm, (names, name) -> fpm.clickMenuText(name,
                                    StringArgumentType.getString(ctx, "text").trim(),
                                    false, true, null, 0, "PICKUP")))));

            actor.then(CommandManager.literal("rclick")
                    .then(CommandManager.argument("text", StringArgumentType.greedyString())
                            .executes(ctx -> verb(ctx, fpm, (names, name) -> fpm.clickMenuText(name,
                                    StringArgumentType.getString(ctx, "text").trim(),
                                    false, true, null, 1, "PICKUP")))));

            actor.then(CommandManager.literal("shiftclick")
                    .then(CommandManager.argument("text", StringArgumentType.greedyString())
                            .executes(ctx -> verb(ctx, fpm, (names, name) -> fpm.clickMenuText(name,
                                    StringArgumentType.getString(ctx, "text").trim(),
                                    false, true, null, 0, "QUICK_MOVE")))));

            actor.then(CommandManager.literal("menu").executes(ctx ->
                    verb(ctx, fpm, (names, name) -> fpm.describeMenu(name))));

            // give takes one greedy arg ("minecraft:diamond 3") so namespaced ids need no quoting —
            // Brigadier's word() has no ':' and quoted string() is hostile to hand-typing.
            actor.then(CommandManager.literal("give")
                    .then(CommandManager.argument("item", StringArgumentType.greedyString())
                            .executes(ctx -> verb(ctx, fpm, (names, name) -> {
                                String[] parts = StringArgumentType.getString(ctx, "item")
                                        .trim().split("\\s+");
                                int count = 1;
                                if (parts.length > 1) {
                                    try {
                                        count = Integer.parseInt(parts[1]);
                                    } catch (NumberFormatException e) {
                                        throw McTestException.invalidParams(
                                                "Bad count: " + parts[1]);
                                    }
                                }
                                names.actGive(name, parts[0], count);
                                return "given " + count + " " + parts[0];
                            }))));

            actor.then(CommandManager.literal("hold")
                    .executes(ctx -> verb(ctx, fpm, (names, name) -> {
                        names.actHold(name, null);
                        return "hand cleared";
                    }))
                    .then(CommandManager.argument("item", StringArgumentType.greedyString())
                            .executes(ctx -> verb(ctx, fpm, (names, name) -> {
                                String item = StringArgumentType.getString(ctx, "item").trim();
                                names.actHold(name, item);
                                return "holding " + item;
                            }))));

            actor.then(onOff("sneak", fpm, (names, name, on) -> names.actSneak(name, on)));
            actor.then(onOff("sprint", fpm, (names, name, on) -> names.actSprint(name, on)));

            actor.then(CommandManager.literal("gamemode")
                    .then(CommandManager.argument("mode", StringArgumentType.word())
                            .executes(ctx -> verb(ctx, fpm, (names, name) -> {
                                names.actSetGameMode(name, StringArgumentType.getString(ctx, "mode"));
                                return "gamemode set";
                            }))));

            root.then(actor);
            dispatcher.register(root);
        });
    }

    // --- handler plumbing ---

    private interface ActorVerb {
        String run(Names names, String actorName) throws McTestException;
    }

    private interface ToggleVerb {
        void run(Names names, String actorName, boolean on) throws McTestException;
    }

    private static CompletableFuture<Suggestions> suggestActors(FakePlayerManager fpm,
            SuggestionsBuilder builder) {
        List<String> names = new ArrayList<>();
        for (FakePlayerManager.ActorRecord r : fpm.records()) {
            names.add(r.name);
        }
        return CommandSource.suggestMatching(names, builder);
    }

    /**
     * Completes the command after {@code cmd} by asking the dispatcher about it as the actor, then shifts
     * the answers back to where that command starts in the full {@code /actor} line. Nothing is suggested
     * for a name that isn't an online actor, since the command couldn't run anyway.
     */
    private static CompletableFuture<Suggestions> suggestCommand(CommandContext<ServerCommandSource> ctx,
            FakePlayerManager fpm, SuggestionsBuilder builder) {
        String name = StringArgumentType.getString(ctx, "name");
        ServerPlayerEntity actor = fpm.isActor(name)
                ? ctx.getSource().getServer().getPlayerManager().getPlayer(name) : null;
        if (actor == null) {
            return builder.buildFuture();
        }
        String command = builder.getRemaining();
        // actCommand runs it through executeWithPrefix, which takes it with or without the slash.
        int skip = command.startsWith("/") ? 1 : 0;
        int offset = builder.getStart() + skip;
        CommandDispatcher<ServerCommandSource> dispatcher =
                ctx.getSource().getServer().getCommandManager().getDispatcher();
        ServerCommandSource source = actor.getCommandSource();
        return completeAs(dispatcher.parse(command.substring(skip), source), source).thenApply(inner -> {
            List<Suggestion> shifted = new ArrayList<>();
            for (Suggestion s : inner.getList()) {
                StringRange r = s.getRange();
                shifted.add(new Suggestion(new StringRange(r.getStart() + offset, r.getEnd() + offset),
                        s.getText(), s.getTooltip()));
            }
            return Suggestions.create(builder.getInput(), shifted);
        });
    }

    /**
     * {@link CommandDispatcher#getCompletionSuggestions}, minus the nodes {@code source} may not use.
     * Brigadier doesn't check {@code requires} when it lists the next words, because the game only sends
     * a client the commands it may use; here the whole server tree is asked, so a non-op actor would be
     * offered {@code gamemode} without this filter.
     */
    private static CompletableFuture<Suggestions> completeAs(ParseResults<ServerCommandSource> parse,
            ServerCommandSource source) {
        String input = parse.getReader().getString();
        int cursor = input.length();
        CommandContextBuilder<ServerCommandSource> context = parse.getContext();
        SuggestionContext<ServerCommandSource> before = context.findSuggestionContext(cursor);
        int start = Math.min(before.startPos, cursor);
        String lower = input.toLowerCase(Locale.ROOT);
        List<CompletableFuture<Suggestions>> futures = new ArrayList<>();
        for (CommandNode<ServerCommandSource> node : before.parent.getChildren()) {
            if (!node.canUse(source)) {
                continue;
            }
            try {
                futures.add(node.listSuggestions(context.build(input),
                        new SuggestionsBuilder(input, lower, start)));
            } catch (CommandSyntaxException ignored) {
                // Same as Brigadier: a node that can't suggest here just adds nothing.
            }
        }
        return CompletableFuture.allOf(futures.toArray(new CompletableFuture[0])).thenApply(v -> {
            List<Suggestions> all = new ArrayList<>();
            for (CompletableFuture<Suggestions> f : futures) {
                all.add(f.join());
            }
            return Suggestions.merge(input, all);
        });
    }

    private static int spawn(CommandContext<ServerCommandSource> ctx, FakePlayerManager fpm,
            String gameMode) {
        String name = StringArgumentType.getString(ctx, "name");
        Vec3d pos = ctx.getSource().getPosition();
        String world = ctx.getSource().getWorld().getRegistryKey().getValue().toString();
        try {
            fpm.commandSpawn(name, pos.x, pos.y, pos.z, world, gameMode);
        } catch (McTestException e) {
            return error(ctx, e.getMessage());
        }
        feedback(ctx, "spawned " + name + " (persistent — /actor remove " + name + " to despawn)");
        return 1;
    }

    /** Guard + run + feedback for one actor verb; every failure is a red message, never a throw. */
    private static int verb(CommandContext<ServerCommandSource> ctx, FakePlayerManager fpm,
            ActorVerb body) {
        String name = StringArgumentType.getString(ctx, "name");
        if (!fpm.isActor(name)) {
            return notAnActor(ctx, name);
        }
        try {
            String detail = body.run(names(fpm), name);
            feedback(ctx, name + ": " + detail);
            return 1;
        } catch (McTestException e) {
            return error(ctx, name + ": " + e.getMessage());
        }
    }

    private static LiteralArgumentBuilder<ServerCommandSource> onOff(String literal,
            FakePlayerManager fpm, ToggleVerb body) {
        return CommandManager.literal(literal)
                .then(CommandManager.literal("on").executes(ctx -> verb(ctx, fpm, (names, name) -> {
                    body.run(names, name, true);
                    return literal + " on";
                })))
                .then(CommandManager.literal("off").executes(ctx -> verb(ctx, fpm, (names, name) -> {
                    body.run(names, name, false);
                    return literal + " off";
                })));
    }

    private static Names names(FakePlayerManager fpm) {
        return fpm.names();
    }

    private static int notAnActor(CommandContext<ServerCommandSource> ctx, String name) {
        return error(ctx, "No actor named '" + name
                + "' — real players can't be driven; see /actor list");
    }

    private static void feedback(CommandContext<ServerCommandSource> ctx, String message) {
        ctx.getSource().sendFeedback(() -> Text.literal("[actor] " + message), false);
    }

    private static int error(CommandContext<ServerCommandSource> ctx, String message) {
        ctx.getSource().sendError(Text.literal("[actor] " + message));
        return 0;
    }
}
