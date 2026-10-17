package io.mctest.agent.core.bench;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import org.junit.jupiter.api.Test;

/** Running a macro tick by tick (docs/MACROS.md §5), against a fake host and a hand-advanced clock. */
class MacroRunTest {

    /** Records what ran and what was shown; a command's result comes from {@code outcome}. */
    private static final class FakeHost implements MacroRun.Host {
        final List<String> ran = new ArrayList<>();
        final List<String> shown = new ArrayList<>();
        Function<String, String> outcome = c -> null;

        @Override
        public String runCommand(String command) {
            ran.add(command);
            return outcome.apply(command);
        }

        @Override
        public void show(MacroRun.Level level, String text) {
            shown.add(level + " " + text);
        }

        String last() {
            return shown.get(shown.size() - 1);
        }
    }

    private final FakeHost host = new FakeHost();
    private final ToldLog told = new ToldLog();

    private MacroRun start(String files, String name, String args) throws Args.BindException {
        MacroLibrary lib = MacroLibrary.of(Map.of("t.macro", files));
        assertEquals(List.of(), lib.problems());
        Map<String, String> builtIns = new HashMap<>(Map.of("me", "Alice"));
        Macro m = lib.get(name);
        return new MacroRun(lib, m, Args.bind(m, Args.tokenize(args), builtIns), builtIns, host, told);
    }

    @Test
    void runsOneCommandPerTickWithArgumentsSubstituted() throws Exception {
        MacroRun run = start("macro take who n=1\n/actor {who} click Expedition #{n}\n/say {me}\nend", "take", "Carol n=2");
        assertEquals("START take who=Carol n=2", host.shown.get(0));
        assertTrue(run.tick(0));
        assertEquals(List.of("/actor Carol click Expedition #2"), host.ran);
        assertTrue(run.tick(1));
        assertEquals("/say Alice", host.ran.get(1));
        assertFalse(run.tick(2));
        assertEquals("DONE done take who=Carol n=2", host.last());
    }

    @Test
    void aFailedCommandStopsTheMacroUnlessItIsMarkedToCarryOn() throws Exception {
        host.outcome = c -> c.contains("bad") ? "the command failed" : null;
        MacroRun run = start("macro m\n-/clear bad\n/bad\n/never\nend", "m", "");
        run.tick(0);
        run.tick(1);
        assertTrue(run.finished());
        assertEquals(List.of("/clear bad", "/bad"), host.ran);
        assertEquals("STOPPED stopped m: /bad failed — the command failed (t.macro:3)", host.last());
    }

    @Test
    void waitHoldsTheNextStepUntilItsTick() throws Exception {
        MacroRun run = start("macro m\nwait 1s\n/after\nend", "m", "");
        run.tick(100);
        run.tick(119);
        assertEquals(List.of(), host.ran);
        run.tick(120);
        assertEquals(List.of("/after"), host.ran);
    }

    @Test
    void waitforGoesOnWhenTheMessageArrivesAndOnlyCountsNewMessages() throws Exception {
        told.record("Bob", "You joined North."); // before the command: must not count
        host.outcome = c -> null;
        MacroRun run = start("macro m\n/actor Bob cmd faction join North\nwaitfor Bob told \"joined north\"\n/next\nend",
                "m", "");
        run.tick(0);
        run.tick(1);
        run.tick(2);
        assertEquals(List.of("/actor Bob cmd faction join North"), host.ran);
        told.record("bob", "§aYou joined  North.");
        run.tick(3);
        assertEquals("/next", host.ran.get(1));
    }

    @Test
    void waitforStopsTheMacroWhenItTimesOutAndSaysWhatWasToldInstead() throws Exception {
        host.outcome = c -> {
            told.record("Bob", "You can't join North.");
            return null;
        };
        MacroRun run = start("macro m\n/actor Bob cmd faction join North\nwaitfor Bob told joined timeout 2s\n/next\nend",
                "m", "");
        run.tick(0);
        run.tick(1);
        run.tick(41);
        assertTrue(run.finished());
        assertEquals("STOPPED stopped m: Bob wasn't told \"joined\" within 2s (last told: You can't join North.)",
                host.last());
    }

