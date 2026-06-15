package io.mctest.agent.core;

import java.util.Map;

/**
 * SPI implemented by a SUT (System Under Test) to answer authoritative plugin-state queries for
 * {@code truth.assertPluginState} (PROTOCOL.md §7.5). <strong>Pure Java — NO Bukkit/game types.</strong>
 *
 * <p>The SUT registers an instance via the Bukkit {@code ServicesManager} so the server agent (which
 * shares this exact class via the published {@code mc-test-agent-core}) can resolve it and probe real
 * state. The provider only fetches/computes a value; the agent applies the {@code expect} predicate
 * and the runner owns the verdict.
 */
public interface McTestStateProvider {

    /**
     * @param query SUT-registered probe name (e.g. {@code "regions.exists"}).
     * @param args  query arguments (e.g. {@code {"name":"TestRegion"}}).
     * @return the typed value for the query (boolean/number/string/list), never the verdict.
     * @throws Exception if the query is unknown or evaluation fails (mapped to {@code ASSERT_FAILED}).
     */
    Object query(String query, Map<String, Object> args) throws Exception;
}
