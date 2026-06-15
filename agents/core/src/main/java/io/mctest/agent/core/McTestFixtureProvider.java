package io.mctest.agent.core;

import java.util.Map;

/**
 * SPI implemented by a SUT to apply custom, named fixtures for {@code fixture.set}/{@code fixture.reset}
 * (PROTOCOL.md §7.5). <strong>Pure Java — NO Bukkit/game types.</strong>
 *
 * <p>The SUT registers an instance via the Bukkit {@code ServicesManager}; the server agent delegates
 * any fixture the provider {@link #supports} to it (e.g. {@code regions.createRegion}). The agent
 * records the returned handle so {@code fixture.reset} / {@code session.close} can {@link #undo} it.
 */
public interface McTestFixtureProvider {

    /** @return true if this provider knows how to apply the named fixture. */
    boolean supports(String fixture);

    /**
     * Applies the fixture, mutating SUT state.
     *
     * @return an opaque result (e.g. {@code {"regionId":"TestRegion"}}) surfaced in {@code result.result}.
     * @throws Exception if the fixture is unknown/failed (mapped to {@code FIXTURE_FAILED}).
     */
    Object apply(String fixture, Map<String, Object> args) throws Exception;

    /**
     * Reverses a previously applied fixture, addressed by the handle the agent recorded.
     *
     * @throws Exception if the undo fails.
     */
    void undo(String handle) throws Exception;
}
