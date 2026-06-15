package io.mctest.agent.core.client;

/**
 * The client analog of the server-side {@code McTestStateProvider} SPI: a widget/screen our cooperating
 * SUT mods implement so the client agent reads a stable {@code testId} off the live widget tree
 * (PROTOCOL.md §7.3.2 / SELECTORS.md, data component {@code mc-test:test_id} / client widget property).
 * It is the most robust client selector path — a widget that exposes a {@code testId} does not depend on
 * obfuscation-mapped widget internals. Pure interface: no Minecraft/Yarn types, so it lives in the core.
 */
public interface TestIdHolder {

    /** @return the stable {@code testId} for this widget/screen, or {@code null} if untagged. */
    String mcTestId();
}
