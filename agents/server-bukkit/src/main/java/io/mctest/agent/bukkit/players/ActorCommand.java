package io.mctest.agent.bukkit.players;

import com.google.gson.JsonObject;
import io.mctest.agent.core.McTestException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import org.bukkit.Bukkit;
import org.bukkit.ChatColor;
import org.bukkit.Location;
import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.command.TabCompleter;
import org.bukkit.entity.Player;

/**
 * The in-game {@code /actor} command (spec/42 §4) — the Bukkit twin of the modded agents' Brigadier
 * tree, the manual front door onto the same fake-player primitives {@code player.act} drives.
 * Registered in plugin.yml behind {@code mctest.actor} (default op); handlers run on the main thread
 * (Bukkit command dispatch) so they call {@link FakePlayerManager}'s {@code command*} surface
 * directly. The agent-owned roster is the puppetability guard — real players are refused by name.
 *
 * <pre>
 * /actor spawn &lt;name&gt; [gamemode]      /actor remove &lt;name&gt;|all       /actor list
 * /actor &lt;name&gt; here|look             — relative to the calling player
 * /actor &lt;name&gt; chat|cmd &lt;…&gt;          /actor &lt;name&gt; attack|use &lt;target&gt;
 * /actor &lt;name&gt; useblock              /actor &lt;name&gt; slot &lt;n&gt; [mode]
 * /actor &lt;name&gt; menu                  — what the open GUI shows, with slot numbers
 * /actor &lt;name&gt; click &lt;text…&gt;         — click the slot whose name/lore says that
 * /actor &lt;name&gt; rclick|shiftclick &lt;text…&gt;
 * /actor &lt;name&gt; give &lt;item&gt; [count]   /actor &lt;name&gt; hold [item]
 * /actor &lt;name&gt; sneak|sprint on|off   /actor &lt;name&gt; gamemode &lt;mode&gt;
 * </pre>
 *
 * <p>Tab completion (the executor is also the command's {@link TabCompleter}): the subcommands and actor
 * names, the verbs, online players for {@code attack}/{@code use}, {@code on|off}, and after {@code cmd}
 * the forwarded command itself, completed through the command map as the actor (its own permissions).
 *
 * <p>Available only when the NATIVE backend probed successfully — a Carpet-only or plain-Spigot
 * server gets an honest message instead of a half-working command.
 */
public final class ActorCommand implements CommandExecutor, TabCompleter {

    private static final List<String> VERBS = List.of("here", "look", "chat", "cmd", "attack", "use",
            "useblock", "slot", "menu", "click", "rclick", "shiftclick", "give", "hold", "sneak", "sprint",
            "gamemode");

    private final FakePlayerManager fpm;

    public ActorCommand(FakePlayerManager fpm) {
        this.fpm = fpm;
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (!fpm.isNative()) {
            error(sender, "Native fake-player backend unavailable on this server "
                    + "(needs Paper 1.20.5+ with the Mojang-mapped runtime).");
            return true;
        }
        if (args.length == 0) {
            error(sender, "Usage: /actor spawn <name> [gamemode] | remove <name>|all | list | "
                    + "<name> <verb …>");
            return true;
        }
        try {
            run(sender, args);
        } catch (McTestException e) {
            error(sender, e.getMessage());
        }
        return true;
    }

    @Override
    public List<String> onTabComplete(CommandSender sender, Command command, String label, String[] args) {
        if (!fpm.isNative() || args.length == 0) {
            return List.of();
        }
        String last = args[args.length - 1];
        if (args.length == 1) {
            List<String> options = new ArrayList<>(List.of("spawn", "remove", "list"));
            options.addAll(actorNames());
            return matching(options, last);
        }
        String first = args[0].toLowerCase(Locale.ROOT);
        if (first.equals("spawn") || first.equals("list")) {
            return List.of();
        }
        if (first.equals("remove")) {
            if (args.length > 2) {
                return List.of();
            }
            List<String> options = new ArrayList<>(List.of("all"));
            options.addAll(actorNames());
            return matching(options, last);
        }
        if (!fpm.isActor(args[0])) {
            return List.of();
        }
        if (args.length == 2) {
            return matching(VERBS, last);
        }
        String verb = args[1].toLowerCase(Locale.ROOT);
        if (verb.equals("cmd")) {
            return completeCommand(args[0], String.join(" ", Arrays.copyOfRange(args, 2, args.length)));
        }
        if (args.length > 3) {
            return List.of();
        }
        switch (verb) {
            case "attack":
            case "use": {
                List<String> online = new ArrayList<>();
                for (Player p : Bukkit.getOnlinePlayers()) {
                    online.add(p.getName());
                }
                return matching(online, last);
            }
            case "sneak":
            case "sprint":
                return matching(List.of("on", "off"), last);
            default:
                return List.of();
        }
    }

