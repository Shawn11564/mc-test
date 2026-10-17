package io.mctest.agent.core.bench;

import java.util.ArrayDeque;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * One running macro (docs/MACROS.md §5), advanced by the server tick. Game-free: the loader shim supplies a
 * {@link Host} that runs commands and shows lines to whoever started it, and feeds the {@link ToldLog}.
 *
 * <p>At most one command runs per tick, so whatever a command changes (an opened menu, a teleport) is in
 * place before the next one, as it would be for someone typing. A failed command stops the macro unless it
 * was written {@code -/command}: carrying on after a failed setup step would test the wrong state.
 */
public final class MacroRun {

    /** How deep {@code run} may nest, which stops a macro that calls itself. */
    public static final int MAX_DEPTH = 16;

    /** What kind of line the host is asked to show; the shim picks colours and buttons by it. */
    public enum Level { START, STEP, INFO, PASS, FAIL, PAUSE, DONE, STOPPED }

    public interface Host {
        /** Runs {@code command} as whoever started the macro: null if it worked, else why it didn't. */
        String runCommand(String command);

        void show(Level level, String text);
    }

    private record Frame(Macro macro, Map<String, String> vars, int[] pc) {
    }

    private final MacroLibrary library;
    private final Host host;
    private final ToldLog told;
    private final Map<String, String> builtIns;
    private final Deque<Frame> frames = new ArrayDeque<>();
    private final String title;

    private long waitUntil = -1;
    private Macro.WaitFor waitingFor;
    private Frame waitFrame;
    private String waitWho;
    private String waitText;
    private long waitDeadline;
    private boolean paused;
    private long mark;
    private int passed;
    private int failed;
    private boolean finished;

    /**
     * @param vars the bound arguments, from {@link Args#bind}.
     * @param builtIns the built-in values, passed on to nested macros.
     */
    public MacroRun(MacroLibrary library, Macro macro, Map<String, String> vars, Map<String, String> builtIns,
            Host host, ToldLog told) {
        this.library = library;
        this.host = host;
        this.told = told;
        this.builtIns = builtIns;
        this.frames.push(new Frame(macro, new LinkedHashMap<>(vars), new int[1]));
        this.mark = told.seq();
        this.title = describe(macro, vars);
        host.show(Level.START, title);
    }

    public String title() {
        return title;
    }

    public boolean finished() {
        return finished;
    }

    public boolean paused() {
        return paused;
    }

    public int passed() {
        return passed;
    }

    public int failed() {
        return failed;
    }

    /** {@code /macro continue}: false when it wasn't paused. */
    public boolean resume() {
        if (!paused) {
            return false;
        }
        paused = false;
        return true;
    }

    /** {@code /macro stop}. */
    public void stop() {
        if (!finished) {
            finish(Level.STOPPED, "stopped " + title);
        }
    }

    /**
     * Advances the macro as far as it can go this tick.
     *
     * @param now the server's tick count.
     * @return false once it has finished.
     */
    public boolean tick(long now) {
        while (!finished) {
            if (paused) {
                return true;
            }
            if (waitUntil >= 0) {
                if (now < waitUntil) {
                    return true;
                }
                waitUntil = -1;
            }
            if (waitingFor != null && !checkWait(now)) {
                return true;
            }
            if (finished) {
                break;
            }
            Frame frame = frames.peek();
            if (frame == null) {
                String checks = passed + failed == 0 ? "" : failed == 0
                        ? " — " + passed + "/" + passed + " checks passed"
                        : " — " + failed + " of " + (passed + failed) + " checks FAILED";
                finish(Level.DONE, "done " + title + checks);
                break;
            }
            List<Macro.Step> steps = frame.macro().steps();
            if (frame.pc()[0] >= steps.size()) {
                frames.pop();
                continue;
            }
            Macro.Step step = steps.get(frame.pc()[0]++);
            if (step instanceof Macro.Command c) {
                String command = Args.substitute(c.text(), frame.vars());
                host.show(Level.STEP, command);
                mark = told.seq();
                String error = host.runCommand(command);
                if (error != null && !c.ignoreFailure()) {
                    finish(Level.STOPPED, "stopped " + title + ": " + command + " failed — " + error
                            + where(frame, step));
                    return false;
                }
                int next = frame.pc()[0];
                if (next < steps.size() && steps.get(next) instanceof Macro.Command following && following.sameTick()) {
                    continue;
                }
                return true; // one command per tick
            } else if (step instanceof Macro.Wait w) {
                host.show(Level.INFO, "waiting " + w.shown());
                waitUntil = now + w.ticks();
            } else if (step instanceof Macro.WaitFor w) {
                waitingFor = w;
                waitFrame = frame;
                waitWho = Args.substitute(w.who(), frame.vars());
                waitText = Args.substitute(w.text(), frame.vars());
                waitDeadline = now + w.ticks();
                if (!w.expect()) {
                    host.show(Level.INFO, "waiting for " + waitWho + " to be told \"" + waitText + "\"");
                }
            } else if (step instanceof Macro.Run r) {
                startNested(frame, r);
            } else if (step instanceof Macro.Say s) {
                host.show(Level.INFO, Args.substitute(s.text(), frame.vars()));
            } else if (step instanceof Macro.Pause p) {
                String text = Args.substitute(p.text(), frame.vars());
                host.show(Level.PAUSE, text.isBlank() ? "paused" : text);
                paused = true;
            }
        }
        return false;
    }

