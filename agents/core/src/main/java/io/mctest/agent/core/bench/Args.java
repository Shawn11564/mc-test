package io.mctest.agent.core.bench;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Macro arguments: splitting what was typed after the macro name, binding it to the macro's parameters,
 * and substituting {@code {param}} into its lines (docs/MACROS.md §3).
 *
 * <p>Values can be positional ({@code /m expedition.take Carol}) or named ({@code n=2}), in any mix: named
 * ones are taken first, then the positional ones fill the remaining parameters in order. That's what makes
 * "the same thing, but for Carol" one short line.
 */
public final class Args {

    /** Names every macro can use without declaring them. {@code me}: whoever started the macro. */
    public static final List<String> BUILT_INS = List.of("me");

    private static final Pattern IDENT = Pattern.compile("[A-Za-z_][A-Za-z0-9_]*");
    private static final Pattern PLACEHOLDER = Pattern.compile("\\{([A-Za-z_][A-Za-z0-9_]*)}");
    private static final Pattern DURATION = Pattern.compile("(\\d+(?:\\.\\d+)?)(t|s|m|h)?",
            Pattern.CASE_INSENSITIVE);

    private Args() {
    }

    /** Why the arguments don't fit the macro; the message is shown as is. */
    public static final class BindException extends Exception {
        public BindException(String message) {
            super(message);
        }
    }

    public static boolean isIdent(String s) {
        return IDENT.matcher(s).matches();
    }

