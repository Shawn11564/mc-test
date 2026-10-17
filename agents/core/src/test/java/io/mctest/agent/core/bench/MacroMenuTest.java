package io.mctest.agent.core.bench;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.mctest.agent.core.bench.MacroMenu.Click;
import io.mctest.agent.core.bench.MacroMenu.Screen;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The macro menu's screens and edits (docs/MACROS.md §8), against real files in a temp folder and a fake host
 * that records what the shim would do.
 */
class MacroMenuTest {

    @TempDir
    Path dir;

    private MacroLibrary library;
    private MacroLayout layout;
    private MacroEditor editor;
    private FakeHost host;

    private final class FakeHost implements MacroMenu.Host {
        Screen screen;
        final List<String> did = new ArrayList<>();

        @Override public String who() { return "Alice"; }
        @Override public MacroLibrary library() { return library; }
        @Override public MacroEditor editor() { return editor; }
        @Override public MacroLayout layout() { return layout; }
        @Override public String running() { return null; }
        @Override public boolean paused() { return false; }
        @Override public void stop() { did.add("stop"); }
        @Override public void resume() { did.add("resume"); }
        @Override public String last() { return null; }
        @Override public void again() { did.add("again"); }
        @Override public boolean recording() { return false; }
        @Override public int recorded() { return 0; }
        @Override public void startRecording() { did.add("record"); }
        @Override public void cancelRecording() { did.add("cancel"); }
        @Override public String run(String macro) { did.add("run " + macro); return null; }
        @Override public void suggest(String prompt, String command, boolean reopen) { did.add("suggest " + command); }
        @Override public String editInBook(String macro) { did.add("book " + macro); return null; }
        @Override public void open(Screen s) { screen = s; did.add("open " + s.title()); }
        @Override public void close() { did.add("close"); }
        @Override public void tell(String text, boolean error) { did.add((error ? "error " : "tell ") + text); }
        @Override public String runPrefix() { return "/m "; }
    }

    @BeforeEach
    void setUp() throws Exception {
        Files.writeString(dir.resolve("a.macro"), """
                macro area.give who
                  # Gives area B to {who}.
                  /say give {who}
                  /say done
                end

                macro area.take
                  /say take
                end
                """);
        Files.writeString(dir.resolve("b.macro"), "macro other\n  wait 1s\n  expect Alice told \"hi\"\nend\n");
        library = new MacroLibrary(List.of(dir));
        layout = new MacroLayout(dir.resolve(MacroLayout.FILE));
        editor = new MacroEditor(library, layout);
        host = new FakeHost();
    }

    private static String name(MacroMenu.Icon icon) {
        return icon == null ? null : icon.name().text();
    }

    private static String lore(MacroMenu.Icon icon) {
        StringBuilder out = new StringBuilder();
        icon.lore().forEach(l -> out.append(l.text()).append('\n'));
        return out.toString();
    }

    private String file(String name) throws Exception {
        return Files.readString(dir.resolve(name), StandardCharsets.UTF_8);
    }

    @Test
    void theListShowsEveryMacroWithItsStepsInFileOrder() {
        Screen s = MacroMenu.macros(host);
        assertEquals("area.give", name(s.icon(0)));
        assertEquals("area.take", name(s.icon(1)));
        assertEquals("other", name(s.icon(2)));
        assertNull(s.icon(3));
        String lore = lore(s.icon(0));
        assertTrue(lore.contains("<who>") && lore.contains("Gives area B to {who}.")
                && lore.contains("1  /say give {who}") && lore.contains("2  /say done"), lore);
        assertTrue(s.icon(0).item().endsWith("_shulker_box"));
        assertTrue(!s.icon(0).item().equals(s.icon(2).item()), "macros from another file get another colour");
    }

    @Test
    void draggingMovesAMacroAndSwapsWithTheOneThere() throws Exception {
        Screen s = MacroMenu.macros(host);
        s.click(0, Click.LEFT);
        assertEquals("area.give", name(s.carried()));
        assertNull(s.icon(0), "its place is empty while it's held");
        assertEquals("area.take", name(s.icon(1)), "nothing slides into the gap");
        s.click(20, Click.LEFT);
        assertNull(s.carried());
        assertEquals("area.give", name(s.icon(20)));
        assertTrue(file(MacroLayout.FILE).contains("20 area.give"), file(MacroLayout.FILE));

        s.click(20, Click.LEFT); // pick it up again and drop it on "other"
        s.click(2, Click.LEFT);
        assertEquals("area.give", name(s.icon(2)));
        assertEquals("other", name(s.carried()), "the one it landed on is now held");
        s.closed();
        assertNull(s.carried());
        Map<Integer, String> now = layout.arrange(List.copyOf(library.all().keySet()), Set.of());
        assertEquals(3, now.size(), "every macro still has a place: " + now);
        assertEquals("area.give", now.get(2));

        Screen again = MacroMenu.macros(host);
        assertEquals("area.give", name(again.icon(2)), "the arrangement survives reopening");
    }

