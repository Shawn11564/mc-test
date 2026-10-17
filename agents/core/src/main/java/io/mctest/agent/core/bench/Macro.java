package io.mctest.agent.core.bench;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * One saved command group from a {@code .macro} file (docs/MACROS.md): a name, its parameters, the
 * comment lines that describe it, and its steps. Built by {@link MacroParser}; immutable.
 */
public final class Macro {

    /** A parameter; {@code defaultValue} is null when the caller must give it. */
    public record Param(String name, String defaultValue) {
        public boolean required() {
            return defaultValue == null;
        }
    }

    /** One line of a macro body. {@code line} is its line number in the file, for error messages. */
    public sealed interface Step permits Command, Wait, WaitFor, Run, Say, Pause {
        int line();
    }

    /**
     * {@code /command}, run as whoever started the macro. {@code -/command} keeps going if it fails;
     * {@code +/command} runs in the same tick as the step before it (for a move that must not be seen half done).
     */
    public record Command(String text, boolean ignoreFailure, boolean sameTick, int line) implements Step {
    }

    /** {@code wait <duration>}. */
    public record Wait(int ticks, String shown, int line) implements Step {
    }

    /**
     * {@code waitfor <who> told <text>} (blocks, and stops the macro when it times out) or
     * {@code expect <who> [not] told <text>} (a check: reports pass or fail and carries on). {@code {=name}} in
     * the text captures one word of the message into {@code {name}} for the steps after it.
     */
    public record WaitFor(String who, String text, int ticks, boolean expect, boolean negate, int line)
            implements Step {
    }

    /** {@code run <macro> [args]}: another macro, with its arguments as written (substituted when run). */
    public record Run(String macro, String args, int line) implements Step {
    }

    /** {@code say <text>}: a note to whoever runs the macro, e.g. a step only a human can do. */
    public record Say(String text, int line) implements Step {
    }

    /** {@code pause [text]}: waits for {@code /macro continue}. */
    public record Pause(String text, int line) implements Step {
    }

    private final String name;
    private final List<Param> params;
    private final List<String> description;
    private final List<Step> steps;
    private final String file;
    private final int line;

    public Macro(String name, List<Param> params, List<String> description, List<Step> steps, String file,
            int line) {
        this.name = name;
        this.params = Collections.unmodifiableList(new ArrayList<>(params));
        this.description = Collections.unmodifiableList(new ArrayList<>(description));
        this.steps = Collections.unmodifiableList(new ArrayList<>(steps));
        this.file = file;
        this.line = line;
    }

    public String name() {
        return name;
    }

    public List<Param> params() {
        return params;
    }

    public List<String> description() {
        return description;
    }

    public List<Step> steps() {
        return steps;
    }

    /** The file it came from, as the library names it (relative to its macro folder). */
    public String file() {
        return file;
    }

    public int line() {
        return line;
    }

    public Param param(String name) {
        for (Param p : params) {
            if (p.name().equals(name)) {
                return p;
            }
        }
        return null;
    }

    /** {@code expedition.take <who> [bank=Capital] [n=1]}: how to call it. */
    public String usage() {
        StringBuilder out = new StringBuilder(name);
        for (Param p : params) {
            out.append(' ');
            if (p.required()) {
                out.append('<').append(p.name()).append('>');
            } else {
                String value = p.defaultValue();
                if (value.isEmpty() || value.contains(" ")) {
                    value = '"' + value + '"';
                }
                out.append('[').append(p.name()).append('=').append(value).append(']');
            }
        }
        return out.toString();
    }
}
