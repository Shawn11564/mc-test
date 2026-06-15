# SELECTORS.md — Semantic Selector Grammar for MCTP

Status: normative (v1). Part of the mc-test design doc set under `/docs`.
Sibling contracts: `PROTOCOL.md` (MCTP JSON-RPC methods + capability negotiation),
`CAPABILITIES.md` (capability keys), `ARCHITECTURE.md` (narrow-waist overview).

> **One job of this document:** define the *single, version-independent* way a test
> names a UI element ("the Regions button", "the TestRegion entry"), and the
> *per-driver resolution rules* that turn that name into a real click on a real
> target — whether the target is a Bukkit inventory slot, a Fabric `ClickableWidget`,
> or a rectangle of pixels under OCR.
>
> Selectors are **data, not code**. They are emitted by the authoring layer, travel
> verbatim inside MCTP `params.selector`, and are resolved *inside the thin agent /
> driver*. All selector *intelligence* (normalization, fuzzy matching, scoring,
> ret/ disambiguation) is specified here and implemented in version-independent
> runner/driver code — **never** baked into the in-game agent. The agent only
> returns raw element descriptors; the runner-side resolver applies this grammar.

---

## 0. Where selectors live in MCTP

A selector is the value of the `selector` field inside the `params` of the
element-facing MCTP methods. The methods and the selector **key set** are defined in
`PROTOCOL.md` (the single source of truth for the wire contract); this document
owns the selector **grammar, normalization, fuzzy-matching, and resolver contract**
that give those keys meaning. The element-facing methods are:

| MCTP method            | `params.selector` | Returns |
|------------------------|-------------------|---------|
| `screen.listElements`  | optional (filter) | array of `Element` descriptors that match (or all, if omitted) |
| `screen.clickElement`  | required          | the resolved `Element` that was clicked, plus `matchInfo` |
| `screen.typeText`      | required (target) | the `Element` that received focus + text |

> **Single-element get** = `screen.listElements` with a selector that resolves to a unique survivor (the runner takes the one remaining match — there is no `getElement` wire method). **Waiting** for an element = `screen.waitForScreen`, or a runner-side re-poll of `screen.listElements` until a unique match appears (there is no `waitForElement` wire method).

`screen.pressKey`, `screen.screenshot`, `screen.get`, `truth.getWorldBlock`,
`truth.getEntities`, `truth.assertPluginState`, `fixture.set`, `player.spawnFake`
do **not** take selectors (they are screen-, world-, or state-scoped, not
element-scoped).

### 0.1 Request shape (canonical, must match PROTOCOL.md)

```jsonc
// screen.clickElement — "click the Regions button"
{
  "jsonrpc": "2.0",
  "id": 42,
  "method": "screen.clickElement",
  "params": {
    "sessionId": "s-7f3a",
    "selector": { "label": "Regions" },
    "options": {                      // optional; see §6
      "button": "left",               // left | right | middle  (default left)
      "timeoutMs": 5000,              // wait-for-match budget (default 5000)
      "expectMatchCount": 1,          // assert exactly N matches before acting
      "ifMultiple": "fail"            // fail | first | nth (default fail)
    }
  }
}
```

### 0.2 Response shape (canonical)

```jsonc
{
  "jsonrpc": "2.0",
  "id": 42,
  "result": {
    "element": {                      // the resolved Element (see §7)
      "ref": "slot:13",               // driver-native handle (opaque to runner)
      "label": "Regions",
      "rawLabel": "§a§lRegions",
      "text": "Regions",
      "lore": ["§7Manage protected areas"],
      "itemType": "minecraft:writable_book",
      "role": "button",
      "index": 4,
      "testId": "or.menu.regions",
      "bounds": { "x": 62, "y": 35, "w": 18, "h": 18 },  // driver-dependent
      "screenId": "or.main"
    },
    "matchInfo": {
      "matchedKeys": ["label"],
      "score": 1.0,                   // 0..1, see §4.4
      "candidateCount": 1,
      "strategy": "exact-after-normalize"
    }
  }
}
```

`screen.listElements` returns `result.elements` (array of the same `Element` objects) plus
`result.matchInfo[]` (parallel array) when a selector filter was supplied.

---

## 1. Selector grammar

A selector is a **JSON object** whose keys are *predicates* that are **AND-ed**
together. An element matches a selector iff it satisfies **every** present key. This
keeps the wire shape flat, diffable, and language-neutral (no DSL to parse in 6
loaders).

```
Selector      := { Predicate* , Scope? , Disambiguator? }
Predicate     := label | textContains | loreContains | itemType | role | testId
Scope         := within
Disambiguator := index | nth      (index and nth are aliases — see §3.5)
```

### 1.1 Predicate keys (the eight required keys)

