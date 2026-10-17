package io.mctest.agent.core.bench;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Edits one macro inside a {@code .macro} file's text and leaves everything around it as it was: the other
 * macros, comments, blank lines and indentation (docs/MACROS.md §8). Pure text in, text out; {@link MacroEditor}
 * does the files.
 *
 * <p>Steps are numbered from 1 in file order, counting every body line that isn't blank or a comment, so the
 * numbers match what the menu shows even for a line that doesn't parse.
 */
public final class MacroSource {

    /** Why an edit can't be made, in words for the person who asked. */
    public static final class EditException extends Exception {
        public EditException(String message) {
            super(message);
        }
    }

    /** Book pages hold about this many characters on a line, and this many lines. */
    static final int BOOK_LINE = 18;
    static final int BOOK_LINES = 13;

    private MacroSource() {
    }

    /** Where one macro sits: the line indexes of its header and its {@code end}. */
    private record Block(int header, int end) {
    }

    private static final class Text {
        final List<String> lines;
        final String newline;

        Text(String text) {
            newline = text.contains("\r\n") ? "\r\n" : "\n";
            lines = new ArrayList<>(List.of(text.split("\r?\n", -1)));
        }

        @Override
        public String toString() {
            return String.join(newline, lines);
        }
    }

    // --- reading ---

    /** The macro's step lines, as written (without indentation). */
    public static List<String> steps(String text, String name) throws EditException {
        Text t = new Text(text);
        List<String> out = new ArrayList<>();
        for (int i : stepLines(t, find(t, name))) {
            out.add(t.lines.get(i).strip());
        }
        return out;
    }

    /** The macro's header line after {@code macro}: its name and parameters as written. */
    public static String header(String text, String name) throws EditException {
        Text t = new Text(text);
        return t.lines.get(find(t, name).header).strip().substring("macro".length()).strip();
    }

    /** The macro's whole text, header to {@code end}. */
    public static String block(String text, String name) throws EditException {
        Text t = new Text(text);
        Block b = find(t, name);
        return String.join("\n", t.lines.subList(b.header, b.end + 1));
    }

    /** The 1-based line range of the macro in the file, for matching problems to it. */
    public static int[] lineRange(String text, String name) throws EditException {
        Text t = new Text(text);
        Block b = find(t, name);
        return new int[] {b.header + 1, b.end + 1};
    }

    // --- steps ---

    public static String setStep(String text, String name, int n, String step) throws EditException {
        Text t = new Text(text);
        Block b = find(t, name);
        List<Integer> steps = stepLines(t, b);
        int at = steps.get(index(n, steps.size(), name));
        t.lines.set(at, indentOf(t.lines.get(at)) + checkStep(step));
        return t.toString();
    }

    /** Puts {@code step} before step {@code n}; {@code n} one past the last step adds it at the end. */
    public static String insertStep(String text, String name, int n, String step) throws EditException {
        Text t = new Text(text);
        Block b = find(t, name);
        List<Integer> steps = stepLines(t, b);
        if (n < 1 || n > steps.size() + 1) {
            throw new EditException(name + " has " + steps.size() + " steps; a new one goes at 1 to " + (steps.size() + 1));
        }
        String line = indent(t, b) + checkStep(step);
        t.lines.add(lineBefore(t, b, steps, n), line);
        return t.toString();
    }

    public static String addStep(String text, String name, String step) throws EditException {
        Text t = new Text(text);
        return insertStep(text, name, stepLines(t, find(t, name)).size() + 1, step);
    }

    public static String removeStep(String text, String name, int n) throws EditException {
        Text t = new Text(text);
        Block b = find(t, name);
        List<Integer> steps = stepLines(t, b);
        t.lines.remove((int) steps.get(index(n, steps.size(), name)));
        return t.toString();
    }

    /** Moves step {@code from} so it becomes step {@code to}. */
    public static String moveStep(String text, String name, int from, int to) throws EditException {
        Text t = new Text(text);
        Block b = find(t, name);
        List<Integer> steps = stepLines(t, b);
        String line = t.lines.remove((int) steps.get(index(from, steps.size(), name)));
        index(to, steps.size(), name);
        b = find(t, name);
        t.lines.add(lineBefore(t, b, stepLines(t, b), to), line);
        return t.toString();
    }

    // --- the header and description ---

