package io.mctest.agent.core.bench;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import io.mctest.agent.core.EventBus;
import java.util.function.Supplier;

/**
 * Sends one macro run's structured progress to every MCTP client, for {@code bench.runMacro} (PROTOCOL.md §7.5,
 * provisional): each step as {@code event.macroStep} twice ({@code phase:"start"}, then {@code phase:"end"} with
 * its status and, for a {@code waitfor}/{@code expect}, its {@code check}), and the run's end as
 * {@code event.macroEnd}. Game-free, so every loader's shim sends the same shapes.
 */
public final class MacroEvents implements MacroRun.Observer {

    private final String runId;
    private final Supplier<EventBus> bus;

    /** @param bus the MCTP server's event bus, or null while it isn't up (events are then dropped). */
    public MacroEvents(String runId, Supplier<EventBus> bus) {
        this.runId = runId;
        this.bus = bus;
    }

    @Override
    public void stepStarted(int seq, int depth, String kind, String text, String where) {
        JsonObject p = base(seq, "start");
        p.addProperty("depth", depth);
        p.addProperty("kind", kind);
        p.addProperty("text", text);
        p.addProperty("where", where);
        emit("event.macroStep", p);
    }

    @Override
    public void stepEnded(int seq, String status, String detail, MacroRun.Check check) {
        JsonObject p = base(seq, "end");
        p.addProperty("status", status);
        if (detail != null) {
            p.addProperty("detail", detail);
        }
        if (check != null) {
            p.add("check", check(check));
        }
        emit("event.macroStep", p);
    }

    @Override
    public void ended(String status, String text) {
        JsonObject p = new JsonObject();
        p.addProperty("runId", runId);
        p.addProperty("status", status);
        p.addProperty("text", text);
        emit("event.macroEnd", p);
    }

    /** The evidence window as it goes on the wire: what the runner judges. */
    static JsonObject check(MacroRun.Check check) {
        JsonObject c = new JsonObject();
        c.addProperty("who", check.who());
        c.addProperty("text", check.text());
        c.addProperty("negate", check.negate());
        c.addProperty("windowMs", check.ticks() * 50L);
        c.addProperty("closedBy", check.closedBy());
        c.addProperty("hint", check.hint());
        JsonArray told = new JsonArray();
        for (ToldLog.Entry e : check.told()) {
            JsonObject t = new JsonObject();
            t.addProperty("seq", e.seq());
            t.addProperty("text", e.text());
            told.add(t);
        }
        c.add("told", told);
        return c;
    }

    private JsonObject base(int seq, String phase) {
        JsonObject p = new JsonObject();
        p.addProperty("runId", runId);
        p.addProperty("seq", seq);
        p.addProperty("phase", phase);
        return p;
    }

    private void emit(String method, JsonObject params) {
        EventBus b = bus.get();
        if (b != null) {
            b.emit(method, params);
        }
    }
}
