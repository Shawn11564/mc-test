package io.mctest.agent.core.bench;

import io.mctest.agent.core.SelectorMatch;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * What each player was recently told (chat, action bar, titles), so a macro can wait for a message instead
 * of sleeping a guessed number of seconds. Every entry gets a sequence number; a check looks only at what
 * arrived after a mark, so an old message can't satisfy a new step. Thread-safe: messages to actors can be
 * sent off the server thread.
 */
public final class ToldLog {

    /** Entries kept per player; a macro only ever looks back a few steps. */
    private static final int KEEP = 200;
    private static final Pattern CAPTURE = Pattern.compile("\\{=([A-Za-z_][A-Za-z0-9_]*)}");

    public record Entry(long seq, String text) {
    }

    private final Map<String, Deque<Entry>> byPlayer = new HashMap<>();
    private long seq;

    public synchronized void record(String who, String text) {
        if (text == null || text.isBlank()) {
            return;
        }
        Deque<Entry> entries = byPlayer.computeIfAbsent(key(who), k -> new ArrayDeque<>());
        entries.addLast(new Entry(++seq, text));
        while (entries.size() > KEEP) {
            entries.removeFirst();
        }
    }

    /** The newest sequence number; a later {@link #find} with it as the mark sees only newer messages. */
    public synchronized long seq() {
        return seq;
    }

    /**
     * The first message to {@code who} after {@code mark} that contains {@code needle}, compared the way the
     * selectors compare text (colour codes stripped, whitespace collapsed, case-folded), or null.
     */
    public synchronized String find(String who, long mark, String needle) {
        String want = SelectorMatch.normalize(needle);
        for (Entry e : entries(who)) {
            if (e.seq() > mark && SelectorMatch.normalize(e.text()).contains(want)) {
                return e.text();
            }
        }
        return null;
    }

    /**
     * Like {@link #find}, but {@code pattern} may hold {@code {=name}} captures, each matching one word:
     * {@code "listed it as #{=listing}"} against "The bank has listed it as #12." gives {@code listing=12}.
     * Colour codes are ignored, whitespace is collapsed and case doesn't matter.
     *
     * @return the captured values (empty when there were none to capture), or null when nothing matched.
     */
    public synchronized Map<String, String> match(String who, long mark, String pattern) {
        List<String> names = new ArrayList<>();
        Pattern regex = compile(pattern, names);
        for (Entry e : entries(who)) {
            if (e.seq() <= mark) {
                continue;
            }
            Matcher m = regex.matcher(clean(e.text()));
            if (m.find()) {
                Map<String, String> out = new LinkedHashMap<>();
                for (int i = 0; i < names.size(); i++) {
                    out.put(names.get(i), m.group(i + 1).replaceAll("[.,;:!?)\\]]+$", ""));
                }
                return out;
            }
        }
        return null;
    }

    /** The names a {@link #match} pattern captures. */
    public static List<String> captures(String pattern) {
        List<String> out = new ArrayList<>();
        Matcher m = CAPTURE.matcher(pattern);
        while (m.find()) {
            out.add(m.group(1));
        }
        return out;
    }

    private static Pattern compile(String pattern, List<String> names) {
        StringBuilder regex = new StringBuilder();
        Matcher m = CAPTURE.matcher(pattern);
        int at = 0;
        while (m.find()) {
            regex.append(literal(pattern.substring(at, m.start())));
            names.add(m.group(1));
            boolean last = m.end() >= pattern.length();
            regex.append(last ? "(\\S+)" : "(\\S+?)");
            at = m.end();
        }
        regex.append(literal(pattern.substring(at)));
        return Pattern.compile(regex.toString(), Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);
    }

    private static String literal(String text) {
        StringBuilder out = new StringBuilder();
        String[] words = text.split("\\s+", -1);
        for (int i = 0; i < words.length; i++) {
            if (i > 0) {
                out.append("\\s+");
            }
            if (!words[i].isEmpty()) {
                out.append(Pattern.quote(words[i]));
            }
        }
        return out.toString();
    }

    private static String clean(String text) {
        return text.replaceAll("§.", "").replaceAll("\\s+", " ").strip();
    }

    /** Every kept message to {@code who} after {@code mark}, oldest first: the evidence a judge reads. */
    public synchronized List<Entry> entriesAfter(String who, long mark) {
        List<Entry> out = new ArrayList<>();
        for (Entry e : entries(who)) {
            if (e.seq() > mark) {
                out.add(e);
            }
        }
        return out;
    }

    /** Up to {@code max} of the newest messages to {@code who} after {@code mark}, oldest first. */
    public synchronized List<String> since(String who, long mark, int max) {
        List<String> out = new ArrayList<>();
        Iterator<Entry> it = entries(who).descendingIterator();
        while (it.hasNext() && out.size() < max) {
            Entry e = it.next();
            if (e.seq() <= mark) {
                break;
            }
            out.add(0, e.text());
        }
        return out;
    }

    private Deque<Entry> entries(String who) {
        Deque<Entry> entries = byPlayer.get(key(who));
        return entries != null ? entries : new ArrayDeque<>();
    }

    private static String key(String who) {
        return who.toLowerCase(Locale.ROOT);
    }
}
