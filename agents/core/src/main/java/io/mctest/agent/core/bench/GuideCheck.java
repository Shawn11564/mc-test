package io.mctest.agent.core.bench;

import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Checks a markdown test guide against its macros (docs/MACROS.md §7):
 *
 * <ul>
 *   <li>every macro call in it ({@code /m name args} in backticks or a code block) names a macro that exists,
 *       with arguments that fit, and no {@code <placeholder>} where a real name belongs;
 *   <li>no step tells the tester to do something "the same way", "as in 3.3" or "(step 2)" without spelling
 *       it out. A step that points back makes the tester reconstruct the commands for a new target by hand,
 *       which is the slow, error-prone part a macro call removes.
 * </ul>
 *
 * <p>A sentence that points back is fine when it also carries the command or macro call to run. A block can
 * opt out with {@code <!-- guide-check: ok -->}, for a pointer that's an explanation rather than an
 * instruction.
 *
 * <p>Run as {@code java -cp mc-test-agent-core.jar io.mctest.agent.core.bench.GuideCheck --macros <dir>
 * <guide.md>…}; exits 1 when it finds an error.
 */
public final class GuideCheck {

    /** Opts a paragraph or list item out of the back-reference check. */
    public static final String OK_MARKER = "<!-- guide-check: ok -->";

    private static final Pattern CODE_SPAN = Pattern.compile("`([^`]+)`");
    private static final Pattern CALL = Pattern.compile("^/?(?:m|macro run)\\s+(\\S+)(.*)$");
    private static final Pattern PLACEHOLDER = Pattern.compile("<[A-Za-z][^<>]*>");
    private static final Pattern BLOCK_START = Pattern.compile("^\\s*(?:#{1,6}\\s|\\d+\\.\\s|[-*+]\\s|\\|)");
    private static final Pattern SENTENCE_END = Pattern.compile("(?<=[.!?;])\\s+");

    /** Phrases that send the tester to another step instead of saying what to do. */
    private static final Pattern BACK_REFERENCE = Pattern.compile(String.join("|",
            "\\bthe same way\\b",
            "\\bsame as (?:before|above|earlier)\\b",
            "\\b(?:as|like) (?:before|above|earlier)\\b",
            "\\bthe same (?:steps?|commands?|recipe|setup)\\b",
            "\\b(?:repeat|redo|rerun|re-run)\\b",
            "\\bas in (?:§\\s?)?\\d",
            "\\b(?:do|from|redo|repeat) (?:§\\s?)?(?:\\d+(?:\\.\\d+)*\\s+)?steps?\\s+\\d",
            "\\(\\s*(?:§\\s?)?(?:\\d+(?:\\.\\d+)*\\s+)?steps?\\s+\\d[^)]*\\)",
            "\\b\\d+(?:\\.\\d+)*\\s+steps?\\s+\\d+(?:\\s*[–-]\\s*\\d+)?\\b"),
            Pattern.CASE_INSENSITIVE);

    private GuideCheck() {
    }

    public record Report(List<Problem> problems, int calls) {
        public long errors() {
            return problems.stream().filter(Problem::isError).count();
        }
    }

    public static Report check(String file, String text, MacroLibrary library) {
        List<Problem> problems = new ArrayList<>();
        int calls = 0;
        String[] lines = text.split("\r?\n", -1);
        Map<String, String> sampleBuiltIns = new HashMap<>();
        sampleBuiltIns.put("me", "Tester");

        boolean inFence = false;
        StringBuilder block = new StringBuilder();
        List<int[]> offsets = new ArrayList<>(); // {offset in block, line number}
        for (int i = 0; i <= lines.length; i++) {
            String line = i < lines.length ? lines[i] : "";
            int lineNo = i + 1;
            boolean fence = line.strip().startsWith("```");
            boolean ends = i == lines.length || fence || inFence || line.isBlank() || BLOCK_START.matcher(line).find();
            if (ends && block.length() > 0) {
                backReferences(file, block.toString(), offsets, problems);
                block.setLength(0);
                offsets.clear();
            }
            if (i == lines.length) {
                break;
            }
            if (fence) {
                inFence = !inFence;
                continue;
            }
            if (inFence) {
                calls += checkCall(file, lineNo, line.strip(), library, sampleBuiltIns, problems);
                continue;
            }
            Matcher span = CODE_SPAN.matcher(line);
            while (span.find()) {
                calls += checkCall(file, lineNo, span.group(1).strip(), library, sampleBuiltIns, problems);
            }
            if (!line.isBlank()) {
                offsets.add(new int[] {block.length(), lineNo});
                block.append(line.strip()).append(' ');
            }
        }
        return new Report(problems, calls);
    }