    @Test
    void aMacroCanBeDraggedOntoTheNextPage() throws Exception {
        Screen s = MacroMenu.macros(host);
        s.click(1, Click.LEFT);
        s.click(53, Click.LEFT); // next page, while holding
        s.click(4, Click.LEFT);
        assertEquals("area.take", name(s.icon(4)));
        assertTrue(file(MacroLayout.FILE).contains((MacroLayout.PAGE + 4) + " area.take"));
        s.click(45, Click.LEFT);
        assertNull(s.icon(1));
    }

    @Test
    void rightClickOpensShiftClickRuns() {
        Screen s = MacroMenu.macros(host);
        s.click(1, Click.SHIFT);
        assertEquals(List.of("run area.take", "close"), host.did);
        host.did.clear();
        s.click(0, Click.SHIFT);
        assertEquals(List.of("suggest /m area.give "), host.did, "a required parameter is filled in through chat");
        s.click(0, Click.RIGHT);
        assertEquals("Macro area.give", host.screen.title());
    }

    @Test
    void theStepsScreenShowsEveryStepAndReordersByDragging() throws Exception {
        Screen s = MacroMenu.macro(host, "other");
        assertEquals("1  wait 1s", name(s.icon(0)));
        assertEquals("minecraft:clock", s.icon(0).item());
        assertEquals("minecraft:target", s.icon(1).item());
        s.click(1, Click.LEFT);
        assertEquals("1  wait 1s", name(s.icon(0)));
        assertNull(s.icon(1), "the others close up while one is held");
        s.click(0, Click.LEFT);
        assertEquals("macro other\n  expect Alice told \"hi\"\n  wait 1s\nend\n", file("b.macro"));
        assertEquals("1  expect Alice told \"hi\"", name(s.icon(0)));
    }

    @Test
    void qDeletesAStepAndUndoBringsItBack() throws Exception {
        Screen s = MacroMenu.macro(host, "area.give");
        s.click(0, Click.DROP);
        assertEquals(List.of("/say done"), MacroSource.steps(file("a.macro"), "area.give"));
        assertEquals("↶ Undo", name(s.icon(52)));
        s.click(52, Click.LEFT);
        assertEquals(List.of("/say give {who}", "/say done"), MacroSource.steps(file("a.macro"), "area.give"));
    }

    @Test
    void textComesFromChatFilledIn() {
        Screen s = MacroMenu.macro(host, "area.give");
        s.click(1, Click.RIGHT);
        s.click(48, Click.LEFT);
        s.click(46, Click.LEFT);
        assertEquals(List.of("suggest /macro edit area.give step 2 /say done", "suggest /macro edit area.give add ",
                "suggest /macro edit area.give header area.give who"), host.did);
    }

    @Test
    void deletingAsksFirst() throws Exception {
        Screen s = MacroMenu.macro(host, "area.take");
        s.click(53, Click.LEFT);
        Screen confirm = host.screen;
        assertEquals("Delete area.take?", confirm.title());
        confirm.click(15, Click.LEFT);
        assertEquals(s, host.screen, "keep it goes back");
        s.click(53, Click.LEFT);
        host.screen.click(11, Click.LEFT);
        assertNull(library.get("area.take"));
        assertTrue(file("a.macro").contains("macro area.give"));
        assertEquals("Macros", host.screen.title());
    }

    @Test
    void editsAreCheckedAndRenamesFollowTheLayout() throws Exception {
        assertThrows(MacroSource.EditException.class, () -> editor.addStep("Alice", "other", "not a step"));
        assertEquals(2, MacroSource.steps(file("b.macro"), "other").size(), "a refused edit leaves the file alone");
        assertThrows(MacroSource.EditException.class, () -> editor.setHeader("Alice", "other", "area.take"));

        Screen s = MacroMenu.macros(host);
        s.click(2, Click.LEFT);
        s.click(9, Click.LEFT);
        MacroEditor.Done done = editor.setHeader("Alice", "other", "renamed who=Alice");
        assertEquals("renamed", done.macro());
        assertEquals("renamed", name(MacroMenu.macros(host).icon(9)), "the renamed macro keeps its place");

        done = editor.create("Alice", "area.new who", "A new one.");
        assertTrue(file("a.macro").contains("macro area.new who\n  # A new one.\nend"), "joins the file with its prefix");
        done = editor.create("Alice", "loner", null);
        assertNotNull(library.get("loner"));
        assertTrue(Files.exists(dir.resolve("new.macro")));
        editor.undo("Alice");
        assertNull(library.get("loner"));
    }

    @Test
    void undoRefusesWhenTheFileChangedSince() throws Exception {
        editor.addStep("Alice", "other", "/say added");
        Files.writeString(dir.resolve("b.macro"), file("b.macro") + "\n# edited in an editor\n");
        library.reload();
        assertThrows(MacroSource.EditException.class, () -> editor.undo("Alice"));
        assertTrue(file("b.macro").contains("edited in an editor"));
    }
}