    /** @return true when the wait is over and the macro can go on. */
    private boolean checkWait(long now) {
        Macro.WaitFor w = waitingFor;
        String hit;
        if (ToldLog.captures(waitText).isEmpty()) {
            hit = told.find(waitWho, mark, waitText);
        } else {
            // Captured values become variables of the macro that waited, for its later steps.
            Map<String, String> captured = told.match(waitWho, mark, waitText);
            if (captured != null && !w.negate()) {
                waitFrame.vars().putAll(captured);
            }
            hit = captured == null ? null : captured.toString();
        }
        String quoted = "\"" + waitText + "\"";
        if (w.negate()) {
            if (hit != null) {
                fail(waitWho + " was told " + quoted + ": " + hit);
            } else if (now >= waitDeadline) {
                pass(waitWho + " wasn't told " + quoted);
            } else {
                return false;
            }
        } else if (hit != null) {
            if (w.expect()) {
                pass(waitWho + " was told " + quoted);
            }
        } else if (now >= waitDeadline) {
            List<String> recent = told.since(waitWho, mark, 3);
            String seen = recent.isEmpty() ? " (told nothing since the last command)"
                    : " (last told: " + String.join(" | ", recent) + ")";
            if (w.expect()) {
                fail(waitWho + " wasn't told " + quoted + " within " + Args.describeTicks(w.ticks()) + seen);
            } else {
                waitingFor = null;
                finish(Level.STOPPED, "stopped " + title + ": " + waitWho + " wasn't told " + quoted + " within "
                        + Args.describeTicks(w.ticks()) + seen);
                return false;
            }
        } else {
            return false;
        }
        waitingFor = null;
        return true;
    }


    private void startNested(Frame frame, Macro.Run r) {
        String name = Args.substitute(r.macro(), frame.vars());
        Macro macro = library.get(name);
        if (macro == null) {
            finish(Level.STOPPED, "stopped " + title + ": no macro named " + name + where(frame, r));
            return;
        }
        if (frames.size() >= MAX_DEPTH) {
            finish(Level.STOPPED, "stopped " + title + ": macros nested more than " + MAX_DEPTH + " deep at "
                    + name + where(frame, r));
            return;
        }
        Map<String, String> vars;
        try {
            vars = Args.bind(macro, Args.tokenize(Args.substitute(r.args(), frame.vars())), builtIns);
        } catch (Args.BindException e) {
            finish(Level.STOPPED, "stopped " + title + ": run " + name + ": " + e.getMessage() + where(frame, r));
            return;
        }
        host.show(Level.INFO, "▶ " + describe(macro, vars));
        frames.push(new Frame(macro, new LinkedHashMap<>(vars), new int[1]));
    }

    private void pass(String text) {
        passed++;
        host.show(Level.PASS, text);
    }

    private void fail(String text) {
        failed++;
        host.show(Level.FAIL, text);
    }

    private void finish(Level level, String text) {
        finished = true;
        waitingFor = null;
        frames.clear();
        host.show(level, text);
    }

    private static String where(Frame frame, Macro.Step step) {
        return " (" + frame.macro().file() + ":" + step.line() + ")";
    }

    /** {@code expedition.take who=Carol bank=Capital n=2}. */
    static String describe(Macro macro, Map<String, String> vars) {
        StringBuilder out = new StringBuilder(macro.name());
        for (Macro.Param p : macro.params()) {
            String value = vars.get(p.name());
            out.append(' ').append(p.name()).append('=')
                    .append(value == null || value.isEmpty() || value.contains(" ") ? '"' + String.valueOf(value) + '"'
                            : value);
        }
        return out.toString();
    }
}
