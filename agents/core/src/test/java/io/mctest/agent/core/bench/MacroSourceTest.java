package io.mctest.agent.core.bench;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.mctest.agent.core.bench.MacroSource.EditException;
import java.util.List;
import org.junit.jupiter.api.Test;

/** Editing one macro in a file's text without disturbing the rest (docs/MACROS.md §8). */
class MacroSourceTest {

    private static final String FILE = """
            # Setup macros.

            macro first who
              # Gives {who} things.
              /give {who} dirt
              # a comment between steps stays put
              /say one
              wait 1s
            end

            macro second
              /say two
            end
            """;

    @Test
    void stepsAreTheBodyLinesThatArentCommentsOrBlank() throws Exception {
        assertEquals(List.of("/give {who} dirt", "/say one", "wait 1s"), MacroSource.steps(FILE, "first"));
        assertEquals(List.of("/say two"), MacroSource.steps(FILE, "SECOND"));
        assertEquals("first who", MacroSource.header(FILE, "first"));
    }

    @Test
    void setInsertAndRemoveKeepIndentationAndComments() throws Exception {
        String t = MacroSource.setStep(FILE, "first", 2, "/say uno");
        assertTrue(t.contains("  # a comment between steps stays put\n  /say uno\n"), t);
        t = MacroSource.insertStep(t, "first", 1, "/clear {who}");
        assertEquals(List.of("/clear {who}", "/give {who} dirt", "/say uno", "wait 1s"), MacroSource.steps(t, "first"));
        t = MacroSource.addStep(t, "first", "/say last");
        assertEquals("/say last", MacroSource.steps(t, "first").get(4));
        t = MacroSource.removeStep(t, "first", 1);
        assertEquals(List.of("/give {who} dirt", "/say uno", "wait 1s", "/say last"), MacroSource.steps(t, "first"));
        assertTrue(t.contains("macro second\n  /say two\nend"), "the other macro is untouched");
        assertTrue(t.startsWith("# Setup macros.\n"));
    }

    @Test
    void moveStepPutsItAtTheNewNumber() throws Exception {
        assertEquals(List.of("/say one", "wait 1s", "/give {who} dirt"),
                MacroSource.steps(MacroSource.moveStep(FILE, "first", 1, 3), "first"));
        assertEquals(List.of("wait 1s", "/give {who} dirt", "/say one"),
                MacroSource.steps(MacroSource.moveStep(FILE, "first", 3, 1), "first"));
        assertEquals(List.of("/give {who} dirt", "wait 1s", "/say one"),
                MacroSource.steps(MacroSource.moveStep(FILE, "first", 3, 2), "first"));
    }

    @Test
    void anEmptyMacroGetsItsFirstStepAfterItsDescription() throws Exception {
        String t = MacroSource.append("", MacroSource.newMacro("fresh who", "Does a thing."));
        assertEquals("macro fresh who\n  # Does a thing.\nend\n", t);
        t = MacroSource.addStep(t, "fresh", "/say hi");
        assertEquals("macro fresh who\n  # Does a thing.\n  /say hi\nend\n", t);
    }

    @Test
    void headerDescriptionCopyAndRemove() throws Exception {
        String t = MacroSource.setHeader(FILE, "first", "renamed who n=1");
        assertEquals("renamed who n=1", MacroSource.header(t, "renamed"));
        t = MacroSource.setDescription(t, "renamed", List.of("Line one.", "Line two."));
        assertTrue(t.contains("macro renamed who n=1\n  # Line one.\n  # Line two.\n  /give"), t);
        t = MacroSource.copy(t, "renamed", "renamed.copy");
        assertEquals(MacroSource.steps(t, "renamed"), MacroSource.steps(t, "renamed.copy"));
        assertEquals("renamed.copy who n=1", MacroSource.header(t, "renamed.copy"));
        t = MacroSource.remove(t, "renamed");
        assertThrows(EditException.class, () -> MacroSource.steps(MacroSource.remove(FILE, "first"), "first"));
        MacroParser.Result parsed = MacroParser.parse("t", t);
        assertEquals(List.of(), parsed.problems());
        assertEquals(List.of("renamed.copy", "second"), parsed.macros().stream().map(Macro::name).toList());
    }

    @Test
    void windowsLineEndingsStay() throws Exception {
        String t = MacroSource.addStep("macro a\r\n  /say 1\r\nend\r\n", "a", "/say 2");
        assertEquals("macro a\r\n  /say 1\r\n  /say 2\r\nend\r\n", t);
    }

    @Test
    void stepsThatWouldBreakTheFileAreRefused() {
        assertThrows(EditException.class, () -> MacroSource.addStep(FILE, "first", "end"));
        assertThrows(EditException.class, () -> MacroSource.addStep(FILE, "first", "macro x"));
        assertThrows(EditException.class, () -> MacroSource.addStep(FILE, "first", "  "));
        assertThrows(EditException.class, () -> MacroSource.removeStep(FILE, "first", 4));
        assertThrows(EditException.class, () -> MacroSource.steps(FILE, "nope"));
    }

    @Test
    void aBookRoundTripsTheMacro() throws Exception {
        String block = MacroSource.block(FILE, "first");
        List<String> pages = MacroSource.toBook(block);
        assertEquals("macro first who", pages.get(0).split("\n")[0], "no indentation in the book");
        String back = MacroSource.fromBook(pages);
        assertEquals("macro first who\n  # Gives {who} things.\n  /give {who} dirt\n"
                + "  # a comment between steps stays put\n  /say one\n  wait 1s\nend\n", back);
        assertEquals("macro x\n  /say hi\nend\n", MacroSource.fromBook(List.of("macro x\n/say hi")), "end is added");
        assertThrows(EditException.class, () -> MacroSource.fromBook(List.of("/say no header")));
    }

    @Test
    void aLongMacroSpreadsOverPagesWithoutSplittingALine() {
        StringBuilder block = new StringBuilder("macro long\n");
        for (int i = 0; i < 30; i++) {
            block.append("  /say this is step number ").append(i).append('\n');
        }
        block.append("end");
        List<String> pages = MacroSource.toBook(block.toString());
        assertTrue(pages.size() > 2, "spread over pages: " + pages.size());
        for (String page : pages) {
            int rows = 0;
            for (String line : page.split("\n")) {
                rows += Math.max(1, (line.length() + MacroSource.BOOK_LINE - 1) / MacroSource.BOOK_LINE);
            }
            assertTrue(rows <= MacroSource.BOOK_LINES, "a page fits: " + page);
        }
    }
}