    /**
     * Asks the command map what the actor could type next. Bukkit completes only the last word, which is
     * also what the client replaces, so the answers need no shifting. A first word comes back with a
     * {@code /} for a player sender; keep it only if the caller typed one.
     */
    private static List<String> completeCommand(String actorName, String line) {
        Player actor = Bukkit.getPlayerExact(actorName);
        if (actor == null) {
            return List.of();
        }
        boolean slash = line.startsWith("/");
        String bare = slash ? line.substring(1) : line;
        List<String> found = Bukkit.getCommandMap().tabComplete(actor, bare);
        if (found == null) {
            return List.of();
        }
        if (bare.indexOf(' ') >= 0) {
            return found;
        }
        List<String> names = new ArrayList<>();
        for (String s : found) {
            String name = s.startsWith("/") ? s.substring(1) : s;
            names.add(slash ? "/" + name : name);
        }
        return names;
    }

    private List<String> actorNames() {
        List<String> names = new ArrayList<>();
        for (FakePlayerManager.ActorRecord r : fpm.records()) {
            names.add(r.name);
        }
        return names;
    }

    private static List<String> matching(List<String> options, String prefix) {
        String p = prefix.toLowerCase(Locale.ROOT);
        List<String> out = new ArrayList<>();
        for (String o : options) {
            if (o.toLowerCase(Locale.ROOT).startsWith(p)) {
                out.add(o);
            }
        }
        return out;
    }

    private void run(CommandSender sender, String[] args) throws McTestException {
        switch (args[0].toLowerCase(Locale.ROOT)) {
            case "spawn": {
                if (args.length < 2) {
                    error(sender, "Usage: /actor spawn <name> [gamemode]");
                    return;
                }
                if (!(sender instanceof Player caller)) {
                    error(sender, "/actor spawn needs a player caller (spawns at your position)");
                    return;
                }
                String name = args[1];
                String gameMode = args.length > 2 ? args[2] : null;
                fpm.commandSpawn(name, caller.getLocation(), gameMode);
                feedback(sender, "spawned " + name + " (persistent — /actor remove " + name
                        + " to despawn)");
                return;
            }
            case "remove": {
                if (args.length < 2) {
                    error(sender, "Usage: /actor remove <name>|all");
                    return;
                }
                if ("all".equalsIgnoreCase(args[1])) {
                    int n = fpm.commandRemoveAll();
                    feedback(sender, "removed " + n + " actor" + (n == 1 ? "" : "s"));
                } else if (fpm.commandRemove(args[1])) {
                    feedback(sender, "removed " + args[1]);
                } else {
                    notAnActor(sender, args[1]);
                }
                return;
            }
            case "list": {
                List<FakePlayerManager.ActorRecord> records = fpm.records();
                if (records.isEmpty()) {
                    feedback(sender, "no actors (spawn one with /actor spawn <name>)");
                    return;
                }
                for (FakePlayerManager.ActorRecord r : records) {
                    feedback(sender, r.name + (r.persist ? "" : " [session]") + " · via "
                            + r.spawnedBy + " · " + r.backend);
                }
                return;
            }
            default:
                actorVerb(sender, args);
        }
    }

