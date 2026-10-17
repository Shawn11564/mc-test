package io.mctest.agent.core.bench;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Collection;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

/**
 * Where the macro menu shows each macro (docs/MACROS.md §8): the places people dragged them to, kept in
 * {@code macros.layout} in the first macro folder so the arrangement survives restarts. A position is
 * {@code page * 45 + slot}. Macros nobody placed fill the free places in file order.
 */
public final class MacroLayout {

    /** Macro places per menu page (five rows of nine; the sixth row holds the buttons). */
    public static final int PAGE = 45;
    public static final String FILE = "macros.layout";

    private final Path file;
    private final Map<String, Integer> placed = new LinkedHashMap<>();
    private long stamp = Long.MIN_VALUE;

    /** @param file where to keep it, or null to keep it only in memory. */
    public MacroLayout(Path file) {
        this.file = file;
    }

    /**
     * Each position's macro. {@code held} are macros being dragged: they get no place, but their old places
     * stay empty rather than filling with another macro while the drag is on.
     */
    public synchronized Map<Integer, String> arrange(Collection<String> names, Set<String> held) {
        load();
        Map<Integer, String> out = new TreeMap<>();
        Set<Integer> reserved = new HashSet<>();
        for (String name : names) {
            Integer at = placed.get(name);
            if (at != null && !held.contains(name) && !out.containsKey(at)) {
                out.put(at, name);
            }
        }
        for (String name : held) {
            Integer at = placed.get(name);
            if (at != null && !out.containsKey(at)) {
                reserved.add(at);
            }
        }
        int next = 0;
        for (String name : names) {
            if (held.contains(name) || out.containsValue(name)) {
                continue;
            }
            while (out.containsKey(next) || reserved.contains(next)) {
                next++;
            }
            out.put(next, name);
        }
        return out;
    }

    /** Puts {@code name} at {@code position}, and pins down every other shown macro where it is now. */
    public synchronized void put(Map<Integer, String> shown, String name, int position) {
        load();
        for (Map.Entry<Integer, String> e : shown.entrySet()) {
            if (e.getKey() != position && !e.getValue().equals(name)) {
                placed.put(e.getValue(), e.getKey());
            }
        }
        placed.put(name, position);
        save();
    }

    /** Pins every shown macro where it is now, so nothing moves into a gap a drag leaves. */
    public synchronized void pin(Map<Integer, String> shown) {
        load();
        boolean changed = false;
        for (Map.Entry<Integer, String> e : shown.entrySet()) {
            changed |= !e.getKey().equals(placed.put(e.getValue(), e.getKey()));
        }
        if (changed) {
            save();
        }
    }

    public synchronized void rename(String from, String to) {
        load();
        Integer at = placed.remove(from);
        if (at != null) {
            placed.put(to, at);
            save();
        }
    }

    public synchronized void forget(String name) {
        load();
        if (placed.remove(name) != null) {
            save();
        }
    }

    /** Back to file order. */
    public synchronized void clear() {
        placed.clear();
        save();
    }

    /** How many pages {@code shown} fills (at least one). */
    public static int pages(Map<Integer, String> shown) {
        int last = shown.keySet().stream().mapToInt(Integer::intValue).max().orElse(0);
        return last / PAGE + 1;
    }

    private void load() {
        if (file == null) {
            return;
        }
        long now = Files.exists(file) ? file.toFile().lastModified() : -1;
        if (now == stamp) {
            return;
        }
        stamp = now;
        placed.clear();
        if (now < 0) {
            return;
        }
        try {
            for (String line : Files.readAllLines(file, StandardCharsets.UTF_8)) {
                String l = line.strip();
                int space = l.indexOf(' ');
                if (l.isEmpty() || l.startsWith("#") || space < 0) {
                    continue;
                }
                try {
                    placed.put(l.substring(space + 1).strip(), Integer.parseInt(l.substring(0, space)));
                } catch (NumberFormatException e) {
                    // A hand-edited line we can't read: that macro just goes back to a free place.
                }
            }
        } catch (IOException e) {
            // Unreadable: show file order, and the next drag writes a fresh one.
        }
    }

    private void save() {
        if (file == null) {
            return;
        }
        StringBuilder out = new StringBuilder("# Where /macro shows each macro: page * 45 + slot, then the name.\n"
                + "# Written when you drag macros around in the menu; safe to edit or delete.\n");
        placed.entrySet().stream().sorted(Map.Entry.comparingByValue())
                .forEach(e -> out.append(e.getValue()).append(' ').append(e.getKey()).append('\n'));
        try {
            Files.createDirectories(file.getParent());
            Files.writeString(file, out.toString(), StandardCharsets.UTF_8);
            stamp = file.toFile().lastModified();
        } catch (IOException e) {
            // The arrangement still holds for this run.
        }
    }
}
