package io.mctest.fixture.envstrip;

import net.fabricmc.api.EnvType;
import net.fabricmc.api.Environment;
import net.minecraft.client.MinecraftClient;

/**
 * A common class with one client-only method, the usual pattern in a mod that runs on both sides. On a dedicated
 * server Fabric strips {@link #clientOnly} before the class is defined, so the bytes that run differ from the jar.
 */
public final class Shared {

    private Shared() {
    }

    public static String serverSide(int n) {
        String out = "shared ran with " + n; // coverage marker: shared
        return out;
    }

    @Environment(EnvType.CLIENT)
    public static String clientOnly() {
        return "client " + MinecraftClient.getInstance().getGameVersion();
    }
}
