package io.mctest.agent.core.bench;

import io.mctest.agent.core.bench.MacroSource.EditException;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Changes macros in their files for {@code /macro edit} and the macro menu (docs/MACROS.md §8). Each edit reads
 * the file fresh (so an edit made in an editor meanwhile isn't lost), refuses a change that would add a parse
 * error to the macro, writes the file, and remembers the old text so {@code /macro undo} can put it back.
 */
public final class MacroEditor {

    /** How many edits each person can undo. */
    public static final int UNDO = 20;

    /** An edit that worked: the macro's name after it, what was done, and any warnings the new text has. */
    public record Done(String macro, String message, List<Problem> warnings) {
    }

    @FunctionalInterface
    private interface Change {
        String apply(String text) throws EditException;
    }

    private record Undo(Path file, String before, String after, String what, String macro) {
    }

    private final MacroLibrary library;
    private final MacroLayout layout;
    private final Map<String, Deque<Undo>> undo = new HashMap<>();

    public MacroEditor(MacroLibrary library, MacroLayout layout) {
        this.library = library;
        this.layout = layout;
    }

    // --- steps ---

    public synchronized Done setStep(String who, String macro, int n, String step) throws EditException {
        return edit(who, macro, null, "changed step " + n + " of " + macro, t -> MacroSource.setStep(t, macro, n, step));
    }

    public synchronized Done addStep(String who, String macro, String step) throws EditException {
        return edit(who, macro, null, "added a step to " + macro, t -> MacroSource.addStep(t, macro, step));
    }

    public synchronized Done insertStep(String who, String macro, int n, String step) throws EditException {
        return edit(who, macro, null, "added step " + n + " to " + macro, t -> MacroSource.insertStep(t, macro, n, step));
    }

    public synchronized Done removeStep(String who, String macro, int n) throws EditException {
        return edit(who, macro, null, "removed step " + n + " of " + macro, t -> MacroSource.removeStep(t, macro, n));
    }

    public synchronized Done moveStep(String who, String macro, int from, int to) throws EditException {
        return edit(who, macro, null, "moved step " + from + " of " + macro + " to " + to,
                t -> MacroSource.moveStep(t, macro, from, to));
    }

    // --- the header and description ---

    /** {@code header} is the name and parameters; a new name renames the macro. */
    public synchronized Done setHeader(String who, String macro, String header) throws EditException {
        List<String> tokens = Args.tokenize(header.strip().startsWith("macro ") ? header.strip().substring(6) : header);
        if (tokens.isEmpty()) {
            throw new EditException("A macro needs a name");
        }
        String name = tokens.get(0);
        return edit(who, macro, name, name.equals(macro) ? "changed the parameters of " + macro
                : "renamed " + macro + " to " + name, t -> MacroSource.setHeader(t, macro, header));
    }

    public synchronized Done describe(String who, String macro, String description) throws EditException {
        List<String> lines = description.isBlank() ? List.of() : List.of(description.split("\\s*\\|\\s*"));
        return edit(who, macro, null, "described " + macro, t -> MacroSource.setDescription(t, macro, lines));
    }

    /** Swaps the macro's whole text for {@code block} (from a book); the block may rename it. */
    public synchronized Done replace(String who, String macro, String block) throws EditException {
        MacroParser.Result parsed = MacroParser.parse("book", block);
        if (parsed.macros().size() != 1) {
            Problem first = parsed.problems().isEmpty() ? null : parsed.problems().get(0);
            throw new EditException(first == null ? "The book must hold one macro" : "Line " + first.line()
                    + " of the book: " + first.message());
        }
        String name = parsed.macros().get(0).name();
        return edit(who, macro, name, "rewrote " + macro, t -> MacroSource.replace(t, macro, block));
    }

    // --- whole macros ---

    /** A new, empty macro; {@code header} is its name and parameters. */
    public synchronized Done create(String who, String header, String description) throws EditException {
        List<String> tokens = Args.tokenize(header);
        if (tokens.isEmpty()) {
            throw new EditException("A macro needs a name: /macro new <name> [params]");
        }
        String name = tokens.get(0);
        if (library.get(name) != null) {
            throw new EditException("There's already a macro named " + library.get(name).name());
        }
        Path file = library.fileForNew(name);
        if (file == null) {
            throw new EditException("No macro folder is set (MCTEST_MACROS)");
        }
        String before = read(file);
        String after = MacroSource.append(before, MacroSource.newMacro(header, description));
        List<Problem> warnings = check(after, name, before, label(file));
        write(file, after);
        remember(who, new Undo(file, before, after, "created " + name, name));
        return new Done(name, "created " + name + " in " + label(file), warnings);
    }

    public synchronized Done copy(String who, String macro, String copy) throws EditException {
        if (copy.equalsIgnoreCase(macro) || library.get(copy) != null) {
            throw new EditException("There's already a macro named " + copy);
        }
        return edit(who, macro, copy, false, "copied " + macro + " to " + copy, t -> MacroSource.copy(t, macro, copy));
    }

    public synchronized Done delete(String who, String macro) throws EditException {
        Macro m = library.get(macro);
        if (m == null) {
            throw new EditException("No macro named " + macro);
        }
        Path file = path(m.name());
        String before = read(file);
        String after = MacroSource.remove(before, m.name());
        write(file, after);
        remember(who, new Undo(file, before, after, "deleted " + m.name(), m.name()));
        layout.forget(m.name());
        return new Done(m.name(), "deleted " + m.name() + " from " + label(file), List.of());
    }

    // --- undo ---

    /** What {@link #undo} would put back, or null. */
    public synchronized String undoable(String who) {
        Deque<Undo> d = undo.get(who);
        return d == null || d.isEmpty() ? null : d.peek().what();
    }

    public synchronized Done undo(String who) throws EditException {
        Deque<Undo> d = undo.get(who);
        if (d == null || d.isEmpty()) {
            throw new EditException("Nothing to undo");
        }
        Undo u = d.peek();
        String now = read(u.file());
        if (!now.equals(u.after())) {
            d.clear();
            throw new EditException(label(u.file()) + " changed since you " + u.what() + "; undoing would lose that");
        }
        d.pop();
        write(u.file(), u.before());
        return new Done(u.macro(), "undid: " + u.what(), List.of());
    }

    // --- plumbing ---

    private Done edit(String who, String macro, String newName, String what, Change change) throws EditException {
        return edit(who, macro, newName, true, what, change);
    }

    /** @param renames whether {@code newName} replaces the macro (a rename) rather than joining it (a copy). */
    private Done edit(String who, String macro, String newName, boolean renames, String what, Change change)
            throws EditException {
        Macro m = library.get(macro);
        if (m == null) {
            throw new EditException("No macro named " + macro);
        }
        String name = newName == null ? m.name() : newName;
        if (!name.equalsIgnoreCase(m.name()) && library.get(name) != null) {
            throw new EditException("There's already a macro named " + library.get(name).name());
        }
        Path file = path(m.name());
        String before = read(file);
        String after = change.apply(before);
        List<Problem> warnings = check(after, name, before, label(file));
        write(file, after);
        remember(who, new Undo(file, before, after, what, name));
        if (renames && !name.equals(m.name())) {
            layout.rename(m.name(), name);
        }
        return new Done(name, what, warnings);
    }

    /**
     * Refuses text that gives the macro a parse error it didn't have before (a broken line can still be fixed
     * one edit at a time), and returns the warnings it has.
     */
    private static List<Problem> check(String after, String name, String before, String label) throws EditException {
        int[] range = MacroSource.lineRange(after, name);
        List<String> old = new ArrayList<>();
        try {
            int[] was = MacroSource.lineRange(before, name);
            for (Problem p : MacroParser.parse(label, before).problems()) {
                if (p.isError() && p.line() >= was[0] && p.line() <= was[1]) {
                    old.add(p.message());
                }
            }
        } catch (EditException e) {
            // A new name: the macro wasn't there before, so every error is new.
        }
        List<Problem> warnings = new ArrayList<>();
        for (Problem p : MacroParser.parse(label, after).problems()) {
            if (p.line() < range[0] || p.line() > range[1]) {
                continue;
            }
            if (!p.isError()) {
                warnings.add(p);
            } else if (!old.remove(p.message())) {
                throw new EditException(p.message() + " (" + label + ":" + p.line() + ")");
            }
        }
        return warnings;
    }

    private Path path(String macro) throws EditException {
        Path file = library.path(macro);
        if (file == null) {
            throw new EditException("Can't tell which file " + macro + " is in");
        }
        return file;
    }

    private String label(Path file) {
        for (Path folder : library.folders()) {
            if (file.startsWith(folder)) {
                return folder.relativize(file).toString().replace('\\', '/');
            }
        }
        return file.getFileName().toString();
    }

    private void remember(String who, Undo u) {
        Deque<Undo> d = undo.computeIfAbsent(who, k -> new ArrayDeque<>());
        d.push(u);
        while (d.size() > UNDO) {
            d.removeLast();
        }
    }

    private static String read(Path file) throws EditException {
        try {
            return Files.exists(file) ? Files.readString(file, StandardCharsets.UTF_8) : "";
        } catch (IOException e) {
            throw new EditException("Can't read " + file + ": " + e.getMessage());
        }
    }

    private void write(Path file, String text) throws EditException {
        try {
            Files.createDirectories(file.getParent());
            Files.writeString(file, text, StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new EditException("Can't write " + file + ": " + e.getMessage());
        }
        library.reload();
    }
}
