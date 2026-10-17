package io.mctest.agent.core.bench;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** The test-guide checker (docs/MACROS.md §7): macro calls resolve, and steps don't point back. */
class GuideCheckTest {

    private static final MacroLibrary LIB = MacroLibrary.of(Map.of("e.macro",
            "macro expedition.take who bank=Capital n=1\n/actor {who} click Expedition #{n}\nend"));

    private static List<String> problems(String guide) {
        return GuideCheck.check("GUIDE.md", guide, LIB).problems().stream().map(Problem::toString).toList();
    }

    @Test
    void acceptsAGuideThatSpellsEveryStepOut() {
        String guide = String.join("\n",
                "## 3.1 Expeditions",
                "",
                "5. `/actor spawn Carol` at the bank. She starts the second party:",
                "   `/m expedition.take Carol n=2`.",
                "   - [ ] Carol is told she joined. Active again once it's back.",
                "```",
                "/m expedition.take who=Dave",
                "```");
        assertEquals(List.of(), problems(guide));
        assertEquals(2, GuideCheck.check("GUIDE.md", guide, LIB).calls());
    }

    @Test
    void flagsStepsThatPointBackWithTheLineOfThePhrase() {
        String guide = String.join("\n",
                "5. `/actor spawn Carol` at the bank. She starts the second party the same way",
                "   (`bank menu Capital`, `click Expeditions`).",
                "6. Map area C yourself (as in 3.3), and buy the deed.",
                "7. Bob leaves; he takes the expedition again (step 2) and invites you.",
                "8. Claim B again (7.1 steps 2–6).",
                "9. Repeat the raid for each ending.");
        List<String> p = problems(guide);
        assertEquals(5, p.size(), p.toString());
        assertTrue(p.get(0).startsWith("GUIDE.md:1: error: \"the same way\""), p.get(0));
        assertTrue(p.get(1).startsWith("GUIDE.md:3: error: \"as in 3\""), p.get(1));
        assertTrue(p.get(2).startsWith("GUIDE.md:4: error: \"(step 2)\""), p.get(2));
        assertTrue(p.get(3).startsWith("GUIDE.md:5: error: \"(7.1 steps 2–6)\""), p.get(3));
        assertTrue(p.get(4).startsWith("GUIDE.md:6: error: \"Repeat\""), p.get(4));
    }

    @Test
    void aPointerNextToTheCommandItMeansIsFineAndTheMarkerOptsOut() {
        String guide = String.join("\n",
                "1. Re-ally the factions (2.6 step 3): `/faction ally South`.",
                "",
                "2. Land from a bank (4 step 6) never counts. <!-- guide-check: ok -->");
        assertEquals(List.of(), problems(guide));
    }

    @Test
    void checksMacroCalls() {
        List<String> p = problems(String.join("\n",
                "1. `/m expedition.tak Bob`",
                "2. `/m expedition.take <name>`",
                "3. `/m expedition.take Bob x=1`"));
        assertEquals(3, p.size(), p.toString());
        assertTrue(p.get(0).contains("no macro named expedition.tak"));
        assertTrue(p.get(1).contains("placeholder <name>"));
        assertTrue(p.get(2).contains("'x' isn't a parameter"));
    }
}
