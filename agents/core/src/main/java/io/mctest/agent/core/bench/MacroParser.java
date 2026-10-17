package io.mctest.agent.core.bench;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Reads {@code .macro} files (docs/MACROS.md §2). The format is deliberately line-based: a macro body is the
 * commands you would type, so one copied from a test guide or recorded in game needs no escaping, and the
 * agent needs no YAML library (none ships with every loader).
 *
 * <pre>
 * macro expedition.take who bank=Capital n=1
 *   # Takes expedition #{n} at {bank} as {who}, through the bank menu.
 *   /actor {who} cmd mapfactions bank menu {bank}
 *   /actor {who} click Expeditions
 *   /actor {who} click Expedition #{n}
 *   expect {who} told "You joined"
 * end
 * </pre>
 */
public final class MacroParser {

    /** How long {@code waitfor} waits by default before it stops the macro. */
    public static final int DEFAULT_WAITFOR_TICKS = 30 * 20;
    /** How long {@code expect} gives a message to arrive by default. */
    public static final int DEFAULT_EXPECT_TICKS = 5 * 20;

    private MacroParser() {
    }

    public record Result(List<Macro> macros, List<Problem> problems) {
    }

    public static Result parse(String file, String text) {
        List<Macro> macros = new ArrayList<>();
        List<Problem> problems = new ArrayList<>();
        String[] lines = text.split("\r?\n", -1);

        String name = null;
        int start = 0;
        List<Macro.Param> params = null;
        List<String> description = null;
        List<Macro.Step> steps = null;

        for (int i = 0; i < lines.length; i++) {
            int lineNo = i + 1;
            String line = lines[i].strip();
            if (line.isEmpty()) {
                continue;
            }
            if (line.startsWith("#")) {
                // Comment lines before the first step describe the macro.
                if (name != null && steps.isEmpty()) {
                    description.add(line.replaceFirst("^#+\\s?", ""));
                }
                continue;
            }
            String keyword = firstWord(line);
            if (name == null) {
                if (!keyword.equals("macro")) {
                    problems.add(Problem.error(file, lineNo, "expected 'macro <name> [params]', found: " + line));
                    continue;
                }
                List<String> header = Args.tokenize(line);
                if (header.size() < 2) {
                    problems.add(Problem.error(file, lineNo, "a macro needs a name: macro <name> [params]"));
                    continue;
                }
                name = header.get(1);
                start = lineNo;
                params = parseParams(file, lineNo, name, header.subList(2, header.size()), problems);
                description = new ArrayList<>();
                steps = new ArrayList<>();
                if (name.contains("=") || name.startsWith("/")) {
                    problems.add(Problem.error(file, lineNo, "bad macro name: " + name));
                }
                continue;
            }
            if (keyword.equals("end") && line.equals("end")) {
                Macro macro = new Macro(name, params, description, steps, file, start);
                checkPlaceholders(macro, problems);
                macros.add(macro);
                name = null;
                continue;
            }
            if (keyword.equals("macro")) {
                problems.add(Problem.error(file, lineNo, "macro " + name + " (line " + start
                        + ") has no 'end' before the next macro"));
                name = null;
                i--; // read this header again as the start of the next macro
                continue;
            }
            Macro.Step step = parseStep(file, lineNo, line, problems);
            if (step != null) {
                steps.add(step);
            }
        }
        if (name != null) {
            problems.add(Problem.error(file, start, "macro " + name + " has no 'end'"));
        }
        return new Result(macros, problems);
    }

    /** One body line on its own, for the menu's step icons: the step, or null with the reason in {@code problems}. */
    public static Macro.Step step(String line, List<Problem> problems) {
        return parseStep("", 0, line.strip(), problems);
    }

    private static List<Macro.Param> parseParams(String file, int lineNo, String macro, List<String> tokens,
            List<Problem> problems) {
        List<Macro.Param> params = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (String token : tokens) {
            int eq = token.indexOf('=');
            String pname = eq < 0 ? token : token.substring(0, eq);
            String value = eq < 0 ? null : token.substring(eq + 1);
            if (!Args.isIdent(pname)) {
                problems.add(Problem.error(file, lineNo, "bad parameter name '" + pname + "' in " + macro
                        + " (letters, digits and _ only)"));
                continue;
            }
            if (Args.BUILT_INS.contains(pname)) {
                problems.add(Problem.error(file, lineNo, "{" + pname + "} is built in; pick another parameter name"));
                continue;
            }
            if (!seen.add(pname)) {
                problems.add(Problem.error(file, lineNo, "parameter " + pname + " is declared twice"));
                continue;
            }
            params.add(new Macro.Param(pname, value));
        }
        return params;
    }