    /**
     * Splits on whitespace, keeping {@code "double quoted"} text together (quotes removed, {@code \"} for a
     * quote inside). An unclosed quote runs to the end, which is the forgiving reading of a typed line.
     */
    public static List<String> tokenize(String text) {
        List<String> out = new ArrayList<>();
        StringBuilder current = new StringBuilder();
        boolean inQuotes = false;
        boolean any = false;
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (inQuotes) {
                if (c == '\\' && i + 1 < text.length() && text.charAt(i + 1) == '"') {
                    current.append('"');
                    i++;
                } else if (c == '"') {
                    inQuotes = false;
                } else {
                    current.append(c);
                }
            } else if (c == '"') {
                inQuotes = true;
                any = true;
            } else if (Character.isWhitespace(c)) {
                if (any) {
                    out.add(current.toString());
                    current.setLength(0);
                    any = false;
                }
            } else {
                current.append(c);
                any = true;
            }
        }
        if (any) {
            out.add(current.toString());
        }
        return out;
    }

    /**
     * Binds typed arguments to {@code macro}'s parameters. Defaults may name other parameters or built-ins
     * ({@code who2={who}}), substituted after binding.
     *
     * @param builtIns values for {@link #BUILT_INS}; they can't be passed as arguments.
     * @return every parameter's value plus the built-ins, in declaration order.
     */
    public static Map<String, String> bind(Macro macro, List<String> tokens, Map<String, String> builtIns)
            throws BindException {
        Map<String, String> named = new LinkedHashMap<>();
        List<String> positional = new ArrayList<>();
        for (String token : tokens) {
            int eq = token.indexOf('=');
            String key = eq > 0 ? token.substring(0, eq) : null;
            if (key != null && isIdent(key)) {
                if (macro.param(key) == null) {
                    throw new BindException("'" + key + "' isn't a parameter of " + macro.name()
                            + " — usage: " + macro.usage());
                }
                if (named.put(key, token.substring(eq + 1)) != null) {
                    throw new BindException(key + " is given twice");
                }
            } else {
                positional.add(token);
            }
        }
        Map<String, String> values = new LinkedHashMap<>();
        int next = 0;
        List<String> missing = new ArrayList<>();
        for (Macro.Param p : macro.params()) {
            if (named.containsKey(p.name())) {
                values.put(p.name(), named.get(p.name()));
            } else if (next < positional.size()) {
                values.put(p.name(), positional.get(next++));
            } else if (!p.required()) {
                values.put(p.name(), null); // filled from the default below
            } else {
                missing.add(p.name());
            }
        }
        if (!missing.isEmpty()) {
            throw new BindException("missing " + String.join(", ", missing) + " — usage: " + macro.usage());
        }
        if (next < positional.size()) {
            throw new BindException("too many values (" + String.join(" ", positional.subList(next,
                    positional.size())) + ") — usage: " + macro.usage());
        }
        Map<String, String> scope = new LinkedHashMap<>(builtIns);
        for (Map.Entry<String, String> e : values.entrySet()) {
            if (e.getValue() != null) {
                scope.put(e.getKey(), e.getValue());
            }
        }
        for (Macro.Param p : macro.params()) {
            if (values.get(p.name()) == null) {
                String value = substitute(p.defaultValue(), scope);
                values.put(p.name(), value);
                scope.put(p.name(), value);
            }
        }
        Map<String, String> out = new LinkedHashMap<>(values);
        out.putAll(builtIns);
        return out;
    }

    /**
     * The arguments for {@code /macro again}: the last run's values, with whatever was typed now on top. Named
     * values replace theirs; positional ones replace the parameters in order, skipping any named now. So after
     * {@code /m expedition.take Carol n=2}, {@code /macro again Dave} takes #2 as Dave.
     *
     * @return tokens for {@link #bind}.
     */
    public static List<String> rebind(Macro macro, Map<String, String> previous, List<String> tokens)
            throws BindException {
        Map<String, String> merged = new LinkedHashMap<>();
        for (Macro.Param p : macro.params()) {
            if (previous.containsKey(p.name())) {
                merged.put(p.name(), previous.get(p.name()));
            }
        }
        List<String> positional = new ArrayList<>();
        List<String> namedNow = new ArrayList<>();
        for (String token : tokens) {
            int eq = token.indexOf('=');
            String key = eq > 0 ? token.substring(0, eq) : null;
            if (key != null && isIdent(key)) {
                if (macro.param(key) == null) {
                    throw new BindException("'" + key + "' isn't a parameter of " + macro.name()
                            + " — usage: " + macro.usage());
                }
                merged.put(key, token.substring(eq + 1));
                namedNow.add(key);
            } else {
                positional.add(token);
            }
        }
        int next = 0;
        for (Macro.Param p : macro.params()) {
            if (next < positional.size() && !namedNow.contains(p.name())) {
                merged.put(p.name(), positional.get(next++));
            }
        }
        if (next < positional.size()) {
            throw new BindException("too many values — usage: " + macro.usage());
        }
        List<String> out = new ArrayList<>();
        for (Map.Entry<String, String> e : merged.entrySet()) {
            out.add(e.getKey() + "=" + e.getValue());
        }
        return out;
    }

    /**
     * Replaces each {@code {name}} that {@code vars} knows. Anything else in braces is left alone, so a
     * command's own JSON or SNBT ({@code {"text":"hi"}}, {@code [custom_data={a:1}]}) passes through.
     */
    public static String substitute(String text, Map<String, String> vars) {
        Matcher m = PLACEHOLDER.matcher(text);
        StringBuilder out = new StringBuilder();
        while (m.find()) {
            String value = vars.get(m.group(1));
            m.appendReplacement(out, Matcher.quoteReplacement(value != null ? value : m.group()));
        }
        m.appendTail(out);
        return out.toString();
    }

    /** The {@code {name}} placeholders in {@code text}, in order. */
    public static List<String> placeholders(String text) {
        List<String> out = new ArrayList<>();
        Matcher m = PLACEHOLDER.matcher(text);
        while (m.find()) {
            out.add(m.group(1));
        }
        return out;
    }

    /**
     * A duration in game ticks: {@code 40t}, {@code 10s}, {@code 1.5s}, {@code 2m}, {@code 1h}; a bare
     * number is seconds, since that's how the test guides speak.
     *
     * @return the ticks, or -1 when it isn't a duration.
     */
    public static int ticks(String text) {
        Matcher m = DURATION.matcher(text.trim());
        if (!m.matches()) {
            return -1;
        }
        double amount = Double.parseDouble(m.group(1));
        String unit = m.group(2) == null ? "s" : m.group(2).toLowerCase(Locale.ROOT);
        double perUnit = switch (unit) {
            case "t" -> 1;
            case "m" -> 20 * 60;
            case "h" -> 20 * 60 * 60;
            default -> 20;
        };
        return (int) Math.round(amount * perUnit);
    }

    /** {@code 200} ticks → {@code 10s}, for messages. */
    public static String describeTicks(int ticks) {
        if (ticks % 20 != 0) {
            return ticks + "t";
        }
        int seconds = ticks / 20;
        if (seconds >= 60 && seconds % 60 == 0) {
            return seconds / 60 + "m";
        }
        return seconds + "s";
    }
}