    private void actorVerb(CommandSender sender, String[] args) throws McTestException {
        String name = args[0];
        if (!fpm.isActor(name)) {
            notAnActor(sender, name);
            return;
        }
        if (args.length < 2) {
            error(sender, "Usage: /actor " + name + " <here|look|chat|cmd|attack|use|useblock|slot|"
                    + "menu|click|rclick|shiftclick|give|hold|sneak|sprint|gamemode> …");
            return;
        }
        String verb = args[1].toLowerCase(Locale.ROOT);
        JsonObject a = new JsonObject();
        switch (verb) {
            case "here": {
                Location loc = requireCaller(sender).getLocation();
                a.addProperty("world", loc.getWorld().getKey().toString());
                a.addProperty("x", loc.getX());
                a.addProperty("y", loc.getY());
                a.addProperty("z", loc.getZ());
                done(sender, name, fpm.commandVerb(name, "teleport", a));
                return;
            }
            case "look": {
                Location eye = requireCaller(sender).getEyeLocation();
                a.addProperty("x", eye.getX());
                a.addProperty("y", eye.getY());
                a.addProperty("z", eye.getZ());
                done(sender, name, fpm.commandVerb(name, "lookAt", a));
                return;
            }
            case "chat":
                a.addProperty("message", rest(args, 2));
                done(sender, name, fpm.commandVerb(name, "chat", a));
                return;
            case "cmd":
                a.addProperty("command", rest(args, 2));
                done(sender, name, fpm.commandVerb(name, "command", a));
                return;
            case "attack":
                a.addProperty("target", requireArg(args, 2, "target"));
                done(sender, name, fpm.commandVerb(name, "attack", a));
                return;
            case "use":
                a.addProperty("target", requireArg(args, 2, "target"));
                done(sender, name, fpm.commandVerb(name, "interactEntity", a));
                return;
            case "useblock":
                done(sender, name, fpm.commandUseBlockFacing(name));
                return;
            case "slot":
                a.addProperty("slot", requireInt(args, 2, "slot"));
                if (args.length > 3) {
                    a.addProperty("mode", args[3]);
                }
                done(sender, name, fpm.commandVerb(name, "clickMenuSlot", a));
                return;
            // Clicking a modded GUI by the text it shows — the whole point of spec/42's click-text
            // surface, and the only one that works without counting squares in a screenshot.
            case "click":
            case "rclick":
            case "shiftclick":
                a.addProperty("text", rest(args, 2));
                if (verb.equals("rclick")) {
                    a.addProperty("button", 1);
                } else if (verb.equals("shiftclick")) {
                    a.addProperty("mode", "quickMove");
                }
                done(sender, name, fpm.commandVerb(name, "clickMenuText", a));
                return;
            case "menu":
                done(sender, name, fpm.describeMenu(name));
                return;
            case "give": {
                a.addProperty("item", requireArg(args, 2, "item"));
                if (args.length > 3) {
                    a.addProperty("count", requireInt(args, 3, "count"));
                }
                done(sender, name, fpm.commandVerb(name, "give", a));
                return;
            }
            case "hold":
                if (args.length > 2) {
                    a.addProperty("item", args[2]);
                }
                done(sender, name, fpm.commandVerb(name, "hold", a));
                return;
            case "sneak":
            case "sprint":
                a.addProperty("on", "on".equalsIgnoreCase(requireArg(args, 2, "on|off")));
                done(sender, name, fpm.commandVerb(name, verb, a));
                return;
            case "gamemode":
                a.addProperty("mode", requireArg(args, 2, "mode"));
                done(sender, name, fpm.commandVerb(name, "setGameMode", a));
                return;
            default:
                error(sender, "Unknown verb: " + verb);
        }
    }

    // --- plumbing ---

    private static Player requireCaller(CommandSender sender) throws McTestException {
        if (sender instanceof Player player) {
            return player;
        }
        throw McTestException.invalidParams("this verb needs a player caller");
    }

    private static String requireArg(String[] args, int index, String what) throws McTestException {
        if (args.length <= index) {
            throw McTestException.invalidParams("missing <" + what + ">");
        }
        return args[index];
    }

    private static int requireInt(String[] args, int index, String what) throws McTestException {
        try {
            return Integer.parseInt(requireArg(args, index, what));
        } catch (NumberFormatException e) {
            throw McTestException.invalidParams("bad <" + what + ">: " + args[index]);
        }
    }

    private static String rest(String[] args, int from) throws McTestException {
        if (args.length <= from) {
            throw McTestException.invalidParams("missing text");
        }
        return String.join(" ", java.util.Arrays.copyOfRange(args, from, args.length));
    }

    private static void done(CommandSender sender, String name, String detail) {
        feedback(sender, name + ": " + detail);
    }

    private static void notAnActor(CommandSender sender, String name) {
        error(sender, "No actor named '" + name + "' — real players can't be driven; see /actor list");
    }

    private static void feedback(CommandSender sender, String message) {
        sender.sendMessage("[actor] " + message);
    }

    private static void error(CommandSender sender, String message) {
        sender.sendMessage(ChatColor.RED + "[actor] " + message);
    }
}
