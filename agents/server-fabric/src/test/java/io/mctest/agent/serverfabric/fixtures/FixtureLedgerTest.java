package io.mctest.agent.serverfabric.fixtures;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Pure undo-bookkeeping tests for the server-fabric {@link FixtureLedger} + {@link AppliedFixture} — no
 * Fabric runtime. Verifies LIFO revert order, single-fixture revert by handle, double-undo guarding
 * (reset then close), and error collection. Mirrors the server-bukkit suite and pins server-fabric's copy.
 */
class FixtureLedgerTest {

    private AppliedFixture rec(String handle, List<String> log) {
        return new AppliedFixture(handle, "fx:" + handle, () -> log.add(handle));
    }

    @Test
    void revertAllRunsUndosInLifoOrder() {
        FixtureLedger ledger = new FixtureLedger();
        List<String> order = new ArrayList<>();
        ledger.record(rec("a", order));
        ledger.record(rec("b", order));
        ledger.record(rec("c", order));
        assertEquals(3, ledger.size());

        FixtureLedger.RevertResult result = ledger.revertAll();

        assertEquals(3, result.reverted);
        assertTrue(result.errors.isEmpty());
        // Last applied is reverted first.
        assertEquals(List.of("c", "b", "a"), order);
        assertEquals(0, ledger.size());
    }

    @Test
    void revertOneByHandleLeavesOthersApplied() {
        FixtureLedger ledger = new FixtureLedger();
        List<String> order = new ArrayList<>();
        ledger.record(rec("a", order));
        ledger.record(rec("b", order));

        assertTrue(ledger.revertOne("a"));
        assertEquals(List.of("a"), order);
        // "b" is still applied and visible.
        assertEquals(List.of("b"), ledger.handles());

        // Reverting an unknown / already-reverted handle is a no-op.
        assertFalse(ledger.revertOne("a"));
        assertFalse(ledger.revertOne("missing"));
    }

    @Test
    void closeAfterResetDoesNotDoubleUndo() {
        FixtureLedger ledger = new FixtureLedger();
        List<String> order = new ArrayList<>();
        ledger.record(rec("a", order));

        assertTrue(ledger.revertOne("a"));
        // revertAll (session.close) must not run "a"'s undo a second time.
        FixtureLedger.RevertResult result = ledger.revertAll();
        assertEquals(0, result.reverted);
        assertEquals(List.of("a"), order);
    }

    @Test
    void revertAllCollectsUndoErrors() {
        FixtureLedger ledger = new FixtureLedger();
        ledger.record(new AppliedFixture("bad", "fx:bad", () -> {
            throw new IllegalStateException("boom");
        }));

        FixtureLedger.RevertResult result = ledger.revertAll();
        assertEquals(0, result.reverted);
        assertEquals(1, result.errors.size());
        assertTrue(result.errors.get(0).contains("boom"));
    }

    @Test
    void handlesSnapshotExcludesReverted() {
        FixtureLedger ledger = new FixtureLedger();
        List<String> order = new ArrayList<>();
        ledger.record(rec("a", order));
        ledger.record(rec("b", order));
        ledger.revertOne("b");
        assertEquals(List.of("a"), ledger.handles());
    }
}
