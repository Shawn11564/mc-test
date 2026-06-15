package io.mctest.agent.bukkit.fixtures;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.Iterator;
import java.util.List;

/**
 * Per-session stack of {@link AppliedFixture}s with LIFO revert semantics. Pure data structure (no
 * Bukkit/Gson) so the undo bookkeeping — the bit most likely to rot — is unit-testable in isolation.
 *
 * <p>{@link FixtureManager} stores one ledger per session (in {@code session.attrs}) and registers a
 * single {@code session.close} cleanup that calls {@link #revertAll}.
 */
public final class FixtureLedger {

    /** Outcome of reverting a fixture: how many reverted and any reversal errors collected. */
    public static final class RevertResult {
        public final int reverted;
        public final List<String> errors;

        RevertResult(int reverted, List<String> errors) {
            this.reverted = reverted;
            this.errors = errors;
        }
    }

    private final Deque<AppliedFixture> stack = new ArrayDeque<>();

    /** Records a freshly applied fixture (pushed on top so revert is LIFO). */
    public synchronized void record(AppliedFixture applied) {
        if (applied != null) {
            stack.push(applied);
        }
    }

    public synchronized int size() {
        return stack.size();
    }

    /** @return a snapshot of the currently-applied (non-reverted) handles, newest first. */
    public synchronized List<String> handles() {
        List<String> out = new ArrayList<>();
        for (AppliedFixture f : stack) {
            if (!f.isReverted()) {
                out.add(f.handle);
            }
        }
        return out;
    }

    /**
     * Reverts the single fixture identified by {@code handle} (no-op if unknown/already reverted).
     *
     * @return true if a matching, not-yet-reverted fixture was found and its undo invoked.
     */
    public boolean revertOne(String handle) {
        AppliedFixture target = null;
        synchronized (this) {
            for (AppliedFixture f : stack) {
                if (f.handle.equals(handle) && !f.isReverted()) {
                    target = f;
                    break;
                }
            }
            if (target == null || !target.markReverted()) {
                return false;
            }
        }
        try {
            target.undo.run();
        } catch (Exception ignored) {
            // Best-effort revert; the caller reports counts, not individual failures here.
        }
        return true;
    }

    /** Reverts every applied fixture in LIFO order, collecting any reversal errors. */
    public RevertResult revertAll() {
        List<AppliedFixture> toRevert = new ArrayList<>();
        synchronized (this) {
            for (Iterator<AppliedFixture> it = stack.iterator(); it.hasNext(); ) {
                AppliedFixture f = it.next();
                if (!f.isReverted() && f.markReverted()) {
                    toRevert.add(f);
                }
            }
            stack.clear();
        }
        int reverted = 0;
        List<String> errors = new ArrayList<>();
        for (AppliedFixture f : toRevert) {
            try {
                f.undo.run();
                reverted++;
            } catch (Exception e) {
                errors.add(f.fixture + ": " + e.getMessage());
            }
        }
        return new RevertResult(reverted, errors);
    }
}
