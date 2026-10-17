package io.mctest.agent.core.bench;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Deque;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The commands each operator typed, for {@code /macro record} and {@code /macro last} (docs/MACROS.md §6):
 * play a sequence once, then save it as a macro instead of writing it out.
 */
public final class CommandLog {

    /** Commands remembered per player for {@code /macro last}. */
    public static final int KEEP = 100;

    private final Map<String, Deque<String>> history = new HashMap<>();
    private final Map<String, List<String>> recording = new HashMap<>();

    /** A command {@code who} typed (without the leading slash or with it; it's stored with one). */
    public synchronized void typed(String who, String command) {
        String line = command.startsWith("/") ? command : "/" + command;
        Deque<String> h = history.computeIfAbsent(who, k -> new ArrayDeque<>());
        h.addLast(line);
        while (h.size() > KEEP) {
            h.removeFirst();
        }
        List<String> rec = recording.get(who);
        if (rec != null) {
            rec.add(line);
        }
    }

    public synchronized void startRecording(String who) {
        recording.put(who, new ArrayList<>());
    }

    public synchronized boolean isRecording(String who) {
        return recording.containsKey(who);
    }

    /** How many commands {@code who}'s recording has caught so far (0 when not recording). */
    public synchronized int recorded(String who) {
        List<String> rec = recording.get(who);
        return rec == null ? 0 : rec.size();
    }

    /** Ends the recording and returns what it caught, or null if {@code who} wasn't recording. */
    public synchronized List<String> stopRecording(String who) {
        return recording.remove(who);
    }

    /** The last {@code n} commands {@code who} typed, oldest first. */
    public synchronized List<String> last(String who, int n) {
        List<String> all = new ArrayList<>(history.getOrDefault(who, new ArrayDeque<>()));
        return new ArrayList<>(all.subList(Math.max(0, all.size() - n), all.size()));
    }

    /**
     * Writes {@code commands} as a macro. Each actor named in them becomes a parameter ({@code who},
     * {@code who2}, … in the order they first appear, defaulting to the name used), and the recorder's own name
     * becomes {@code {me}}, so the result already answers "the same, for Carol": {@code /m name Carol}.
     *
     * @param actors the actor names to turn into parameters.
     * @param comment the description line written under the header.
     */
    public static String toMacro(String name, List<String> commands, Collection<String> actors, String me,
            String comment) {
        Map<String, String> params = new LinkedHashMap<>(); // actor name -> parameter
        List<String> lines = new ArrayList<>();
        for (String command : commands) {
            List<String> found = new ArrayList<>();
            for (String actor : actors) {
                if (word(actor).matcher(command).find()) {
                    found.add(actor);
                }
            }
            found.sort((a, b) -> Integer.compare(firstIndex(command, a), firstIndex(command, b)));
            for (String actor : found) {
                params.computeIfAbsent(actor, a -> params.isEmpty() ? "who" : "who" + (params.size() + 1));
            }
            String line = command;
            // Longest names first, so replacing "Bob" can't break up "Bobby".
            List<String> byLength = new ArrayList<>(params.keySet());
            byLength.sort((a, b) -> b.length() - a.length());
            for (String actor : byLength) {
                line = word(actor).matcher(line).replaceAll(Matcher.quoteReplacement("{" + params.get(actor) + "}"));
            }
            if (me != null && !me.isEmpty()) {
                line = word(me).matcher(line).replaceAll("{me}");
            }
            lines.add(line);
        }
        StringBuilder out = new StringBuilder("macro ").append(name);
        for (Map.Entry<String, String> e : params.entrySet()) {
            out.append(' ').append(e.getValue()).append('=').append(e.getKey());
        }
        out.append('\n');
        if (comment != null && !comment.isBlank()) {
            out.append("  # ").append(comment).append('\n');
        }
        for (String line : lines) {
            out.append("  ").append(line).append('\n');
        }
        out.append("end\n");
        return out.toString();
    }

    /** Appends a macro to {@code file}, with a blank line before it when the file already has text. */
    public static void append(Path file, String macroText) throws IOException {
        Files.createDirectories(file.getParent());
        String prefix = Files.exists(file) && Files.size(file) > 0 ? "\n" : "";
        Files.writeString(file, prefix + macroText, StandardCharsets.UTF_8, StandardOpenOption.CREATE,
                StandardOpenOption.APPEND);
    }

    private static Pattern word(String name) {
        return Pattern.compile("(?<![A-Za-z0-9_])" + Pattern.quote(name) + "(?![A-Za-z0-9_])");
    }

    private static int firstIndex(String command, String name) {
        Matcher m = word(name).matcher(command);
        return m.find() ? m.start() : Integer.MAX_VALUE;
    }
}