    private static Macro.Step parseStep(String file, int lineNo, String line, List<Problem> problems) {
        boolean sameTick = line.startsWith("+");
        String command = sameTick ? line.substring(1) : line;
        if (command.startsWith("/")) {
            return new Macro.Command(command, false, sameTick, lineNo);
        }
        if (command.startsWith("-/")) {
            return new Macro.Command(command.substring(1), true, sameTick, lineNo);
        }
        if (sameTick) {
            problems.add(Problem.error(file, lineNo, "+ goes before a command: +/command"));
            return null;
        }
        String keyword = firstWord(line).toLowerCase(Locale.ROOT);
        String rest = line.substring(firstWord(line).length()).strip();
        switch (keyword) {
            case "wait": {
                int ticks = Args.ticks(rest);
                if (ticks < 0) {
                    problems.add(Problem.error(file, lineNo, "wait needs a duration like 10s, 2m or 40t"));
                    return null;
                }
                return new Macro.Wait(ticks, rest, lineNo);
            }
            case "waitfor":
            case "expect":
                return parseWaitFor(file, lineNo, keyword.equals("expect"), rest, problems);
            case "run": {
                List<String> tokens = Args.tokenize(rest);
                if (tokens.isEmpty()) {
                    problems.add(Problem.error(file, lineNo, "run needs a macro name"));
                    return null;
                }
                String args = rest.substring(rest.indexOf(tokens.get(0)) + tokens.get(0).length()).strip();
                return new Macro.Run(tokens.get(0), args, lineNo);
            }
            case "say":
                return new Macro.Say(rest, lineNo);
            case "pause":
                return new Macro.Pause(rest, lineNo);
            default:
                problems.add(Problem.error(file, lineNo, "not a step: " + line
                        + " (commands start with /; steps are wait, waitfor, expect, run, say, pause)"));
                return null;
        }
    }

    /** {@code <who> [not] told <text> [within|timeout <duration>]}. */
    private static Macro.Step parseWaitFor(String file, int lineNo, boolean expect, String rest,
            List<Problem> problems) {
        String verb = expect ? "expect" : "waitfor";
        List<String> tokens = new ArrayList<>(Args.tokenize(rest));
        String shape = verb + " <who> " + (expect ? "[not] " : "") + "told \"<text>\" ["
                + (expect ? "within" : "timeout") + " <duration>]";
        if (tokens.size() < 3) {
            problems.add(Problem.error(file, lineNo, "expected: " + shape));
            return null;
        }
        String who = tokens.remove(0);
        boolean negate = false;
        if (expect && tokens.get(0).equalsIgnoreCase("not")) {
            negate = true;
            tokens.remove(0);
        }
        if (tokens.isEmpty() || !tokens.get(0).equalsIgnoreCase("told")) {
            problems.add(Problem.error(file, lineNo, "expected: " + shape));
            return null;
        }
        tokens.remove(0);
        int ticks = expect ? DEFAULT_EXPECT_TICKS : DEFAULT_WAITFOR_TICKS;
        int n = tokens.size();
        if (n >= 3 && (tokens.get(n - 2).equalsIgnoreCase("within") || tokens.get(n - 2).equalsIgnoreCase("timeout"))
                && Args.ticks(tokens.get(n - 1)) >= 0) {
            ticks = Args.ticks(tokens.get(n - 1));
            tokens = tokens.subList(0, n - 2);
        }
        String text = String.join(" ", tokens);
        if (text.isBlank()) {
            problems.add(Problem.error(file, lineNo, "expected: " + shape));
            return null;
        }
        return new Macro.WaitFor(who, text, ticks, expect, negate, lineNo);
    }

    /** A {@code {name}} that isn't a parameter is most likely a typo; it would be sent as typed. */
    private static void checkPlaceholders(Macro macro, List<Problem> problems) {
        Set<String> captured = new HashSet<>();
        for (Macro.Step step : macro.steps()) {
            for (String text : texts(step)) {
                for (String ph : Args.placeholders(text)) {
                    if (macro.param(ph) == null && !Args.BUILT_INS.contains(ph) && !captured.contains(ph)) {
                        problems.add(Problem.warning(macro.file(), step.line(), "{" + ph + "} isn't a parameter of "
                                + macro.name() + ", so it's sent as typed"));
                    }
                }
            }
            if (step instanceof Macro.WaitFor w) {
                captured.addAll(ToldLog.captures(w.text()));
            }
        }
    }

    static List<String> texts(Macro.Step step) {
        if (step instanceof Macro.Command c) {
            return List.of(c.text());
        } else if (step instanceof Macro.WaitFor w) {
            return List.of(w.who(), w.text());
        } else if (step instanceof Macro.Run r) {
            return List.of(r.args());
        } else if (step instanceof Macro.Say s) {
            return List.of(s.text());
        } else if (step instanceof Macro.Pause p) {
            return List.of(p.text());
        }
        return List.of();
    }

    private static String firstWord(String line) {
        int space = 0;
        while (space < line.length() && !Character.isWhitespace(line.charAt(space))) {
            space++;
        }
        return line.substring(0, space);
    }
}