| Key             | JSON type            | Meaning | Match semantics |
|-----------------|----------------------|---------|-----------------|
| `label`         | string               | The element's primary display name / title. | Equality **after normalization** (§4); falls back to fuzzy (§4.4). |
| `textContains`  | string               | A substring that must appear in the element's visible text (label *or* body). | Normalized substring containment. |
| `loreContains`  | string               | A substring that must appear in any **lore line** (item tooltip) / secondary text line. | Normalized substring containment over the joined lore. |
| `itemType`      | string               | The backing item / icon type. | Namespaced-id equality (§4.5); accepts legacy ids via alias table. |
| `role`          | string (enum §3.4)   | Semantic role of the widget. | Equality against the driver's role mapping. |
| `index` / `nth` | integer (0-based)    | Pick the Nth element **among the matches** of the other predicates. | Post-filter ordinal (§3.5). |
| `within`        | Selector (nested)    | Restrict the search to descendants/contents of a container element. | Resolve container first, then search inside it (§3.6). |
| `testId`        | string               | An invisible, test-only stable id injected by SUTs we control. | Exact equality, **no normalization** (§5). |

> **Authoring rule of thumb:** prefer `testId` (most robust) → `role`+`label` →
> `label` → `textContains`/`loreContains` (last resort, brittle to copy edits).

### 1.2 Combination examples (canonical regions plugin)

```jsonc
{ "label": "Regions" }                                  // the Regions button on the /or main menu
{ "label": "TestRegion" }                               // the TestRegion entry in the regions list
{ "testId": "or.menu.regions" }                         // same button, injected-id form (most robust)
{ "role": "button", "label": "Regions" }                // button specifically (ignore a same-named label)
{ "textContains": "Region", "role": "listItem" }      // any region row containing "Region"
{ "loreContains": "Owner: Notch" }                     // the region owned by Notch
{ "itemType": "minecraft:writable_book", "label": "Regions" }  // disambiguate by icon
{ "within": { "testId": "or.list.regions" }, "label": "TestRegion" } // TestRegion *inside* the list panel
{ "role": "listItem", "nth": 0 }                       // the first region row, whatever it is named
```

### 1.3 String predicate sugar (authoring-only; normalized to objects before the wire)

For ergonomics in YAML/fluent code, a **bare string** is accepted by the authoring
layer and **expanded to `{ "label": <string> }`** before it is placed on the wire.
The agent/driver only ever sees the object form.

```yaml
# YAML step file — both lines are identical on the wire
- click: "Regions"
- click: { label: "Regions" }
```

If the bare string begins with the sentinel `#`, it expands to `testId` instead:

```yaml
- click: "#or.menu.regions"   # ->  { "testId": "or.menu.regions" }
```

---

## 2. Resolution algorithm (runner-side, driver-agnostic)

Every driver implements `resolve(selector, screen) -> Match[]` by calling the
agent's `screen.listElements` primitive **once** to obtain raw `Element` descriptors, then
applying the **shared resolver** below. The agent never scores; the runner does.

```
resolve(selector, candidates):
  1. NORMALIZE  every candidate's text fields and every string predicate (§4.1–4.3).
  2. FILTER     keep candidate c iff for every predicate p in selector:
                   matchesPredicate(p, c)  (§3)
                If `within` is present, first resolve the container, then restrict
                `candidates` to that container's children (§3.6) before step 2.
  3. SCORE      assign each surviving candidate a score in [0,1] (§4.4).
  4. ORDER      stable-sort by (score desc, document-order asc).
  5. DISAMBIGUATE
                If `index`/`nth` present -> take that ordinal (error if out of range).
                Else if exactly one survivor -> return it.
                Else (multiple) -> apply `options.ifMultiple` (§6):
                   "fail" (default) -> AMBIGUOUS_MATCH error listing candidates
                   "first"          -> top-ranked survivor
                   "nth"            -> requires options.nth
  6. RETURN     Match{ element, score, matchedKeys, strategy, candidateCount }.
```

`screen.clickElement` then calls the agent primitive `clickElement(ref)` with the winning
`element.ref`. The two-phase split (list → score in runner → click by ref) is what
keeps the agent dumb and version-specific code minimal.

### 2.1 Waiting / retry

A runner-side wait (via `screen.waitForScreen`, or by re-polling `screen.listElements`)
and `screen.clickElement` with `options.timeoutMs > 0` re-run `resolve`
on a fixed cadence (default **200 ms**) until a unique match appears or the budget
expires. Retry/backoff is **runner-side** — agents expose only the instantaneous
`screen.listElements`. On timeout the error is `-32000` ELEMENT_NOT_FOUND
(`data.reason: "NO_MATCH"`, §9) with the last candidate set attached for debugging.

---

## 3. Per-predicate matching rules

### 3.1 `label`
- Compare `normalize(selector.label)` to `normalize(candidate.label)`.
- `candidate.label` is the driver's notion of "primary name" (§7: `label`).
- Match tiers, tried in order, first hit wins and sets `strategy`:
  1. `exact-after-normalize` — normalized equality. score `1.0`.
  2. `case-insensitive` — already covered by normalization (lowercasing), folded in.
  3. `fuzzy` — only if `options.fuzzy !== false` and similarity ≥ threshold (§4.4).
     score = similarity.

