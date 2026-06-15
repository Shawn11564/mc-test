package io.mctest.agent.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import org.junit.jupiter.api.Test;

/** Unit tests for capability negotiation (PROTOCOL.md §5.1). */
class CapabilitiesNegotiationTest {

    private Capabilities serverAgentCaps() {
        // The canonical server-bukkit advertised set (M3_PLAN / PROTOCOL.md §6.2).
        JsonObject worldTruthDetail = new JsonObject();
        worldTruthDetail.addProperty("radiusLimit", 64);
        return new Capabilities()
                .advertise("worldTruth", worldTruthDetail)
                .advertise("pluginState")
                .advertise("fixtures")
                .advertise("fakePlayers")
                .advertise("chat")
                .advertise("testIdTags");
    }

    @Test
    void grantsRequiredAndOptionalIntersection() {
        Capabilities caps = serverAgentCaps();
        Capabilities.Negotiation neg = caps.negotiate(
                Arrays.asList("worldTruth", "pluginState"),
                Arrays.asList("fixtures", "screenshot"));
        assertTrue(neg.satisfied);
        assertTrue(neg.granted.containsAll(Arrays.asList("worldTruth", "pluginState", "fixtures")));
        // optional 'screenshot' is not advertised → denied.
        assertEquals(Collections.singletonList("screenshot"), neg.denied);
        // capabilityDetails carries only granted keys that have details.
        assertTrue(neg.grantedDetails.has("worldTruth"));
        assertEquals(64, neg.grantedDetails.getAsJsonObject("worldTruth").get("radiusLimit").getAsInt());
    }

    @Test
    void refusesWhenRequiredMissing() {
        Capabilities caps = serverAgentCaps();
        Capabilities.Negotiation neg = caps.negotiate(
                Arrays.asList("worldTruth", "clientScreens", "screenshot"),
                Collections.emptyList());
        assertFalse(neg.satisfied);
        // unmet lists exactly the missing required keys.
        assertEquals(Arrays.asList("clientScreens", "screenshot"), neg.unmet);
        // offered lists what the agent does advertise.
        assertTrue(neg.offered.containsAll(Arrays.asList("worldTruth", "pluginState", "fixtures")));
        // no capabilities granted on refusal.
        assertTrue(neg.granted.isEmpty());
    }

    @Test
    void emptyRequiredMeansAnyAgent() {
        Capabilities caps = serverAgentCaps();
        Capabilities.Negotiation neg = caps.negotiate(Collections.emptyList(), Collections.emptyList());
        assertTrue(neg.satisfied);
        assertTrue(neg.granted.isEmpty());
    }

    @Test
    void grantsListPreservesNoDuplicates() {
        Capabilities caps = serverAgentCaps();
        // 'chat' appears in both required and optional; must not duplicate in granted.
        Capabilities.Negotiation neg = caps.negotiate(
                Arrays.asList("chat"), Arrays.asList("chat", "fixtures"));
        assertTrue(neg.satisfied);
        List<String> granted = neg.granted;
        assertEquals(granted.size(), granted.stream().distinct().count());
        assertTrue(granted.contains("chat"));
        assertTrue(granted.contains("fixtures"));
    }
}