    /** @return 1 if {@code code} is a macro call (checked), else 0. */
    private static int checkCall(String file, int lineNo, String code, MacroLibrary library,
            Map<String, String> builtIns, List<Problem> problems) {
        Matcher m = CALL.matcher(code);
        if (!m.matches()) {
            return 0;
        }
        String name = m.group(1);
        Macro macro = library.all().get(name);
        if (macro == null) {
            problems.add(Problem.error(file, lineNo, "no macro named " + name + " (in `" + code + "`)"));
            return 1;
        }
        Matcher ph = PLACEHOLDER.matcher(m.group(2));
        if (ph.find()) {
            problems.add(Problem.error(file, lineNo, "`" + code + "` has a placeholder " + ph.group()
                    + "; name the actual player, place or value"));
            return 1;
        }
        try {
            Args.bind(macro, Args.tokenize(m.group(2)), builtIns);
        } catch (Args.BindException e) {
            problems.add(Problem.error(file, lineNo, "`" + code + "`: " + e.getMessage()));
        }
        return 1;
    }

    private static void backReferences(String file, String block, List<int[]> offsets, List<Problem> problems) {
        if (block.contains(OK_MARKER)) {
            return;
        }
        int start = 0;
        Matcher end = SENTENCE_END.matcher(block);
        List<int[]> sentences = new ArrayList<>();
        while (end.find()) {
            if (!insideCodeSpan(block, end.start())) {
                sentences.add(new int[] {start, end.start()});
                start = end.end();
            }
        }
        sentences.add(new int[] {start, block.length()});
        for (int[] s : sentences) {
            String sentence = block.substring(s[0], s[1]);
            Matcher ref = BACK_REFERENCE.matcher(sentence);
            while (ref.find()) {
                if (insideCodeSpan(sentence, ref.start())) {
                    continue;
                }
                if (!commandAfter(sentence, ref.end())) {
                    problems.add(Problem.error(file, lineAt(offsets, s[0] + ref.start()), "\"" + ref.group()
                            + "\" points back instead of saying what to do: write the commands for this target, or"
                            + " a macro call (/m …). Sentence: " + abbreviate(sentence.strip())));
                }
                break;
            }
        }
    }

    /**
     * Whether a command ({@code `/…`}) or macro call follows the pointer in its sentence, as in "re-ally the
     * factions (2.6 step 3): `/faction ally South`". One that comes before it is about something else.
     */
    private static boolean commandAfter(String sentence, int from) {
        Matcher span = CODE_SPAN.matcher(sentence);
        while (span.find()) {
            if (span.start() >= from && span.group(1).strip().startsWith("/")) {
                return true;
            }
        }
        return false;
    }

    private static boolean insideCodeSpan(String text, int index) {
        int ticks = 0;
        for (int i = 0; i < index; i++) {
            if (text.charAt(i) == '`') {
                ticks++;
            }
        }
        return ticks % 2 == 1;
    }

    private static int lineAt(List<int[]> offsets, int offset) {
        int line = offsets.isEmpty() ? 0 : offsets.get(0)[1];
        for (int[] o : offsets) {
            if (o[0] > offset) {
                break;
            }
            line = o[1];
        }
        return line;
    }

    private static String abbreviate(String s) {
        return s.length() <= 160 ? s : s.substring(0, 157) + "...";
    }

    public static void main(String[] args) throws IOException {
        // The guides are full of dashes and section signs; a Windows console's code page would mangle them.
        PrintStream out = new PrintStream(new FileOutputStream(FileDescriptor.out), true, StandardCharsets.UTF_8);
        List<Path> folders = new ArrayList<>();
        List<Path> guides = new ArrayList<>();
        for (int i = 0; i < args.length; i++) {
            if (args[i].equals("--macros") && i + 1 < args.length) {
                folders.add(Path.of(args[++i]));
            } else {
                guides.add(Path.of(args[i]));
            }
        }
        if (guides.isEmpty()) {
            System.err.println("usage: GuideCheck --macros <folder> [--macros <folder>…] <guide.md>…");
            System.exit(2);
        }
        MacroLibrary library = new MacroLibrary(folders);
        List<Problem> all = new ArrayList<>(library.problems());
        int calls = 0;
        for (Path guide : guides) {
            Report report = check(guide.toString().replace('\\', '/'),
                    Files.readString(guide, StandardCharsets.UTF_8), library);
            all.addAll(report.problems());
            calls += report.calls();
        }
        for (Problem p : all) {
            out.println(p);
        }
        long errors = all.stream().filter(Problem::isError).count();
        out.println(library.all().size() + " macros, " + calls + " macro calls checked, " + errors
                + " error(s), " + (all.size() - errors) + " warning(s)");
        if (errors > 0) {
            System.exit(1);
        }
    }
}
