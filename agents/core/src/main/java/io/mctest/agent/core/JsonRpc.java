package io.mctest.agent.core;

import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

/**
 * JSON-RPC 2.0 envelope helpers (PROTOCOL.md §3). MCTP uses exactly four shapes: request, success
 * response, error response, and event notification. One envelope per WebSocket text frame.
 */
public final class JsonRpc {

    public static final String VERSION = "2.0";

    private JsonRpc() {
    }

    /** Parses a single text frame into an envelope object, or throws on invalid JSON / non-object. */
    public static JsonObject parse(String frame) throws McTestException {
        JsonElement el;
        try {
            el = JsonParser.parseString(frame);
        } catch (RuntimeException e) {
            throw new McTestException(Errors.PARSE_ERROR, Errors.REASON_PARSE_ERROR, "Invalid JSON");
        }
        if (el == null || !el.isJsonObject()) {
            throw new McTestException(Errors.INVALID_REQUEST, Errors.REASON_INVALID_REQUEST,
                    "Envelope is not a JSON object");
        }
        return el.getAsJsonObject();
    }

    /** Builds a request envelope (client→agent). */
    public static JsonObject request(JsonElement id, String method, JsonObject params) {
        JsonObject o = new JsonObject();
        o.addProperty("jsonrpc", VERSION);
        o.add("id", id != null ? id : JsonNull.INSTANCE);
        o.addProperty("method", method);
        if (params != null) {
            o.add("params", params);
        }
        return o;
    }

    /** Builds a success response echoing {@code id} (PROTOCOL.md §3.3). */
    public static JsonObject success(JsonElement id, JsonObject result) {
        JsonObject o = new JsonObject();
        o.addProperty("jsonrpc", VERSION);
        o.add("id", id != null ? id : JsonNull.INSTANCE);
        o.add("result", result != null ? result : new JsonObject());
        return o;
    }

    /** Builds an error response echoing {@code id} from a typed exception (PROTOCOL.md §3.4). */
    public static JsonObject error(JsonElement id, McTestException ex) {
        return error(id, ex.code, ex.getMessage(), ex.data);
    }

    /** Builds an error response echoing {@code id} (PROTOCOL.md §3.4). */
    public static JsonObject error(JsonElement id, int code, String message, JsonObject data) {
        JsonObject err = new JsonObject();
        err.addProperty("code", code);
        err.addProperty("message", message != null ? message : "");
        if (data != null) {
            err.add("data", data);
        }
        JsonObject o = new JsonObject();
        o.addProperty("jsonrpc", VERSION);
        o.add("id", id != null ? id : JsonNull.INSTANCE);
        o.add("error", err);
        return o;
    }

    /** Builds an event notification (no {@code id}; method namespaced {@code event.*}, §3.6). */
    public static JsonObject notification(String method, JsonObject params) {
        JsonObject o = new JsonObject();
        o.addProperty("jsonrpc", VERSION);
        o.addProperty("method", method);
        if (params != null) {
            o.add("params", params);
        }
        return o;
    }
}
