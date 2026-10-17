package io.mctest.agent.core.bench;

import io.mctest.agent.core.bench.MacroSource.EditException;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The macro menu (docs/MACROS.md §8): a chest-style screen listing every macro, with its steps on each icon,
 * that a tester drags macros around in, opens one to see and rearrange its steps, and runs or edits it from.
 * Game-free, like {@link MacroRun}: a screen says which icon sits in which slot and what a click does; each
 * loader's shim draws the icons as items in a chest menu and passes the clicks back. Text input (a new step, a
 * name) goes through chat: the screen hands the shim a command to put in front of the player, filled in.
 *
 * <p>A screen is six rows of nine slots: five rows of content (45 slots, {@link MacroLayout#PAGE}), and a row
 * of buttons under them.
 */
public final class MacroMenu {

    /** One line of an icon's text, in a Minecraft colour name ({@code gold}, {@code gray}, …). */
    public record Line(String text, String color) {
    }

    /** What sits in a slot: an item id, its name and tooltip lines, and whether it shimmers. */
    public record Icon(String item, Line name, List<Line> lore, boolean glint) {
    }

    /** A click, as the shim reads it from the client. */
    public enum Click { LEFT, RIGHT, SHIFT, DROP, OUTSIDE }

    /** What a screen needs from the game; the loader shim implements it, one per open menu. */
    public interface Host {
        String who();

        MacroLibrary library();

        MacroEditor editor();

        MacroLayout layout();

        /** The title of the macro this player is running, or null. */
        String running();

        boolean paused();

        void stop();

        void resume();

        /** The last macro this player ran, as its title ({@code give.to who=Carol n=3}), or null. */
        String last();

        void again();

        boolean recording();

        int recorded();

        void startRecording();

        void cancelRecording();

        /** Runs a macro with its defaults: null when it started, else why not. */
        String run(String macro);

        /**
         * Closes the menu and offers {@code command} in chat, filled in, for the player to finish and send.
         *
         * @param reopen whether the menu opens again on the edited macro once the command works.
         */
        void suggest(String prompt, String command, boolean reopen);

        /** Gives the player a book holding the macro to edit: null when given, else why not. */
        String editInBook(String macro);

        /** Shows another screen (after the current click is done). */
        void open(Screen screen);

        void close();

        /** A line in chat: what an action did, or why it couldn't. */
        void tell(String text, boolean error);

        /** How to call a macro on this server: {@code /m } or {@code /macro run }. */
        String runPrefix();
    }

    public abstract static class Screen {
        protected final Host host;

        Screen(Host host) {
            this.host = host;
        }

        public abstract String title();

        public int rows() {
            return 6;
        }

        /** The icon in {@code slot}, or null for an empty slot. */
        public abstract Icon icon(int slot);

        /** What the player is dragging, or null. */
        public Icon carried() {
            return null;
        }

        /** @param slot the slot clicked; ignored for {@link Click#OUTSIDE}. */
        public abstract void click(int slot, Click click);

        /** The menu closed (or another screen replaced it): drop whatever was being dragged. */
        public void closed() {
        }
    }

    private MacroMenu() {
    }

    /** The list of every macro. */
    public static Screen macros(Host host) {
        return new Macros(host);
    }

    /** One macro's steps. */
    public static Screen macro(Host host, String name) {
        return new Steps(host, name, null);
    }

    private static final int BUTTONS = MacroLayout.PAGE;
    private static final String[] COLORS = {"white", "orange", "magenta", "light_blue", "yellow", "lime", "pink",
        "gray", "light_gray", "cyan", "purple", "blue", "brown", "green", "red", "black"};
    private static final int WRAP = 46;
    private static final int STEPS_ON_ICON = 12;

    // --- the list of macros ---

    private static final class Macros extends Screen {
        private int page;
        private String held;
        /** Where the held macro was picked up, or -1 when it was swapped out of a place another took. */
        private int heldFrom = -1;

        Macros(Host host) {
            super(host);
        }

        @Override
        public String title() {
            return "Macros";
        }

        private Map<Integer, String> shown() {
            return host.layout().arrange(new ArrayList<>(host.library().all().keySet()),
                    held == null ? Set.of() : Set.of(held));
        }

        private int pages(Map<Integer, String> shown) {
            return Math.max(MacroLayout.pages(shown), page + 1);
        }

        @Override
        public Icon icon(int slot) {
            Map<Integer, String> shown = shown();
            if (slot < BUTTONS) {
                String name = shown.get(page * MacroLayout.PAGE + slot);
                return name == null ? null : macroIcon(host, name, true);
            }
            int pages = pages(shown);
            switch (slot - BUTTONS) {
                case 0:
                    return page == 0 ? filler() : button("minecraft:arrow", "◀ Previous page", "white",
                            gray("Page " + (page + 1) + " of " + pages));
                case 1:
                    return button("minecraft:writable_book", "New macro", "green",
                            gray("Click, then type its name and parameters"), gray("in chat: area.give who n=1"));
                case 2:
                    if (host.recording()) {
                        return button("minecraft:redstone_block", "● Recording: " + host.recorded() + " commands", "red",
                                hint("Click: save them as a macro"), hint("Right-click: throw them away"));
                    }
                    return button("minecraft:redstone", "Record a macro", "white", gray("Click, then play: the commands"),
                            gray("you type are kept until you save"), gray("them from here or /macro record save"));
                case 3: {
                    String last = host.last();
                    return last == null ? filler() : button("minecraft:repeater", "Run again", "white",
                            new Line(last, "yellow"));
                }
                case 4:
                    return help();
                case 5: {
                    String running = host.running();
                    if (running == null) {
                        return filler();
                    }
                    return host.paused()
                            ? button("minecraft:lime_dye", "⏸ Continue", "green", new Line(running, "yellow"),
                                    hint("Click: go on · Right-click: stop"))
                            : button("minecraft:barrier", "■ Stop", "red", new Line(running, "yellow"));
                }
                case 6:
                    return reloadIcon();
                case 7:
                    return button("minecraft:name_tag", "Arrange by file", "white",
                            gray("Puts every macro back in file order,"), gray("forgetting where you dragged them."),
                            hint("Shift-click to do it"));
                default:
                    return page < pages - 1 || held != null ? button("minecraft:arrow", "Next page ▶", "white",
                            gray("Page " + (page + 1) + " of " + pages)) : filler();
            }
        }

        private Icon help() {
            List<Line> lore = new ArrayList<>();
            lore.add(gray(host.library().all().size() + " macros in " + host.library().folders()));
            lore.add(new Line("", "gray"));
            lore.add(hint("On a macro:"));
            lore.add(gray(" Click: pick it up; click again to put it down"));
            lore.add(gray(" Right-click: open it (its steps, editing)"));
            lore.add(gray(" Shift-click: run it"));
            lore.add(new Line("", "gray"));
            lore.add(gray("/macro opens this; /macro help lists the commands"));
            return new Icon("minecraft:knowledge_book", new Line("Macros", "gold"), lore, false);
        }

        private Icon reloadIcon() {
            List<Line> lore = new ArrayList<>();
            List<Problem> problems = host.library().problems();
            if (problems.isEmpty()) {
                lore.add(gray("No problems in the macro files."));
            }
            for (int i = 0; i < Math.min(8, problems.size()); i++) {
                Problem p = problems.get(i);
                lore.addAll(wrap(p.toString(), p.isError() ? "red" : "yellow"));
            }
            if (problems.size() > 8) {
                lore.add(gray("… and " + (problems.size() - 8) + " more: /macro reload"));
            }
            lore.add(hint("Click: read the files again"));
            return new Icon("minecraft:compass", new Line("Reload", "white"), lore, false);
        }

        @Override
        public Icon carried() {
            return held == null ? null : macroIcon(host, held, true);
        }

        @Override
        public void click(int slot, Click click) {
            if (click == Click.OUTSIDE) {
                drop();
                return;
            }
            Map<Integer, String> shown = shown();
            if (slot < BUTTONS) {
                clickMacro(shown, page * MacroLayout.PAGE + slot, click);
                return;
            }
            int pages = pages(shown);
            switch (slot - BUTTONS) {
                case 0:
                    page = Math.max(0, page - 1);
                    break;
                case 1:
                    host.suggest("Name the new macro, then its parameters", "/macro new ", true);
                    break;
                case 2:
                    if (!host.recording()) {
                        host.startRecording();
                        host.close();
                    } else if (click == Click.RIGHT) {
                        host.cancelRecording();
                    } else {
                        host.suggest("Name the recording", "/macro record save ", false);
                    }
                    break;
                case 3:
                    if (host.last() != null) {
                        host.again();
                        host.close();
                    }
                    break;
                case 5:
                    if (host.running() != null) {
                        if (host.paused() && click != Click.RIGHT) {
                            host.resume();
                        } else {
                            host.stop();
                        }
                    }
                    break;
                case 6:
                    host.library().reload();
                    long errors = host.library().problems().stream().filter(Problem::isError).count();
                    host.tell("Read " + host.library().all().size() + " macros"
                            + (errors == 0 ? "" : "; " + errors + " problem(s): hover Reload"), errors > 0);
                    break;
                case 7:
                    if (click == Click.SHIFT) {
                        host.layout().clear();
                        page = 0;
                    }
                    break;
                case 8:
                    if (page < pages - 1 || held != null) {
                        page++;
                    }
                    break;
                default:
                    break;
            }
        }

        private void clickMacro(Map<Integer, String> shown, int position, Click click) {
            String there = shown.get(position);
            if (held != null) {
                if (click == Click.DROP) {
                    return;
                }
                host.layout().put(shown, held, position);
                held = there;
                heldFrom = -1;
                return;
            }
            if (there == null) {
                return;
            }
            switch (click) {
                case LEFT:
                    host.layout().pin(shown);
                    held = there;
                    heldFrom = position;
                    break;
                case RIGHT:
                    host.open(new Steps(host, there, this));
                    break;
                case SHIFT:
                    runMacro(host, there);
                    break;
                default:
                    break;
            }
        }

        /** Puts the held macro back where it came from, or in the first free place. */
        private void drop() {
            if (held == null) {
                return;
            }
            String name = held;
            held = null;
            Map<Integer, String> shown = host.layout().arrange(new ArrayList<>(host.library().all().keySet()), Set.of(name));
            int to = heldFrom >= 0 && !shown.containsKey(heldFrom) ? heldFrom : 0;
            while (shown.containsKey(to)) {
                to++;
            }
            host.layout().put(shown, name, to);
        }

        @Override
        public void closed() {
            drop();
        }
    }

    // --- one macro's steps ---

    private static final class Steps extends Screen {
        private final String name;
        private final Macros parent;
        private int page;
        /** The index of the step being dragged, or -1. */
        private int held = -1;

        Steps(Host host, String name, Macros parent) {
            super(host);
            Macro m = host.library().get(name);
            this.name = m == null ? name : m.name();
            this.parent = parent;
        }

        @Override
        public String title() {
            return "Macro " + name;
        }

        private List<String> steps() {
            String text = source(host, name);
            if (text == null) {
                return List.of();
            }
            try {
                return MacroSource.steps(text, name);
            } catch (EditException e) {
                return List.of();
            }
        }

        /** The steps on screen: all of them, less the one being dragged (so the others close up). */
        private List<Integer> shown(List<String> steps) {
            List<Integer> out = new ArrayList<>();
            for (int i = 0; i < steps.size(); i++) {
                if (i != held) {
                    out.add(i);
                }
            }
            return out;
        }

        private int pages(int count) {
            return Math.max(1, (count + MacroLayout.PAGE) / MacroLayout.PAGE);
        }

        @Override
        public Icon icon(int slot) {
            List<String> steps = steps();
            if (held >= steps.size()) {
                held = -1;
            }
            List<Integer> shown = shown(steps);
            if (slot < BUTTONS) {
                int k = page * MacroLayout.PAGE + slot;
                return k < shown.size() ? stepIcon(shown.get(k) + 1, steps.get(shown.get(k))) : null;
            }
            Macro m = host.library().get(name);
            switch (slot - BUTTONS) {
                case 0:
                    return button("minecraft:arrow", "◀ All macros", "white");
                case 1: {
                    if (m == null) {
                        return button("minecraft:barrier", name + " is gone", "red", gray("Renamed or deleted?"));
                    }
                    Icon base = macroIcon(host, name, false);
                    List<Line> lore = new ArrayList<>(base.lore());
                    lore.add(hint("Click: rename it or change its parameters"));
                    lore.add(hint("Right-click: change its description"));
                    return new Icon(base.item(), base.name(), lore, base.glint());
                }
                case 2:
                    return button("minecraft:emerald", "▶ Run", "green", m == null ? gray("") : new Line(m.usage(), "yellow"),
                            hint(needs(m).isEmpty() ? "Click: run it" : "Click: run it (fill in " + String.join(", ", needs(m)) + ")"),
                            hint("Right-click: run it with other values"));
                case 3:
                    return button("minecraft:lime_dye", "+ Add a step", "green",
                            gray("Click, then type the step in chat:"),
                            gray("a /command, wait 2s, expect who told \"…\", …"));
                case 4:
                    return button("minecraft:writable_book", "Edit in a book", "white",
                            gray("Gives you a book holding the whole macro."), gray("Edit it, press Done, and it's saved."));
                case 5: {
                    int pages = pages(steps.size());
                    return pages <= 1 ? filler() : button("minecraft:paper", "Page " + (page + 1) + " of " + pages, "white",
                            hint("Click: next · Right-click: previous"));
                }
                case 6:
                    return button("minecraft:map", "Copy", "white", gray("Click, then name the copy in chat"));
                case 7: {
                    String undo = host.editor().undoable(host.who());
                    return undo == null ? filler() : button("minecraft:recovery_compass", "↶ Undo", "white", gray("Undoes: " + undo));
                }
                default:
                    return button("minecraft:lava_bucket", "Delete this macro", "red", gray("Asks first. Undo brings it back."));
            }
        }

        @Override
        public Icon carried() {
            List<String> steps = steps();
            return held < 0 || held >= steps.size() ? null : stepIcon(held + 1, steps.get(held));
        }

        @Override
        public void click(int slot, Click click) {
            if (click == Click.OUTSIDE) {
                held = -1;
                return;
            }
            List<String> steps = steps();
            if (slot < BUTTONS) {
                clickStep(steps, page * MacroLayout.PAGE + slot, click);
                return;
            }
            Macro m = host.library().get(name);
            switch (slot - BUTTONS) {
                case 0:
                    host.open(parent != null ? parent : new Macros(host));
                    break;
                case 1:
                    if (m == null) {
                        break;
                    }
                    try {
                        String text = source(host, name);
                        if (click == Click.RIGHT) {
                            host.suggest("Describe " + name + " (a | starts a new line)", "/macro edit " + name + " describe "
                                    + String.join(" | ", m.description()), true);
                        } else if (text != null) {
                            host.suggest("Change the name or parameters of " + name, "/macro edit " + name + " header "
                                    + MacroSource.header(text, name), true);
                        }
                    } catch (EditException e) {
                        host.tell(e.getMessage(), true);
                    }
                    break;
                case 2:
                    if (m == null) {
                        break;
                    }
                    if (click == Click.RIGHT) {
                        StringBuilder values = new StringBuilder();
                        for (Macro.Param p : m.params()) {
                            values.append(' ').append(p.name()).append('=').append(p.required() ? "" : quote(p.defaultValue()));
                        }
                        host.suggest("Fill in the values for " + name, host.runPrefix() + name + values, false);
                    } else {
                        runMacro(host, name);
                    }
                    break;
                case 3:
                    host.suggest("Type the new last step of " + name, "/macro edit " + name + " add ", true);
                    break;
                case 4: {
                    String why = host.editInBook(name);
                    if (why != null) {
                        host.tell(why, true);
                    }
                    break;
                }
                case 5: {
                    int pages = pages(steps.size());
                    page = click == Click.RIGHT ? (page + pages - 1) % pages : (page + 1) % pages;
                    break;
                }
                case 6:
                    host.suggest("Name the copy of " + name, "/macro copy " + name + " " + name + ".copy", true);
                    break;
                case 7:
                    if (host.editor().undoable(host.who()) != null) {
                        try {
                            host.tell(host.editor().undo(host.who()).message(), false);
                        } catch (EditException e) {
                            host.tell(e.getMessage(), true);
                        }
                    }
                    break;
                default:
                    if (m != null) {
                        host.open(new Confirm(host, name, this));
                    }
                    break;
            }
        }

        private void clickStep(List<String> steps, int k, Click click) {
            List<Integer> shown = shown(steps);
            if (held >= 0) {
                if (click == Click.DROP) {
                    return;
                }
                int from = held + 1;
                int to = Math.min(k + 1, steps.size());
                held = -1;
                if (from != to) {
                    edit(() -> host.editor().moveStep(host.who(), name, from, to));
                }
                return;
            }
            if (k >= shown.size()) {
                if (click == Click.LEFT || click == Click.RIGHT) {
                    host.suggest("Type the new last step of " + name, "/macro edit " + name + " add ", true);
                }
                return;
            }
            int n = shown.get(k) + 1;
            String text = steps.get(shown.get(k));
            switch (click) {
                case LEFT:
                    held = shown.get(k);
                    break;
                case RIGHT:
                    host.suggest("Edit step " + n + " of " + name, "/macro edit " + name + " step " + n + " " + text, true);
                    break;
                case SHIFT:
                    host.suggest("Type the step to put before step " + n + " of " + name,
                            "/macro edit " + name + " insert " + n + " ", true);
                    break;
                case DROP:
                    if (edit(() -> host.editor().removeStep(host.who(), name, n))) {
                        host.tell("Deleted step " + n + ": " + text + " (Undo puts it back)", false);
                    }
                    break;
                default:
                    break;
            }
        }

        @FunctionalInterface
        private interface Edit {
            MacroEditor.Done run() throws EditException;
        }

        private boolean edit(Edit edit) {
            try {
                edit.run();
                return true;
            } catch (EditException e) {
                host.tell(e.getMessage(), true);
                return false;
            }
        }

        @Override
        public void closed() {
            held = -1;
        }
    }

    // --- are you sure? ---

    private static final class Confirm extends Screen {
        private final String name;
        private final Steps back;

        Confirm(Host host, String name, Steps back) {
            super(host);
            this.name = name;
            this.back = back;
        }

        @Override
        public String title() {
            return "Delete " + name + "?";
        }

        @Override
        public int rows() {
            return 3;
        }

        @Override
        public Icon icon(int slot) {
            switch (slot) {
                case 11:
                    return button("minecraft:red_concrete", "Delete " + name, "red", gray("Takes it out of its file."),
                            gray("Undo (in any macro) brings it back."));
                case 13:
                    return host.library().get(name) == null ? null : macroIcon(host, name, false);
                case 15:
                    return button("minecraft:lime_concrete", "Keep it", "green");
                default:
                    return filler();
            }
        }

        @Override
        public void click(int slot, Click click) {
            if (slot == 11) {
                try {
                    host.tell(host.editor().delete(host.who(), name).message(), false);
                } catch (EditException e) {
                    host.tell(e.getMessage(), true);
                }
                host.open(back.parent != null ? back.parent : new Macros(host));
            } else if (slot == 15) {
                host.open(back);
            }
        }
    }

    // --- icons ---

    /** A macro: its parameters, description and steps, so hovering shows what it will run. */
    static Icon macroIcon(Host host, String name, boolean withHints) {
        Macro m = host.library().get(name);
        if (m == null) {
            return button("minecraft:barrier", name, "red", gray("Gone (renamed or deleted?)"));
        }
        List<Line> lore = new ArrayList<>();
        String params = m.usage().substring(m.name().length()).strip();
        if (!params.isEmpty()) {
            lore.add(new Line(params, "yellow"));
        }
        for (String d : m.description()) {
            lore.addAll(wrap(d, "gray"));
        }
        lore.add(new Line("", "gray"));
        String text = source(host, name);
        List<String> steps = List.of();
        try {
            steps = text == null ? List.of() : MacroSource.steps(text, m.name());
        } catch (EditException e) {
            // Shown as no steps; the file has a problem /macro reload names.
        }
        if (steps.isEmpty()) {
            lore.add(new Line("No steps yet", "dark_gray"));
        }
        for (int i = 0; i < Math.min(STEPS_ON_ICON, steps.size()); i++) {
            lore.add(new Line((i + 1) + "  " + cut(steps.get(i), WRAP), "white"));
        }
        if (steps.size() > STEPS_ON_ICON) {
            lore.add(new Line("… and " + (steps.size() - STEPS_ON_ICON) + " more: right-click to see them all", "dark_gray"));
        }
        lore.add(new Line(m.file() + ":" + m.line(), "dark_gray"));
        if (withHints) {
            lore.add(hint("Click: pick up · Right-click: open · Shift-click: run"));
        }
        String running = host.running();
        boolean glint = running != null && (running.equals(m.name()) || running.startsWith(m.name() + " "));
        return new Icon("minecraft:" + color(host, m) + "_shulker_box", new Line(m.name(), "gold"), lore, glint);
    }

    /** One step, its icon saying what kind of step it is. */
    static Icon stepIcon(int n, String text) {
        List<Problem> problems = new ArrayList<>();
        Macro.Step step = MacroParser.step(text, problems);
        String item;
        String what;
        if (step instanceof Macro.Command c) {
            item = c.sameTick() ? "minecraft:chain_command_block" : c.ignoreFailure()
                    ? "minecraft:repeating_command_block" : "minecraft:command_block";
            what = c.sameTick() ? "Runs in the same tick as the step before it" : c.ignoreFailure()
                    ? "Runs as you; carries on if it fails" : "Runs as you; stops the macro if it fails";
        } else if (step instanceof Macro.Wait w) {
            item = "minecraft:clock";
            what = "Waits " + w.shown();
        } else if (step instanceof Macro.WaitFor w && w.expect()) {
            item = "minecraft:target";
            what = "A check, then carries on: is " + w.who() + (w.negate() ? " not" : "") + " told \"" + w.text()
                    + "\" within " + Args.describeTicks(w.ticks()) + "?";
        } else if (step instanceof Macro.WaitFor w) {
            item = "minecraft:spyglass";
            what = "Waits until " + w.who() + " is told \"" + w.text() + "\"; stops the macro after "
                    + Args.describeTicks(w.ticks());
        } else if (step instanceof Macro.Run r) {
            item = "minecraft:shulker_box";
            what = "Runs the macro " + r.macro() + (r.args().isEmpty() ? "" : " with " + r.args());
        } else if (step instanceof Macro.Say) {
            item = "minecraft:oak_sign";
            what = "A note to whoever runs it";
        } else if (step instanceof Macro.Pause) {
            item = "minecraft:bell";
            what = "Waits for you to click [continue]";
        } else {
            item = "minecraft:barrier";
            what = problems.isEmpty() ? "Not a step" : problems.get(0).message();
        }
        List<Line> lore = new ArrayList<>();
        if (text.length() > WRAP) {
            lore.addAll(wrap(text, "gray"));
        }
        lore.addAll(wrap(what, step == null ? "red" : "dark_gray"));
        lore.add(new Line("", "gray"));
        lore.add(hint("Click: pick up, to move it"));
        lore.add(hint("Right-click: edit · Shift-click: add one before it"));
        lore.add(hint("Q: delete it"));
        return new Icon(item, new Line(n + "  " + cut(text, WRAP), "white"), lore, false);
    }

    private static String color(Host host, Macro m) {
        List<String> files = new ArrayList<>();
        for (Macro other : host.library().all().values()) {
            if (!files.contains(other.file())) {
                files.add(other.file());
            }
        }
        return COLORS[Math.max(0, files.indexOf(m.file())) % COLORS.length];
    }

    private static Icon button(String item, String name, String color, Line... lore) {
        return new Icon(item, new Line(name, color), List.of(lore), false);
    }

    private static Icon filler() {
        return new Icon("minecraft:gray_stained_glass_pane", new Line(" ", "gray"), List.of(), false);
    }

    private static Line gray(String text) {
        return new Line(text, "gray");
    }

    private static Line hint(String text) {
        return new Line(text, "dark_aqua");
    }

    private static String cut(String text, int max) {
        return text.length() <= max ? text : text.substring(0, max - 1) + "…";
    }

    static List<Line> wrap(String text, String color) {
        List<Line> out = new ArrayList<>();
        String rest = text;
        while (rest.length() > WRAP) {
            int at = rest.lastIndexOf(' ', WRAP);
            if (at <= 0) {
                at = WRAP;
            }
            out.add(new Line(rest.substring(0, at), color));
            rest = rest.substring(at).stripLeading();
        }
        out.add(new Line(rest, color));
        return out;
    }

    private static String quote(String value) {
        return value.isEmpty() || value.contains(" ") ? '"' + value + '"' : value;
    }

    /** The required parameters a run from the menu can't fill. */
    private static List<String> needs(Macro m) {
        List<String> out = new ArrayList<>();
        if (m != null) {
            for (Macro.Param p : m.params()) {
                if (p.required()) {
                    out.add(p.name());
                }
            }
        }
        return out;
    }

    /** Runs a macro from the menu: at once with its defaults, or through chat when it needs values. */
    private static void runMacro(Host host, String name) {
        Macro m = host.library().get(name);
        if (m == null) {
            return;
        }
        List<String> needs = needs(m);
        if (!needs.isEmpty()) {
            host.suggest("Fill in " + String.join(", ", needs) + " for " + m.name(), host.runPrefix() + m.name() + " ", false);
            return;
        }
        String why = host.run(m.name());
        host.close();
        if (why != null) {
            host.tell(why, true);
        }
    }

    // --- reading files, once per change ---

    private record Cached(long stamp, String text) {
    }

    private static final Map<Path, Cached> SOURCES = new HashMap<>();

    /** The text of the file a macro is in, or null. Cached until the file changes. */
    static String source(Host host, String name) {
        Path file = host.library().path(name);
        if (file == null) {
            return null;
        }
        synchronized (SOURCES) {
            long stamp = file.toFile().lastModified();
            Cached c = SOURCES.get(file);
            if (c != null && c.stamp() == stamp) {
                return c.text();
            }
            try {
                String text = Files.readString(file, StandardCharsets.UTF_8);
                SOURCES.put(file, new Cached(stamp, text));
                return text;
            } catch (IOException e) {
                return null;
            }
        }
    }
}