    /** Replaces the header: {@code header} is the name then the parameters, e.g. {@code take who n=1}. */
    public static String setHeader(String text, String name, String header) throws EditException {
        Text t = new Text(text);
        Block b = find(t, name);
        String h = header.strip();
        if (h.startsWith("macro ")) {
            h = h.substring(6).strip();
        }
        if (h.isEmpty()) {
            throw new EditException("A macro needs a name");
        }
        t.lines.set(b.header, indentOf(t.lines.get(b.header)) + "macro " + h);
        return t.toString();
    }

    /** Replaces the description (the comment lines between the header and the first step). */
    public static String setDescription(String text, String name, List<String> description) throws EditException {
        Text t = new Text(text);
        Block b = find(t, name);
        String indent = indent(t, b);
        int i = b.header + 1;
        while (i < b.end && isDescription(t.lines.get(i))) {
            t.lines.remove(i);
            b = new Block(b.header, b.end - 1);
        }
        for (String d : description) {
            if (!d.isBlank()) {
                t.lines.add(i++, indent + "# " + d.strip());
            }
        }
        return t.toString();
    }

    // --- whole macros ---

    /** Takes the macro out, with one blank line next to it so no gap is left behind. */
    public static String remove(String text, String name) throws EditException {
        Text t = new Text(text);
        Block b = find(t, name);
        int from = b.header;
        int to = b.end + 1;
        if (to < t.lines.size() && t.lines.get(to).isBlank()) {
            to++;
        } else if (from > 0 && t.lines.get(from - 1).isBlank()) {
            from--;
        }
        t.lines.subList(from, to).clear();
        return t.toString();
    }

    /** A copy of the macro named {@code copy}, put right after it. */
    public static String copy(String text, String name, String copy) throws EditException {
        Text t = new Text(text);
        Block b = find(t, name);
        List<String> lines = new ArrayList<>(t.lines.subList(b.header, b.end + 1));
        List<String> header = Args.tokenize(lines.get(0).strip());
        String rest = lines.get(0).strip().substring("macro".length()).strip();
        rest = rest.substring(header.get(1).length());
        lines.set(0, indentOf(lines.get(0)) + "macro " + copy + rest);
        lines.add(0, "");
        t.lines.addAll(b.end + 1, lines);
        return t.toString();
    }

    /** Swaps the macro's whole text for {@code replacement} (a {@code macro … end} block). */
    public static String replace(String text, String name, String replacement) throws EditException {
        Text t = new Text(text);
        Block b = find(t, name);
        t.lines.subList(b.header, b.end + 1).clear();
        t.lines.addAll(b.header, List.of(replacement.strip().split("\r?\n", -1)));
        return t.toString();
    }

    /** Adds a macro at the end of a file's text (empty for a new file). */
    public static String append(String text, String block) {
        String body = block.strip() + "\n";
        if (text.isBlank()) {
            return body;
        }
        return text.endsWith("\n") ? text + "\n" + body : text + "\n\n" + body;
    }

    /** A new, empty macro: {@code header} is its name and parameters. */
    public static String newMacro(String header, String description) {
        StringBuilder out = new StringBuilder("macro ").append(header.strip()).append('\n');
        if (description != null && !description.isBlank()) {
            out.append("  # ").append(description.strip()).append('\n');
        }
        return out.append("end\n").toString();
    }

    // --- books ---

    /**
     * The macro laid out on book pages: no indentation (a page is narrow), whole lines per page, so the book
     * reads like the file. {@link #fromBook} turns the pages back into a block.
     */
    public static List<String> toBook(String block) {
        List<String> pages = new ArrayList<>();
        StringBuilder page = new StringBuilder();
        int used = 0;
        for (String raw : block.split("\r?\n")) {
            String line = raw.strip();
            int rows = Math.max(1, (line.length() + BOOK_LINE - 1) / BOOK_LINE);
            if (used > 0 && used + rows > BOOK_LINES) {
                pages.add(page.toString());
                page.setLength(0);
                used = 0;
            }
            if (used > 0) {
                page.append('\n');
            }
            page.append(line);
            used += rows;
        }
        if (page.length() > 0 || pages.isEmpty()) {
            pages.add(page.toString());
        }
        return pages;
    }

