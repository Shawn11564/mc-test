package io.mctest.agent.core.bench;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** The {@code .macro} format (docs/MACROS.md §2) and argument binding (§3). */
class MacroParserTest {

    private static final String EXPEDITION = String.join("\n",
            "# A file comment, ignored.",
            "macro expedition.take who bank=Capital n=1",
            "  # Takes expedition #{n} at {bank} as {who}.",
            "  # Second description line.",
            "  -/clear {who}",
            "  /actor {who} cmd mapfactions bank menu {bank}",
            "  /actor {who} click Expedition #{n}",
            "  expect {who} told \"You joined\" within 2s",
            "  expect {who} not told refused",
            "  waitfor {me} told \"done\" timeout 1m",
            "  wait 1.5s",
            "  run other {who} n={n}",
            "  say Hold the map for 2 minutes.",
            "  pause",
            "end",
            "",
            "macro other who n",
            "  /say {who} {n}",
            "end");

    @Test
    void readsHeaderDescriptionAndEveryStepKind() {
        MacroParser.Result r = MacroParser.parse("exp.macro", EXPEDITION);
        assertEquals(List.of(), r.problems());
        assertEquals(2, r.macros().size());
        Macro m = r.macros().get(0);
        assertEquals("expedition.take", m.name());
        assertEquals("expedition.take <who> [bank=Capital] [n=1]", m.usage());
        assertEquals(List.of("Takes expedition #{n} at {bank} as {who}.", "Second description line."), m.description());
        List<Macro.Step> s = m.steps();
        assertEquals(10, s.size());
        assertEquals(new Macro.Command("/clear {who}", true, false, 5), s.get(0));
        assertEquals(new Macro.Command("/actor {who} cmd mapfactions bank menu {bank}", false, false, 6), s.get(1));
        assertEquals(new Macro.WaitFor("{who}", "You joined", 40, true, false, 8), s.get(3));
        assertEquals(new Macro.WaitFor("{who}", "refused", MacroParser.DEFAULT_EXPECT_TICKS, true, true, 9), s.get(4));
        assertEquals(new Macro.WaitFor("{me}", "done", 1200, false, false, 10), s.get(5));
        assertEquals(30, ((Macro.Wait) s.get(6)).ticks());
        assertEquals(new Macro.Run("other", "{who} n={n}", 12), s.get(7));
        assertInstanceOf(Macro.Say.class, s.get(8));
        assertInstanceOf(Macro.Pause.class, s.get(9));
    }

    @Test
    void reportsBadLinesWithTheirLineNumbers() {
        String text = String.join("\n",
                "macro broken who who",
                "  /ok",
                "  click Expeditions",
                "  wait soon",
                "  /say {typo}",
                "end",
                "macro unterminated",
                "  /say hi");
        MacroParser.Result r = MacroParser.parse("bad.macro", text);
        List<String> shown = r.problems().stream().map(Problem::toString).toList();
        assertTrue(shown.contains("bad.macro:1: error: parameter who is declared twice"), shown.toString());
        assertTrue(shown.stream().anyMatch(p -> p.startsWith("bad.macro:3: error: not a step: click Expeditions")));
        assertTrue(shown.stream().anyMatch(p -> p.startsWith("bad.macro:4: error: wait needs a duration")));
        assertTrue(shown.stream().anyMatch(p -> p.startsWith("bad.macro:5: warning: {typo}")));
        assertTrue(shown.contains("bad.macro:7: error: macro unterminated has no 'end'"), shown.toString());
    }

    @Test
    void bindsPositionalAndNamedArgumentsInAnyMix() throws Exception {
        Macro m = MacroParser.parse("exp.macro", EXPEDITION).macros().get(0);
        Map<String, String> me = Map.of("me", "Alice");
        assertEquals(Map.of("who", "Carol", "bank", "Capital", "n", "2", "me", "Alice"),
                Args.bind(m, Args.tokenize("n=2 Carol"), me));
        assertEquals("Port Royal", Args.bind(m, Args.tokenize("Bob \"Port Royal\""), me).get("bank"));
        assertEquals("missing who — usage: expedition.take <who> [bank=Capital] [n=1]",
                assertThrows(() -> Args.bind(m, List.of(), me)));
        assertTrue(assertThrows(() -> Args.bind(m, Args.tokenize("Bob x=1"), me)).startsWith("'x' isn't a parameter"));
        assertTrue(assertThrows(() -> Args.bind(m, Args.tokenize("a b c d"), me)).startsWith("too many values (d)"));
    }

    @Test
    void againKeepsTheLastValuesAndChangesWhatIsTypedNow() throws Exception {
        Macro m = MacroParser.parse("exp.macro", EXPEDITION).macros().get(0);
        Map<String, String> last = Args.bind(m, Args.tokenize("Carol n=2"), Map.of());
        assertEquals(Map.of("who", "Dave", "bank", "Capital", "n", "2"),
                Args.bind(m, Args.rebind(m, last, List.of("Dave")), Map.of()));
        assertEquals(Map.of("who", "Carol", "bank", "Port", "n", "3"),
                Args.bind(m, Args.rebind(m, last, Args.tokenize("bank=Port n=3")), Map.of()));
        // A value with a space survives the round trip.
        Map<String, String> spaced = Args.bind(m, Args.tokenize("Bob \"Port Royal\""), Map.of());
        assertEquals("Port Royal", Args.bind(m, Args.rebind(m, spaced, List.of()), Map.of()).get("bank"));
    }

    @Test
    void defaultsCanNameOtherParameters() throws Exception {
        Macro m = MacroParser.parse("f", "macro pair who other={who}2\n/say {other}\nend").macros().get(0);
        assertEquals("Bob2", Args.bind(m, List.of("Bob"), Map.of()).get("other"));
    }

    @Test
    void substitutesOnlyKnownNamesSoJsonPassesThrough() {
        Map<String, String> vars = Map.of("who", "Bob");
        assertEquals("/tellraw Bob {\"text\":\"hi {who}\"}",
                Args.substitute("/tellraw {who} {\"text\":\"hi {who}\"}", vars).replace("hi Bob", "hi {who}"));
        assertEquals("/give Bob map[custom_data={a:1}] {x}", Args.substitute("/give {who} map[custom_data={a:1}] {x}", vars));
    }

    @Test
    void readsDurations() {
        assertEquals(200, Args.ticks("10s"));
        assertEquals(200, Args.ticks("10"));
        assertEquals(40, Args.ticks("40t"));
        assertEquals(2400, Args.ticks("2m"));
        assertEquals(-1, Args.ticks("soon"));
        assertEquals("2m", Args.describeTicks(2400));
        assertEquals("15t", Args.describeTicks(15));
    }

    @Test
    void libraryRefusesADuplicateName() {
        MacroLibrary lib = MacroLibrary.of(Map.of("a.macro", "macro x\n/say a\nend", "b.macro", "macro x\n/say b\nend"));
        assertEquals(1, lib.all().size());
        assertEquals(1, lib.problems().size());
        assertTrue(lib.problems().get(0).message().startsWith("macro x is already defined"));
        assertNull(lib.all().get("y"));
        assertFalse(lib.all().isEmpty());
    }

    private static String assertThrows(org.junit.jupiter.api.function.Executable body) {
        return org.junit.jupiter.api.Assertions.assertThrows(Args.BindException.class, body).getMessage();
    }
}