### 3.2 `textContains`
- Let `hay = normalize(candidate.label + "\n" + candidate.bodyText)`.
- Match iff `hay.includes(normalize(selector["textContains"]))`.
- `bodyText` = concatenated visible text of the widget that is **not** lore
  (e.g., a multi-line description label, a button's secondary line).

### 3.3 `loreContains`
- Let `lore = normalize(candidate.lore.join("\n"))`.
- Match iff `lore.includes(normalize(selector["loreContains"]))`.
- For the bot driver, `lore` is the item's tooltip lines (NBT `display.Lore` /
  the 1.20.5+ `minecraft:lore` data component). For the mod driver, `lore` is the
  tooltip lines of the hovered widget / item stack. For pixel, `lore` is empty
  unless OCR of a tooltip overlay was requested (rarely available).

### 3.4 `role`
- `role` is an **enum**. Compare `selector.role` to `candidate.role` for equality.
- The role enum is **defined in `PROTOCOL.md`** (selector keys); the members are
  `button | slot | label | input | tab | list | listItem`. This section specifies
  only how each driver maps its native widget classes onto those members:

  | role          | Bot meaning                              | Mod meaning (vanilla widget class)            |
  |---------------|------------------------------------------|-----------------------------------------------|
  | `button`      | clickable inventory item that triggers an action | `ButtonWidget` / `PressableWidget` |
  | `listItem`    | a row/entry in a paginated GUI list      | `*ListWidget$Entry` / `AlwaysSelectedEntryListWidget` child |
  | `list`        | the paginated list/container itself      | `*ListWidget` / `AlwaysSelectedEntryListWidget` |
  | `slot`        | an inventory slot (named or empty)       | `Slot` in a `HandledScreen` |
  | `input`       | anvil rename field                       | `TextFieldWidget` / `EditBox` |
  | `tab`         | category icon switching sub-pages        | tab button in a `TabNavigationWidget` |
  | `label`       | non-interactive named item (filler/title)| non-interactive `TextWidget` / drawn string |

- A driver that cannot determine a role **omits** `role` (leaves `Element.role`
  null) rather than emitting an out-of-enum value; a selector asking for a specific
  role then **does not match** a role-less candidate (use `label` alone if unsure).

### 3.5 `index` / `nth`
- `index` and `nth` are **exact aliases**; if both are present they must be equal or
  the resolver raises `INVALID_SELECTOR`. Prefer `nth` in authoring; `index` exists
  for parity with WebDriver-style code.
- **0-based**, applied **after** filtering+ordering (§2 step 5), i.e. it selects the
  Nth element *among the matches*, not the Nth element on the screen.
- Negative values index from the end (`nth: -1` = last match).
- Out of range -> `INDEX_OUT_OF_RANGE` error with `candidateCount`.

```jsonc
// "the 2nd region row whose name contains 'Test'"
{ "role": "listItem", "textContains": "Test", "nth": 1 }
```

### 3.6 `within` (scoping)
- `within` is a **nested selector** identifying a *container* element. Resolution:
  1. Resolve `within` to exactly one element (same algorithm; ambiguity here is a
     hard `AMBIGUOUS_MATCH` — a scope must be unique).
  2. Replace the candidate set with that container's **children** (driver-defined:
     bot = items in that sub-inventory/page; mod = `screen.children()` subtree of
     the container widget; pixel = elements whose bounds are inside the container's
     bounds).
  3. Apply the remaining predicates within that reduced set.
- `within` may nest arbitrarily (`within.within…`); each level must resolve uniquely.

```jsonc
// TestRegion, but only inside the regions list panel (not, e.g., a same-named tab)
{ "within": { "testId": "or.list.regions" }, "label": "TestRegion" }
```

---

## 4. Normalization & fuzzy matching

Normalization makes selectors robust to Minecraft's pervasive formatting codes,
casing, and whitespace noise. It is applied **identically** to both sides
(selector predicate and candidate field) before comparison, **except** for
`testId` and `itemType` (see §4.5, §5).

### 4.1 `normalize(s)` — the canonical pipeline

Applied in this exact order:

1. **Resolve to plain text.** If the source is a Minecraft `Text`/`Component`
   (mod driver) or a JSON chat component (bot driver), flatten to a string by
   concatenating all `text`/`extra` segments in order. Translatable components
   (`{"translate": "..."}`) are resolved against the agent's active language
   (en_us by default) *before* this step; if no translation is available the
   `translate` key string is used verbatim.
2. **Strip legacy color/format codes.** Remove every `§<hex-or-k..r>` sequence
   (the section sign `§` / U+00A7 followed by one of `0-9a-fk-or`). Also strip the
   ampersand form `&<code>` **only** when the field is known to be legacy-coded
   (bot display names frequently are). Regex: `/[§&][0-9A-FK-ORa-fk-or]/g`.
3. **Strip modern formatting artifacts.** Remove zero-width chars
   (`U+200B`, `U+200C`, `U+200D`, `U+FEFF`) used by some plugins as spacing hacks.
4. **Unicode normalize.** Apply NFKC so visually identical glyphs compare equal.
5. **Collapse whitespace.** Replace any run of Unicode whitespace with a single
   ASCII space; then `trim()`.
6. **Case fold.** Lowercase using locale-independent `toLowerCase()` (en_us).

The result is the **normalized form**. Comparisons (`label` equality,
`*-contains` containment) operate on normalized forms.

