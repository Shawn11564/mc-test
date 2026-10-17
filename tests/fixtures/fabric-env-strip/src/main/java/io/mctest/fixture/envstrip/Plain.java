package io.mctest.fixture.envstrip;

/** No client-only members: Fabric loads it as built, so its coverage matches the jar (the control). */
public final class Plain {

    private Plain() {
    }

    public static String describe(int n) {
        String out = "plain ran with " + n; // coverage marker: plain
        return out;
    }
}
