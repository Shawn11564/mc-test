package io.mctest.agent.core.bench;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.stream.Stream;

/**
 * Every macro in a project's macro folders (docs/MACROS.md §4). Folders come from {@code MCTEST_MACROS}
 * (paths split by the platform's path separator), so the macros live in the project's repo next to its test
 * guide. Files are read again whenever one changes, so an edited macro runs as soon as it's saved.
 */
public final class MacroLibrary {

    /** The file extension the library reads. */
    public static final String EXTENSION = ".macro";
    /** How stale a lookup may be: a file saved in an editor is seen within this long. */
    public static final long RESCAN_MS = 500;

    private final List<Path> folders;
    private Map<String, Macro> macros = Collections.emptyMap();
    private List<Problem> problems = Collections.emptyList();
    private Map<Path, Long> stamps = Collections.emptyMap();
    private Map<String, Path> paths = Collections.emptyMap();
    private long scanned;

    public MacroLibrary(List<Path> folders) {
        this.folders = List.copyOf(folders);
    }

    /** The folders named by {@code value} (e.g. {@code MCTEST_MACROS}), or {@code fallback} when it's blank. */
    public static List<Path> folders(String value, Path fallback) {
        List<Path> out = new ArrayList<>();
        if (value != null) {
            for (String part : value.split(File.pathSeparator)) {
                if (!part.isBlank()) {
                    out.add(Path.of(part.strip()));
                }
            }
        }
        if (out.isEmpty() && fallback != null) {
            out.add(fallback);
        }
        return out;
    }

    public List<Path> folders() {
        return folders;
    }

    /** Where {@code /macro record} writes: the first folder. */
    public Path recordFolder() {
        return folders.isEmpty() ? null : folders.get(0);
    }

    /**
     * Reloads if any file was added, removed or changed since the last read. Looks at most every
     * {@link #RESCAN_MS} (the menu asks many times a redraw); {@link #reload} always reads.
     */
    public synchronized void refresh() {
        long at = System.nanoTime();
        if (scanned != 0 && at - scanned < RESCAN_MS * 1_000_000L) {
            return;
        }
        scanned = at;
        Map<Path, Long> now = scan();
        if (!now.equals(stamps)) {
            load(now);
        }
    }

    /** Reads every file again. */
    public synchronized void reload() {
        scanned = System.nanoTime();
        load(scan());
    }

    /** The macro called {@code name}, matched exactly or else ignoring case ({@code area.b} finds {@code area.B}). */
    public synchronized Macro get(String name) {
        refresh();
        Macro exact = macros.get(name);
        if (exact != null) {
            return exact;
        }
        for (Macro m : macros.values()) {
            if (m.name().equalsIgnoreCase(name)) {
                return m;
            }
        }
        return null;
    }

    /** Every macro, by name, in file order. */
    public synchronized Map<String, Macro> all() {
        refresh();
        return macros;
    }

    /** The file a macro was read from, or null (unknown name, or a library built from text). */
    public synchronized Path path(String name) {
        Macro m = get(name);
        return m == null ? null : paths.get(m.name());
    }

    /**
     * Where a new macro called {@code name} goes: next to the macros that share its prefix ({@code area.give}
     * joins the file holding {@code area.take}), else {@code new.macro} in the first folder.
     */
    public synchronized Path fileForNew(String name) {
        refresh();
        int dot = name.lastIndexOf('.');
        if (dot > 0) {
            String prefix = name.substring(0, dot + 1).toLowerCase(Locale.ROOT);
            for (Macro m : macros.values()) {
                if (m.name().toLowerCase(Locale.ROOT).startsWith(prefix) && paths.containsKey(m.name())) {
                    return paths.get(m.name());
                }
            }
        }
        return recordFolder() == null ? null : recordFolder().resolve("new" + EXTENSION);
    }

    public synchronized List<Problem> problems() {
        refresh();
        return problems;
    }

    /** Adds macros parsed from text (tests, and the guide checker's own fixtures). */
    public static MacroLibrary of(Map<String, String> files) {
        MacroLibrary library = new MacroLibrary(List.of());
        Map<String, Macro> found = new LinkedHashMap<>();
        List<Problem> problems = new ArrayList<>();
        for (Map.Entry<String, String> e : files.entrySet()) {
            collect(found, problems, MacroParser.parse(e.getKey(), e.getValue()));
        }
        library.macros = Collections.unmodifiableMap(found);
        library.problems = Collections.unmodifiableList(problems);
        return library;
    }

    private Map<Path, Long> scan() {
        Map<Path, Long> out = new HashMap<>();
        for (Path folder : folders) {
            if (!Files.isDirectory(folder)) {
                continue;
            }
            try (Stream<Path> files = Files.walk(folder)) {
                files.filter(p -> p.getFileName().toString().endsWith(EXTENSION) && Files.isRegularFile(p))
                        .forEach(p -> out.put(p, p.toFile().lastModified()));
            } catch (IOException e) {
                // A folder that can't be listed has no macros; the problem list says why.
                out.put(folder, -1L);
            }
        }
        return out;
    }

    private void load(Map<Path, Long> scanned) {
        Map<String, Macro> found = new LinkedHashMap<>();
        Map<String, Path> where = new HashMap<>();
        List<Problem> loaded = new ArrayList<>();
        for (Path folder : folders) {
            if (!Files.isDirectory(folder)) {
                loaded.add(Problem.warning(folder.toString(), 0, "macro folder doesn't exist"));
                continue;
            }
            List<Path> files = new ArrayList<>();
            for (Path p : scanned.keySet()) {
                if (p.startsWith(folder) && !p.equals(folder)) {
                    files.add(p);
                }
            }
            Collections.sort(files);
            for (Path p : files) {
                String label = folder.relativize(p).toString().replace('\\', '/');
                try {
                    for (Macro m : collect(found, loaded, MacroParser.parse(label, Files.readString(p, StandardCharsets.UTF_8)))) {
                        where.put(m.name(), p);
                    }
                } catch (IOException e) {
                    loaded.add(Problem.error(label, 0, "can't read: " + e.getMessage()));
                }
            }
        }
        macros = Collections.unmodifiableMap(found);
        problems = Collections.unmodifiableList(loaded);
        paths = where;
        stamps = scanned;
    }

    /** @return the macros it added (not the ones already defined elsewhere). */
    private static List<Macro> collect(Map<String, Macro> found, List<Problem> problems, MacroParser.Result result) {
        problems.addAll(result.problems());
        List<Macro> added = new ArrayList<>();
        for (Macro m : result.macros()) {
            Macro earlier = found.get(m.name());
            if (earlier != null) {
                problems.add(Problem.error(m.file(), m.line(), "macro " + m.name() + " is already defined at "
                        + earlier.file() + ":" + earlier.line()));
                continue;
            }
            found.put(m.name(), m);
            added.add(m);
        }
        return added;
    }
}