```
normalize("§a§lRegions ")          -> "regions"
normalize("§7TestRegion§r")        -> "testregion"
normalize("&eClick to open")       -> "click to open"     // legacy-coded field
normalize("Test​Region")      -> "testregion"
normalize("  Regions   List  ")    -> "regions list"
```

> **Display vs. compare:** the resolver keeps BOTH forms on every `Element`:
> `rawLabel` (untouched, for screenshots/reports/debugging) and `label`
> (the human-visible-but-uncolored string) and compares against the *normalized*
> projection of `label`. Reports show `rawLabel`; matching uses `normalize(label)`.

### 4.2 What normalization deliberately does NOT do
- It does not stem, lemmatize, or translate synonyms ("Region" ≠ "Area").
- It does not strip punctuation (so `"Owner: Notch"` keeps the colon).
- It does not transliterate non-Latin scripts beyond NFKC.

### 4.3 Where each form is used

| Field on the wire        | Stored as            | Compared as          |
|--------------------------|----------------------|----------------------|
| `selector.label` etc.    | as authored          | `normalize(value)`   |
| `Element.rawLabel`       | exact runtime string | (never compared)     |
| `Element.label`          | color-stripped string| `normalize(label)`   |
| `Element.lore[]`         | color-stripped lines | `normalize(join)`    |
| `selector.testId`/`.itemType` | as authored     | **exact** (no normalize) |

### 4.4 Fuzzy matching (label only, opt-out)

Used **only** for `label` and **only** when exact-after-normalize fails (and
`options.fuzzy !== false`). Algorithm:

- similarity `= 1 - (levenshtein(a, b) / max(len(a), len(b)))` over normalized
  strings, where `a`,`b` are the normalized selector label and candidate label.
- A candidate is a fuzzy match iff `similarity ≥ options.fuzzyThreshold`
  (**default 0.82**).
- Fuzzy matches set `strategy = "fuzzy"` and `score = similarity`. An exact match
  always outranks any fuzzy match (exact = `1.0`).
- Fuzzy never applies to `textContains`, `loreContains`, `role`, `itemType`,
  `testId`, or `index` — those are deterministic by design.

Rationale: tolerates trailing-space / one-character drift (e.g. a plugin renames
`"Regions"` → `"Regions "` or `"Regions:"`) without silently matching the wrong
button. Tighten with `options.fuzzyThreshold: 1` (or `options.fuzzy: false`) in CI
for strict, deterministic runs.

### 4.5 `itemType` matching
- Compared as a **namespaced identifier**, case-insensitively, but **not** through
  the §4.1 text pipeline (no color stripping / whitespace collapse beyond trim).
- A bare path (`"writable_book"`) is treated as `"minecraft:writable_book"`.
- **Legacy/version drift** is bridged by the per-version alias table the agent
  ships (the per-version tax lives in the agent, per the prime directives). The
  runner asks the agent's `session.describe` for `itemAliasTableVersion` and expects
  the agent to have already mapped numeric ids / pre-flattening names
  (`"35:14"`, `"WOOL"`) to modern namespaced ids in the `Element.itemType` it
  returns. Selectors therefore always speak **modern Mojang ids**; the agent
  normalizes the runtime value to that id before returning it.

---

## 5. `testId` injection convention (SUTs we control)

When the system-under-test is authored by us (the canonical `regions` example, or
any cooperating plugin/mod), it **SHOULD** stamp UI elements with an invisible,
test-only identifier. `testId` is then the most robust selector — immune to
renames, translations, recoloring, and reordering.

### 5.1 Namespace & format
- `testId` is a dotted, lowercase, ASCII string: `^[a-z0-9]+(\.[a-z0-9_-]+)+$`.
- Convention: `<plugin>.<screen>.<element>`, e.g.
  - `or.menu.regions` — the **Regions** button on the `/or` main menu.
  - `or.list.regions` — the regions **list panel/container**.
  - `or.region.testregion` — the **TestRegion** row inside that list.
- It is compared **exactly** (no normalization). It is never shown to players.

### 5.2 How a SUT injects it

**A. Inventory-GUI (Bukkit/Spigot/Paper plugin — read by the BOT driver and the
server agent).** Stamp the `ItemStack` that backs the slot. Two carriers, both
read by the agent; the agent prefers the data component on 1.20.5+ and falls back
to NBT/PDC on older servers:

- *Modern (MC ≥ 1.20.5, data components):* set our custom data component carrier
  (`mc-test:test_id`):
  ```
  mc-test:test_id → "or.menu.regions"
  ```
- *Legacy (MC ≤ 1.20.4, NBT):* set our custom NBT carrier key (`mctp:testId`) on
  the stack:
  ```
  tag: { "mctp:testId": "or.menu.regions" }
  ```
- *Plugin-portable (any version):* additionally set a Bukkit
  **PersistentDataContainer** key on the item meta, which the **server agent**
  reads directly without NBT spelunking:
  ```
  PDC key  = NamespacedKey("mc-test", "test_id")
  PDC type = STRING
  PDC value= "or.menu.regions"
  ```
  Helper the SUT calls:
  ```java
  // mc-test ships this as a tiny optional compile-time helper (no runtime dep).
  ItemMeta m = stack.getItemMeta();
  m.getPersistentDataContainer().set(
      new NamespacedKey("mc-test", "test_id"),
      PersistentDataType.STRING, "or.menu.regions");
  stack.setItemMeta(m);
  ```

