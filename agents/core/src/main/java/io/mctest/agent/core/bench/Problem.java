package io.mctest.agent.core.bench;

/** Something wrong in a macro file or a test guide, located well enough to fix in one jump. */
public record Problem(Severity severity, String file, int line, String message) {

    public enum Severity { ERROR, WARNING }

    public static Problem error(String file, int line, String message) {
        return new Problem(Severity.ERROR, file, line, message);
    }

    public static Problem warning(String file, int line, String message) {
        return new Problem(Severity.WARNING, file, line, message);
    }

    public boolean isError() {
        return severity == Severity.ERROR;
    }

    /** {@code playtest/macros/org.macro:12: error: ...}, the shape editors and terminals link. */
    @Override
    public String toString() {
        return file + ":" + line + ": " + (isError() ? "error" : "warning") + ": " + message;
    }
}
