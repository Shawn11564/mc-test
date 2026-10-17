package io.mctest.agent.core.bench;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import io.mctest.agent.core.EventBus;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** The wire shape of a runner-judged macro run (PROTOCOL.md §7.5, provisional): what {@code bench.runMacro} sends. */
class MacroEventsTest {

    private static final class QuietHost implements MacroRun.Host {
        @Override
        public String runCommand(String command) {
            return null;
        }

        @Override
        public void show(MacroRun.Level level, String text) {
        }
    }

    @Test
    void aRunIsSentAsStepStartsStepEndsWithTheEvidenceThenOneEnd() throws Exception {
        List<JsonObject> frames = new ArrayList<>();
        EventBus bus = new EventBus(frame -> frames.add(JsonParser.parseString(frame).getAsJsonObject()));
        ToldLog told = new ToldLog();
        MacroLibrary lib = MacroLibrary.of(Map.of("t.macro", "macro m\n/tell Bob hi\nexpect Bob told \"hi\"\nend"));
        Map<String, String> builtIns = new HashMap<>(Map.of("me", "Alice"));
        Macro m = lib.get("m");
        MacroRun run = new MacroRun(lib, m, Args.bind(m, List.of(), builtIns), builtIns, new QuietHost(), told)
                .observe(new MacroEvents("mr_1", () -> bus));
        run.tick(0);
        told.record("Bob", "§7Alice whispers: hi");
        run.tick(1);

        assertEquals(5, frames.size());
        assertEquals("event.macroStep", frames.get(0).get("method").getAsString());
        assertEquals(JsonParser.parseString("""
                {"runId":"mr_1","seq":1,"phase":"start","depth":0,"kind":"command","text":"/tell Bob hi","where":"t.macro:2"}
                """), frames.get(0).get("params"));
        assertEquals(JsonParser.parseString("""
                {"runId":"mr_1","seq":1,"phase":"end","status":"ok"}
                """), frames.get(1).get("params"));
        assertEquals(JsonParser.parseString("""
                {"runId":"mr_1","seq":2,"phase":"end","status":"observed","check":{"who":"Bob","text":"hi","negate":false,
                 "windowMs":5000,"closedBy":"match","hint":"pass","told":[{"seq":1,"text":"§7Alice whispers: hi"}]}}
                """), frames.get(3).get("params"));
        assertEquals("event.macroEnd", frames.get(4).get("method").getAsString());
        assertEquals("done", frames.get(4).getAsJsonObject("params").get("status").getAsString());
    }

    @Test
    void nothingIsSentWhileTheBusIsntUp() throws Exception {
        MacroLibrary lib = MacroLibrary.of(Map.of("t.macro", "macro m\n/x\nend"));
        Macro m = lib.get("m");
        Map<String, String> builtIns = new HashMap<>(Map.of("me", "Alice"));
        MacroRun run = new MacroRun(lib, m, Args.bind(m, List.of(), builtIns), builtIns, new QuietHost(), new ToldLog())
                .observe(new MacroEvents("mr_2", () -> null));
        run.tick(0);
        run.tick(1); // must not throw
    }
}
