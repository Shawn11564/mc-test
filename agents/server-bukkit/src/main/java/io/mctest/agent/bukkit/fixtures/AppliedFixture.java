package io.mctest.agent.bukkit.fixtures;

/**
 * One applied-fixture bookkeeping record: the opaque {@code handle} the wire returns, the fixture
 * name, and the {@link Undo} that reverses it. {@link FixtureManager} stacks these per session so
 * {@code fixture.reset} (and {@code session.close}) can revert them in LIFO order. Pure data — no
 * Bukkit types — so the undo bookkeeping is unit-testable.
 */
public final class AppliedFixture {

    /** A reversal action; {@link FixtureManager} runs it on reset/close. May throw to signal failure. */
    @FunctionalInterface
    public interface Undo {
        void run() throws Exception;
    }

    public final String handle;
    public final String fixture;
    public final Undo undo;
    private boolean reverted;

    public AppliedFixture(String handle, String fixture, Undo undo) {
        this.handle = handle;
        this.fixture = fixture;
        this.undo = undo;
    }

    /** @return true the first time, then false — guards against a double-undo (reset then close). */
    public synchronized boolean markReverted() {
        if (reverted) {
            return false;
        }
        reverted = true;
        return true;
    }

    public synchronized boolean isReverted() {
        return reverted;
    }
}
