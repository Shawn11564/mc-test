package io.mctest.agent.core.bench;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** Recording commands and saving them as a macro (docs/MACROS.md §6). */
class CommandLogTest {

    @Test
    void keepsHistoryAndRecordsOnlyWhileRecording() {
        CommandLog log = new CommandLog();
        log.typed("Alice", "say before");
        log.startRecording("Alice");
        log.typed("Alice", "/actor Bob here");
        log.typed("Alice", "actor Bob click Expeditions");
        assertEquals(List.of("/actor Bob here", "/actor Bob click Expeditions"), log.stopRecording("Alice"));
        assertNull(log.stopRecording("Alice"));
        assertEquals(List.of("/actor Bob here", "/actor Bob click Expeditions"), log.last("Alice", 2));
        assertEquals(3, log.last("Alice", 50).size());
    }

    @Test
    void turnsActorsIntoParametersAndTheRecorderIntoMe() {
        String text = CommandLog.toMacro("invite", List.of(
                "/actor Bobby cmd faction invite Alice",
                "/actor Bob cmd faction join North",
                "/tp Bob Bobby"), List.of("Bob", "Bobby"), "Alice", "Recorded by Alice.");
        assertEquals(String.join("\n",
                "macro invite who=Bobby who2=Bob",
                "  # Recorded by Alice.",
                "  /actor {who} cmd faction invite {me}",
                "  /actor {who2} cmd faction join North",
                "  /tp {who2} {who}",
                "end", ""), text);
        // What it wrote reads back as the same macro, and "the same, for Carol" is one argument.
        Macro m = MacroParser.parse("r.macro", text).macros().get(0);
        assertEquals("invite [who=Bobby] [who2=Bob]", m.usage());
        assertEquals(List.of(), MacroParser.parse("r.macro", text).problems());
        assertEquals("/actor Carol cmd faction invite Alice", Args.substitute(m.steps().get(0) instanceof Macro.Command c
                ? c.text() : "", Map.of("who", "Carol", "me", "Alice")));
    }
}