    @Test
    void expectReportsAndCarriesOnAndTheSummaryCountsChecks() throws Exception {
        host.outcome = c -> {
            told.record("Bob", "You joined North.");
            return null;
        };
        MacroRun run = start(String.join("\n", "macro m",
                "/actor Bob cmd faction join North",
                "expect Bob told \"joined North\"",
                "expect Bob told \"you are the leader\" within 1s",
                "expect Bob not told refused within 1s",
                "end"), "m", "");
        for (int t = 0; t < 60 && !run.finished(); t++) {
            run.tick(t);
        }
        assertTrue(host.shown.contains("PASS Bob was told \"joined North\""), host.shown.toString());
        assertTrue(host.shown.contains("FAIL Bob wasn't told \"you are the leader\" within 1s (last told: You joined North.)"),
                host.shown.toString());
        assertTrue(host.shown.contains("PASS Bob wasn't told \"refused\""), host.shown.toString());
        assertEquals("DONE done m — 1 of 3 checks FAILED", host.last());
        assertEquals(2, run.passed());
    }

    @Test
    void runCallsAnotherMacroWithItsOwnArguments() throws Exception {
        MacroRun run = start(String.join("\n",
                "macro outer who",
                "run inner {who} bank=Port",
                "/after",
                "end",
                "macro inner who bank=Capital",
                "/actor {who} cmd bank menu {bank}",
                "end"), "outer", "Dave");
        for (int t = 0; t < 5; t++) {
            run.tick(t);
        }
        assertEquals(List.of("/actor Dave cmd bank menu Port", "/after"), host.ran);
        assertTrue(host.shown.contains("INFO ▶ inner who=Dave bank=Port"));
    }

    @Test
    void aMacroThatCallsItselfStopsAtTheDepthLimit() throws Exception {
        MacroRun run = start("macro loop\nrun loop\nend", "loop", "");
        run.tick(0);
        assertTrue(run.finished());
        assertTrue(host.last().contains("nested more than " + MacroRun.MAX_DEPTH + " deep"), host.last());
    }

    @Test
    void aPlusCommandRunsInTheSameTickAsTheOneBeforeIt() throws Exception {
        MacroRun run = start(String.join("\n", "macro move",
                "/item replace entity Bob hotbar.8 from entity Alice weapon.mainhand",
                "+/item replace entity Alice weapon.mainhand with air",
                "/after",
                "end"), "move", "");
        run.tick(0);
        assertEquals(2, host.ran.size());
        run.tick(1);
        assertEquals("/after", host.ran.get(2));
    }

    @Test
    void aCaptureTakesAWordFromTheMessageForLaterSteps() throws Exception {
        host.outcome = c -> {
            if (c.startsWith("/appraise")) {
                told.record("Alice", "§aAppraised as plains land. The bank has listed it as #12.");
            }
            return null;
        };
        MacroRun run = start(String.join("\n", "macro m",
                "/appraise",
                "waitfor {me} told \"listed it as #{=listing}\"",
                "/actor Dave cmd mapfactions bank buy Capital {listing}",
                "end"), "m", "");
        for (int t = 0; t < 5; t++) {
            run.tick(t);
        }
        assertEquals("/actor Dave cmd mapfactions bank buy Capital 12", host.ran.get(1));
    }

    @Test
    void macroNamesMatchIgnoringCase() {
        MacroLibrary lib = MacroLibrary.of(Map.of("a.macro", "macro area.B who\n/say {who}\nend"));
        assertEquals("area.B", lib.get("area.b").name());
    }

    @Test
    void pauseWaitsForContinue() throws Exception {
        MacroRun run = start("macro m\npause Hold the map.\n/after\nend", "m", "");
        run.tick(0);
        run.tick(1);
        assertTrue(run.paused());
        assertEquals("PAUSE Hold the map.", host.last());
        assertEquals(List.of(), host.ran);
        assertTrue(run.resume());
        run.tick(2);
        assertEquals(List.of("/after"), host.ran);
    }

    @Test
    void stopEndsIt() throws Exception {
        MacroRun run = start("macro m\nwait 10s\n/after\nend", "m", "");
        run.tick(0);
        run.stop();
        assertFalse(run.tick(1000));
        assertEquals(List.of(), host.ran);
        assertEquals("STOPPED stopped m", host.last());
    }
}
