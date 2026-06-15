package io.mctest.agent.core;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * The agent's advertised capability set plus per-key {@code capabilityDetails} (PROTOCOL.md §5–§6).
 * Builder-style: collect advertised keys and detail objects, then run negotiation against a client's
 * {@code requiredCapabilities}/{@code optionalCapabilities} to produce the granted/denied split.
 */
public final class Capabilities {

    private final Set<String> advertised = new LinkedHashSet<>();
    private final JsonObject details = new JsonObject();

    /** Advertises a capability key with no detail object. */
    public Capabilities advertise(String key) {
        advertised.add(key);
        return this;
    }

    /** Advertises a capability key carrying a {@code capabilityDetails[key]} value object. */
    public Capabilities advertise(String key, JsonObject detail) {
        advertised.add(key);
        if (detail != null) {
            details.add(key, detail);
        }
        return this;
    }

    /** Advertises several keys at once (no detail objects). */
    public Capabilities advertiseAll(Collection<String> keys) {
        if (keys != null) {
            advertised.addAll(keys);
        }
        return this;
    }

    /** @return true if {@code key} is in the advertised set. */
    public boolean grants(String key) {
        return advertised.contains(key);
    }

    /** @return an immutable-ish copy of the advertised keys (insertion order). */
    public Set<String> advertisedKeys() {
        return new LinkedHashSet<>(advertised);
    }

    /** @return the advertised keys as a JSON array (e.g. for {@code session.describe.capabilities}). */
    public JsonArray advertisedArray() {
        JsonArray arr = new JsonArray();
        for (String k : advertised) {
            arr.add(k);
        }
        return arr;
    }

    /**
     * The outcome of negotiating a client's required/optional capability lists against this set
     * (PROTOCOL.md §5.1). When {@link #satisfied} is false, {@link #unmet} holds the missing required
     * keys and the agent MUST refuse with {@code -32002} (no session created).
     */
    public static final class Negotiation {
        public final boolean satisfied;
        public final List<String> granted;
        public final List<String> denied;
        public final List<String> unmet;
        public final List<String> offered;
        public final JsonObject grantedDetails;

        Negotiation(boolean satisfied, List<String> granted, List<String> denied,
                    List<String> unmet, List<String> offered, JsonObject grantedDetails) {
            this.satisfied = satisfied;
            this.granted = granted;
            this.denied = denied;
            this.unmet = unmet;
            this.offered = offered;
            this.grantedDetails = grantedDetails;
        }
    }

    /**
     * Computes the granted/denied split given client requirements (PROTOCOL.md §5.1):
     * <ul>
     *   <li>{@code grantedRequired = required ∩ advertised}; any missing required key → not satisfied.</li>
     *   <li>{@code grantedOptional = optional ∩ advertised}.</li>
     *   <li>{@code granted = grantedRequired ∪ grantedOptional}, {@code denied = optional \ advertised}.</li>
     * </ul>
     */
    public Negotiation negotiate(Collection<String> required, Collection<String> optional) {
        List<String> grantedRequired = new ArrayList<>();
        List<String> unmet = new ArrayList<>();
        if (required != null) {
            for (String key : required) {
                if (advertised.contains(key)) {
                    grantedRequired.add(key);
                } else {
                    unmet.add(key);
                }
            }
        }

        List<String> grantedOptional = new ArrayList<>();
        List<String> denied = new ArrayList<>();
        if (optional != null) {
            for (String key : optional) {
                if (advertised.contains(key)) {
                    grantedOptional.add(key);
                } else {
                    denied.add(key);
                }
            }
        }

        if (!unmet.isEmpty()) {
            return new Negotiation(false, new ArrayList<>(), denied, unmet,
                    new ArrayList<>(advertised), new JsonObject());
        }

        // granted = grantedRequired ∪ grantedOptional, de-duplicated, insertion order preserved.
        Set<String> grantedSet = new LinkedHashSet<>();
        grantedSet.addAll(grantedRequired);
        grantedSet.addAll(grantedOptional);
        List<String> granted = new ArrayList<>(grantedSet);

        JsonObject grantedDetails = new JsonObject();
        for (String key : granted) {
            if (details.has(key)) {
                grantedDetails.add(key, details.get(key));
            }
        }
        return new Negotiation(true, granted, denied, unmet, new ArrayList<>(advertised), grantedDetails);
    }
}