    /** Book pages back into a {@code macro … end} block, indented the usual way; a missing {@code end} is added. */
    public static String fromBook(List<String> pages) throws EditException {
        List<String> lines = new ArrayList<>();
        for (String page : pages) {
            for (String line : page.split("\r?\n")) {
                if (!line.isBlank()) {
                    lines.add(line.strip());
                }
            }
        }
        if (lines.isEmpty() || !lines.get(0).toLowerCase(Locale.ROOT).startsWith("macro ")) {
            throw new EditException("The book's first line must be the header: macro <name> [params]");
        }
        if (!lines.get(lines.size() - 1).equals("end")) {
            lines.add("end");
        }
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < lines.size(); i++) {
            String line = lines.get(i);
            if (i > 0 && i < lines.size() - 1 && (line.equals("end") || line.toLowerCase(Locale.ROOT).startsWith("macro "))) {
                throw new EditException("Line " + (i + 1) + " of the book: one macro per book (\"" + line + "\")");
            }
            out.append(i == 0 || i == lines.size() - 1 ? "" : "  ").append(line).append('\n');
        }
        return out.toString();
    }

    // --- plumbing ---

    private static Block find(Text t, String name) throws EditException {
        Block exact = null;
        Block loose = null;
        for (int i = 0; i < t.lines.size(); i++) {
            String line = t.lines.get(i).strip();
            if (!line.startsWith("macro ") && !line.startsWith("macro\t")) {
                continue;
            }
            List<String> header = Args.tokenize(line);
            if (header.size() < 2) {
                continue;
            }
            boolean same = header.get(1).equals(name);
            if (!same && !header.get(1).equalsIgnoreCase(name)) {
                continue;
            }
            int end = -1;
            for (int j = i + 1; j < t.lines.size(); j++) {
                String l = t.lines.get(j).strip();
                if (l.equals("end")) {
                    end = j;
                    break;
                }
                if (l.startsWith("macro ")) {
                    break;
                }
            }
            if (end < 0) {
                throw new EditException("macro " + header.get(1) + " (line " + (i + 1) + ") has no 'end'; fix the file first");
            }
            if (same) {
                exact = new Block(i, end);
                break;
            }
            if (loose == null) {
                loose = new Block(i, end);
            }
        }
        Block b = exact != null ? exact : loose;
        if (b == null) {
            throw new EditException("No macro named " + name + " in its file (edited elsewhere?)");
        }
        return b;
    }

    private static List<Integer> stepLines(Text t, Block b) {
        List<Integer> out = new ArrayList<>();
        for (int i = b.header + 1; i < b.end; i++) {
            String line = t.lines.get(i).strip();
            if (!line.isEmpty() && !line.startsWith("#")) {
                out.add(i);
            }
        }
        return out;
    }

    /** The line a new step {@code n} goes in front of. */
    private static int lineBefore(Text t, Block b, List<Integer> steps, int n) {
        if (n <= steps.size()) {
            return steps.get(n - 1);
        }
        if (!steps.isEmpty()) {
            return steps.get(steps.size() - 1) + 1;
        }
        int i = b.header + 1;
        while (i < b.end && isDescription(t.lines.get(i))) {
            i++;
        }
        return i;
    }

    private static boolean isDescription(String line) {
        return line.strip().startsWith("#");
    }

    private static int index(int n, int count, String name) throws EditException {
        if (n < 1 || n > count) {
            throw new EditException(count == 0 ? name + " has no steps" : name + " has steps 1 to " + count + ", not " + n);
        }
        return n - 1;
    }

    private static String checkStep(String step) throws EditException {
        String s = step.strip();
        if (s.isEmpty()) {
            throw new EditException("A step can't be empty");
        }
        if (s.contains("\n") || s.contains("\r")) {
            throw new EditException("A step is one line");
        }
        if (s.equals("end") || s.toLowerCase(Locale.ROOT).startsWith("macro ")) {
            throw new EditException("\"" + s + "\" would end the macro; it isn't a step");
        }
        return s;
    }

    /** The indentation the macro's body uses: its first indented body line's, else two spaces. */
    private static String indent(Text t, Block b) {
        for (int i = b.header + 1; i < b.end; i++) {
            String line = t.lines.get(i);
            if (!line.isBlank()) {
                return indentOf(line);
            }
        }
        return indentOf(t.lines.get(b.header)) + "  ";
    }

    private static String indentOf(String line) {
        int i = 0;
        while (i < line.length() && (line.charAt(i) == ' ' || line.charAt(i) == '\t')) {
            i++;
        }
        return line.substring(0, i);
    }
}