**B. Client Screen widgets (Fabric/Forge/NeoForge/Quilt mod GUI — read by the
IN-PROCESS mod driver).** Vanilla `ClickableWidget` has no user-data slot, so the
SUT mod tags widgets through a tiny mixin/interface that mc-test publishes:

- The agent core defines an interface `McTestTaggable { String mctp$testId(); void mctp$setTestId(String); }`
  and mixes it into `net.minecraft.client.gui.widget.ClickableWidget` (Yarn names;
  the agent's per-loader shim maps to MCP/Mojmap). A cooperating SUT mod calls:
  ```java
  ((McTestTaggable) regionsButton).mctp$setTestId("or.menu.regions");
  ```
- If the SUT cannot depend on our interface, it MAY instead encode the id in the
  widget's **accessibility/narration message** using a sentinel suffix the agent
  strips before display:
  ```
  widget.setMessage(Text.literal("Regions"));
  widget.setTooltip(Tooltip.of(Text.literal("​​mctp:or.menu.regions")));
  ```
  The agent recognizes a tooltip/narration line matching `^​​mctp:(\S+)$`,
  extracts the `testId`, and **omits that line** from `Element.lore`/narration so it
  never affects `loreContains` or appears in reports.

**C. Server-side / world state (Bukkit plugin or server-mod — read by the SERVER
agent).** For non-GUI assertions (`assertPluginState`), the SUT exposes region
identity directly; `testId` there is just the region key the plugin already uses
(`"TestRegion"`), surfaced via the agent's plugin-state bridge — no injection
needed because the server agent reads authoritative plugin data structures.

### 5.3 How each driver READS `testId`

| Driver        | Source of truth for `testId` |
|---------------|------------------------------|
| Bot (headless)| Reads the slot `ItemStack` it already receives over the protocol; the **server agent** enriches each slot's `Element` with `testId` pulled from PDC/NBT/data-component (bot alone can see NBT/components of window items via packets; server agent is authoritative). |
| In-process mod| Casts each `ClickableWidget` to `McTestTaggable` and calls `mctp$testId()`; falls back to the `​​mctp:` tooltip sentinel. |
| Pixel/OCR     | **Cannot** read `testId` (no DOM). Selectors using `testId` are *unsupported* on the pixel driver → the runner SKIPS with reason `selector testId requires capability testIdTags` (capability negotiation, §8). |

### 5.4 Reading rule (normative)
A driver MUST populate `Element.testId` when it can read the tag, and MUST NOT
fabricate or guess it. Absence means "no test id available", which only fails a
selector that *requires* `testId`.

---

## 6. `options` (action-time modifiers, not predicates)

`options` live beside `selector` in the request `params`, not inside the selector,
because they affect *how we act/wait*, not *what matches*.

| Option             | Type / default        | Effect |
|--------------------|-----------------------|--------|
| `button`           | enum `left`/`right`/`middle`, def `left` | mouse button for `clickElement`. |
| `timeoutMs`        | int, def `5000`       | wait-for-match budget (§2.1). `0` = single shot. |
| `pollMs`           | int, def `200`        | re-resolve cadence while waiting. |
| `expectMatchCount` | int, optional         | assert exactly this many candidates survive filtering; else `MATCH_COUNT_MISMATCH`. |
| `ifMultiple`       | enum `fail`/`first`/`nth`, def `fail` | tie-break policy (§2 step 5). |
| `nth`              | int                   | required when `ifMultiple:"nth"`; same semantics as selector `nth`. |
| `fuzzy`            | bool, def `true`      | enable/disable fuzzy `label` matching (§4.4). |
| `fuzzyThreshold`   | float, def `0.82`     | min similarity for a fuzzy `label` match. |
| `scrollIntoView`   | bool, def `true`      | mod/pixel: scroll a paginated list to bring a matched off-screen `listItem` into view before clicking; bot: page the GUI (next-page item) to find the slot. |

---

## 7. The `Element` descriptor (what `screen.listElements` returns)

Every driver returns elements in this **shared shape**; per-driver fields that don't
apply are `null`/omitted. This is the only element representation that crosses the
protocol; the runner-side resolver consumes exactly these fields.

```jsonc
{
  "ref":      "slot:13",            // REQUIRED. Opaque driver handle for clickElement(ref).
                                    //   bot:"slot:<n>"  mod:"widget:<path>"  pixel:"rect:<id>"
  "label":    "Regions",            // color-stripped primary name (compared via normalize)
  "rawLabel": "§a§lRegions",        // untouched runtime string (reports/screenshots)
  "text":     "Regions",            // alias of label for non-item widgets; = label when same
  "bodyText": "",                   // non-lore secondary visible text (for textContains)
  "lore":     ["§7Manage protected areas"],  // color-stripped tooltip/secondary lines
  "itemType": "minecraft:writable_book",     // modern namespaced id (alias-normalized by agent)
  "role":     "button",             // enum from §3.4
  "index":    4,                    // document order within the current screen/container
  "testId":   "or.menu.regions",    // null unless the driver could read an injected id (§5)
  "bounds":   { "x": 62, "y": 35, "w": 18, "h": 18 },  // pixel/mod only; null for bot
  "screenId": "or.main",            // logical screen id (from screen.get), for cross-checks
  "enabled":  true,                 // false = greyed/disabled; disabled still matches but click errors
  "visible":  true                  // false = off-screen/scrolled-away (see options.scrollIntoView)
}
```

Field provenance per driver is in the resolution table (§8).

---

## 8. Per-driver RESOLUTION TABLE

This is the heart of the doc: for each selector key, how each driver finds the
element. "Source" = where the candidate field comes from; matching itself is the
shared algorithm of §2–§4 in all cases (drivers differ only in *how they populate
`Element`*, never in how scoring works).

### 8.1 Bot driver — `driver-headless` (Mineflayer + minecraft-data, via the server agent)

Sees **inventory/chest GUIs** (window items) only. No client Screens.

| Selector key    | How the bot resolves it |
|-----------------|--------------------------|
| `label`         | `Element.label` = color-stripped display name of the slot's `ItemStack` (`display.Name` NBT / `minecraft:custom_name` component). Normalize + compare (§4.1). |
| `textContains`  | Substring over normalized `label` (+ `bodyText`, usually empty for items). |
| `loreContains`  | Substring over normalized join of the item's lore lines (`display.Lore` / `minecraft:lore` component). |
| `itemType`      | `Element.itemType` = the stack's material id; the **server agent** maps legacy/numeric ids to modern Mojang ids before sending (§4.5). |
| `role`          | Heuristic from the GUI: clickable named item in an action menu → `button`; row inside a paginated list inventory → `listItem`; the list inventory itself → `list`; a plain inventory slot → `slot`; anvil input → `input`; unnamed filler glass → `label`. Indeterminate → `role` omitted. |
| `index`/`nth`   | Document order = ascending **slot index** within the open window; ordinal applied post-filter. |
| `within`        | Container = a sub-region/page of the inventory (e.g., the "Regions" sub-menu opened by a prior click), or the open window itself; children = its slots. Multi-page lists are paged via the next-page control when `scrollIntoView`. |
| `testId`        | Read by the **server agent** from the item's PDC/component `mc-test:test_id` / NBT `mctp:testId`; attached to `Element.testId` (§5.3). |
| `ref` (action)  | `"slot:<n>"`; `clickElement(ref)` issues a window-click packet on slot `n` (left/right/middle per `options.button`). |

> Worked: `{ "label": "Regions" }` → agent sends window items for the `/or` GUI →
> bot finds the slot whose normalized name is `"regions"` → `ref:"slot:13"` →
> click → server agent confirms via `assertPluginState` that the next window opened.

### 8.2 In-process mod driver — `driver-inprocess` (Fabric/Forge/NeoForge/Quilt client agent)

Sees the **real client Screen tree**. The only driver that can test rendered mod
GUIs. Field sources use Yarn names; the per-loader agent shim maps to MCP/Mojmap.

| Selector key    | How the mod resolves it |
|-----------------|--------------------------|
| `label`         | `Element.label` = color-stripped `ClickableWidget.getMessage().getString()` (or the drawn title for a list entry). Normalize + compare. |
| `textContains`  | Substring over normalized `getMessage()` + any extra drawn strings the widget reports as `bodyText` (e.g., multi-line `MultilineTextWidget`). |
| `loreContains`  | Substring over the widget's `Tooltip` lines (`getTooltip()` → rendered `Text` lines), color-stripped & sentinel-filtered (§5.2-B). For item-stack widgets, the stack's tooltip lines. |
| `itemType`      | For slot/`ItemStack`-bearing widgets, the stack's `Item` id via the registry (`Registries.ITEM.getId(...)`). Non-item widgets have `itemType=null`. |
| `role`          | Mapped from the concrete widget class: `ButtonWidget`/`PressableWidget`/`CheckboxWidget`→`button`; `*ListWidget$Entry`/`AlwaysSelectedEntryListWidget` child→`listItem`; `*ListWidget`/`AlwaysSelectedEntryListWidget`→`list`; `Slot` in a `HandledScreen`→`slot`; `TextFieldWidget`/`EditBox`/`SliderWidget`→`input`; tab nav button→`tab`; `TextWidget`/drawn label→`label`; else `role` omitted. |
| `index`/`nth`   | Document order = traversal order of `Screen.children()` (and nested `ContainerWidget`/list entries), depth-first; ordinal post-filter. |
| `within`        | Resolve the container widget, then restrict to its subtree: `((ParentElement)container).children()` recursively, or a list widget's `children()` entries. |
| `testId`        | Cast widget to `McTestTaggable` → `mctp$testId()`; fallback to the `​​mctp:<id>` tooltip/narration sentinel (§5.2-B). |
| `ref` (action)  | `"widget:<stable-path>"` where path = indices from the Screen root (e.g. `widget:0/3/1`). `clickElement(ref)` invokes the widget's click on the render thread (`mouseClicked` at its center, or `onPress()` for buttons; `scrollIntoView` first if `visible=false`). |

> Worked: `{ "role": "listItem", "label": "TestRegion", "within": { "testId": "or.list.regions" } }`
> → mod resolves the list panel by injected id → enumerates that list's entries →
> finds the entry whose `getMessage()` normalizes to `"testregion"` and role
> `listItem` → `ref:"widget:0/2/5"` → scrolls it into view → clicks → the SUT
> fires its handler and the chat assertion (`"Region loaded"`) is checked by the
> runner.

### 8.3 Pixel/OCR driver — `driver-pixel` (universal last resort, brittle)

No DOM/Screen access; everything comes from a screenshot + OCR/template matching.
Lowest capability set; the runner only selects it when nothing better fits.

| Selector key    | How the pixel driver resolves it |
|-----------------|----------------------------------|
| `label`         | OCR text regions on the screenshot; `Element.label` = recognized string per region; normalize + compare. Confidence from OCR feeds `score` (capped below exact). |
| `textContains`  | Substring over normalized OCR'd text of each region. |
| `loreContains`  | Generally **unavailable** (tooltips not rendered unless hovering). Only works if a tooltip overlay was explicitly captured; otherwise no candidate carries lore → `loreContains` never matches → SKIP unless paired with another key. |
| `itemType`      | **Template match** against a per-version sprite atlas: best-matching item texture under a threshold yields the modern id. Coarse; many items are visually ambiguous. |
| `role`          | Inferred from shape/template (button frame vs. row stripe) when a template pack is provided; otherwise `role` omitted. |
| `index`/`nth`   | Document order = reading order of recognized regions: top-to-bottom, then left-to-right by `bounds`; ordinal post-filter. |
| `within`        | Container resolved to a bounding rect (by label/template); children = regions whose `bounds` lie inside that rect. |
| `testId`        | **Unsupported** — no way to read invisible tags from pixels. Triggers capability skip (§5.3). |
| `ref` (action)  | `"rect:<id>"` carrying `bounds`; `clickElement(ref)` moves the OS cursor to the rect center and clicks (Xvfb/desktop). |

> Worked: `{ "label": "Regions" }` on pixel → screenshot → OCR finds a region
> reading "Regions" at `bounds {x,y,w,h}` with confidence 0.93 → `score≈0.93`,
> `strategy:"ocr"` → `ref:"rect:7"` → cursor click at center. (If two regions OCR
> to "Regions", default `ifMultiple:"fail"` raises `AMBIGUOUS_MATCH`.)

### 8.4 Capability ↔ selector-key requirements (drives runner SKIP decisions)

A test's selectors imply **required capabilities**; the runner matches them against
each driver's advertised set (from `session.describe`, see `CAPABILITIES.md`) and
skips with a precise reason when unmet. The element *surface* capability is
`containerGui` (inventory/chest GUIs, bot) or `clientScreens` (rendered client
Screens, mod); a selector that names any element requires at least one of these.
Resolver features such as `loreContains`, `role`, `itemType`, `within`, and
`scrollIntoView` are **part of the surface capability** (they ride on whichever of
`containerGui`/`clientScreens` the driver advertises) — they are **not** separate
capability keys.

| Selector usage                | Required capability key                     | Bot | Mod | Pixel |
|-------------------------------|---------------------------------------------|-----|-----|-------|
| any element selector          | `containerGui` **or** `clientScreens`       | yes | yes | yes   |
| `testId`                      | `testIdTags`                                | yes¹| yes | **no**|
| `loreContains`                | (surface: `containerGui`/`clientScreens`)   | yes | yes | rare² |
| `role`                        | (surface: `containerGui`/`clientScreens`)   | yes | yes | partial³|
| `itemType`                    | (surface: `containerGui`/`clientScreens`)   | yes | yes | partial³|
| `within` (nested container)   | (surface: `containerGui`/`clientScreens`)   | yes⁴| yes | partial|
| client-rendered mod Screen    | `clientScreens`                             | **no**| yes | via pixels|
| `scrollIntoView` long lists   | (surface: `containerGui`/`clientScreens`)   | yes | yes | partial|

¹ via the server agent enrichment. ² only with captured tooltip overlay.
³ only with a template/sprite pack for that version. ⁴ paging counts as a
surface (`containerGui`) feature.

When a required capability is missing, the runner emits:
`SKIPPED: selector requires capability '<key>' not advertised by driver '<driver>' for target '<loader>/<mc>'`.

---

## 9. Errors (selector resolution)

All are JSON-RPC error objects on the failing method. Selector failures **do not**
define their own codes — they reuse the **canonical MCTP error codes** registered in
`PROTOCOL.md` §Errors, and carry the legacy selector-failure name as a
`data.reason` label for diagnostics. (This doc registers **no** `-3201x` codes.)

| Code     | name (PROTOCOL.md)        | `data.reason` label    | When |
|----------|---------------------------|------------------------|------|
| `-32000` | `ELEMENT_NOT_FOUND`       | `NO_MATCH`             | zero candidates survive filtering within `timeoutMs`. `data.candidates` = last raw set. |
| `-32001` | `AMBIGUOUS_SELECTOR`      | `AMBIGUOUS_MATCH`      | >1 survivor and `ifMultiple:"fail"`. `data.candidates` = the tied elements (with `rawLabel`, `ref`). |
| `-32602` | (invalidParams)           | `INDEX_OUT_OF_RANGE`   | `nth`/`index` outside `[-(n), n-1]`. `data.candidateCount`. |
| `-32602` | (invalidParams)           | `INVALID_SELECTOR`     | malformed selector (unknown key, wrong type, `index`≠`nth`, empty object). `data.detail`. |
| `-32602` | (invalidParams)           | `MATCH_COUNT_MISMATCH` | `expectMatchCount` not met. `data.expected`,`data.actual`. |
| `-32002` | `METHOD_NOT_SUPPORTED`    | `SELECTOR_UNSUPPORTED` | a key requires a capability the driver lacks (e.g. `testId` on pixel). `data.requiredCapability`,`data.driver`. The runner maps this to a `NO_COMPATIBLE_DRIVER` skip. |
| `-32000` | `ELEMENT_NOT_FOUND`       | `ELEMENT_NOT_CLICKABLE`| matched element is `enabled:false` or off-screen with `scrollIntoView:false`. `data.ref`. |

Empty selector `{}` is `-32602` invalidParams (`data.reason: "INVALID_SELECTOR"`) —
a selector must constrain at least one predicate; use `screen.listElements` with no
selector to list everything.

---

## 10. Worked end-to-end: the canonical regions test

The semantic test "join localhost → `/or` → click **Regions** → click **TestRegion**
→ assert" expresses its two clicks purely as selectors; the same JSON runs on bot
and mod, and the runner picks the driver by capabilities (§8.4).

```jsonc
// Step: click "Regions" on the /or main menu  (robust form: testId)
{ "method": "screen.clickElement",
  "params": { "sessionId": "s-1",
              "selector": { "testId": "or.menu.regions" },
              "options": { "timeoutMs": 5000 } } }

// Fallback / human-authored form (works even on SUTs without injected ids):
{ "method": "screen.clickElement",
  "params": { "sessionId": "s-1",
              "selector": { "role": "button", "label": "Regions" } } }

// Step: click the "TestRegion" entry, scoped to the regions list panel
{ "method": "screen.clickElement",
  "params": { "sessionId": "s-1",
              "selector": { "within": { "testId": "or.list.regions" },
                            "role": "listItem",
                            "label": "TestRegion" },
              "options": { "scrollIntoView": true, "ifMultiple": "fail" } } }

// Assert (element-level, optional): the entry now shows a "loaded" tooltip line.
// There is no waitForElement method — the runner re-polls screen.listElements
// (cadence options.pollMs, budget options.timeoutMs) until a unique match appears.
{ "method": "screen.listElements",
  "params": { "sessionId": "s-1",
              "selector": { "testId": "or.region.testregion",
                            "loreContains": "loaded" },
              "options": { "timeoutMs": 3000 } } }
```

The chat assertion (`chat contains "Region loaded"`) and the world-truth assertion
(`assertPluginState` → region `"TestRegion"` exists) are **not** selector
operations — they use other MCTP methods — but they consume the same `testId`
vocabulary (`or.region.testregion` ↔ plugin key `"TestRegion"`), keeping authoring
coherent across GUI and world layers.

### 10.1 YAML authoring (expands to the JSON above)

```yaml
steps:
  - click: "#or.menu.regions"                 # -> { testId: "or.menu.regions" }
  - click:                                    # scoped listItem
      within: { testId: "or.list.regions" }
      role: listItem
      label: "TestRegion"
    scrollIntoView: true
  - assertChatContains: "Region loaded"       # non-selector MCTP method
  - assertPluginState:                         # server-agent, non-selector
      plugin: regions
      query: regionExists
      args: { name: "TestRegion" }
      expect: true
```

---

## 11. Implementation checklist (for `/packages/runner` + drivers)

- [ ] `Selector` TS type + JSON Schema published from `/packages/protocol` (the §1
      keys are defined by `PROTOCOL.md`; this doc is the source of truth for their
      matching *semantics*).
- [ ] `normalize()` implemented once in `/packages/protocol` (or a shared util) and
      imported by every TS driver; agents do **not** normalize.
- [ ] Shared `resolve(selector, candidates, options)` in `/packages/runner`
      consumed by all drivers (bot/mod/pixel call `screen.listElements`, then `resolve`).
- [ ] `Element` descriptor populated per §7/§8 by each driver; `ref` is the only
      driver-opaque field.
- [ ] Capability→selector gating (§8.4) wired into the runner's driver-selection so
      unmet keys SKIP with the §8.4 message.
- [ ] `testId` reader paths: server-agent PDC/NBT/component (§5.2-A/§5.3); mod
      `McTestTaggable` + tooltip sentinel (§5.2-B); pixel = unsupported.
- [ ] Selector failures thrown by `resolve`/action methods use the **canonical
      `PROTOCOL.md` error codes** (e.g. `-32000` ELEMENT_NOT_FOUND, `-32001`
      AMBIGUOUS_SELECTOR, `-32002` METHOD_NOT_SUPPORTED, `-32602` invalidParams)
      with the legacy selector-failure name carried as a `data.reason` label (§9);
      this doc registers **no** `-3201x` codes.
