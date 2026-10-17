# Macros: saved command groups for manual play testing

`/macro` (short form `/m`) runs **macros**: named, parameterized groups of commands kept in a project's repo, so a
setup a tester repeats ("Carol takes expedition #2", "give area B back to South") is one line instead of four to
twenty pasted ones with the names changed by hand. It sits next to `/actor` ([commandcenter spec/42](../../commandcenter/spec/42-bench-actors.md))
in the server agent and drives actors by running `/actor` lines.

> **A bench convenience, not a test path.** The runner never uses `/macro`, and nothing on the wire (MCTP) changes.
> A macro's `expect` lines are hints for the human watching, not verdicts: verdicts stay in the runner (Prime
> Directive 2). The macro engine is game-free Java in `agents/core` (`io.mctest.agent.core.bench`), unit-tested
> there; each loader adds a thin command shim.

**Status:** server-neoforge and server-fabric (1.21.1) have it. server-forge and server-bukkit don't yet; their shims
would mirror `agents/server-neoforge/.../mappings/MacroCommands.java` and `CommandOutcome.java`.

## 1. Using it

| Command | Does |
|---|---|
| `/macro` (or `/m`) | Opens the **macro menu** (§8): every macro, with its steps; drag them around, run one, open one to see and change its steps. `/macro menu <name>` opens one macro. |
| `/m <name> [values]` | Runs a macro. Values fill its parameters in order, or by name: `/m expedition.take Carol n=2`. `/macro run <name>` is the same, for servers where another mod owns `/m`. |
| `/macro again [values]` | Runs your last macro again, changing only what you give: after `/m expedition.take Carol n=2`, `/macro again Dave` takes #2 as Dave. |
| `/macro list [filter]` · `/macro show <name>` | Lists the macros (click one to fill in the command; hover for its description) · prints one's usage, description and file. |
| `/macro stop` · `/macro continue` | Ends your running macro · goes on after a `pause`. |
| `/macro reload` | Reads the files again and lists any problems. Not needed after an edit: a changed file is read again within half a second. |
| `/macro record start` → `/macro record save <name>` (or `cancel`) | Records the commands you type and saves them as a macro. |
| `/macro last <n> as <name>` | Saves the last *n* commands you typed as a macro. |
| `/macro new <name> [params]` · `copy <name> <new>` · `delete <name>` | A new, empty macro · a copy next to it · takes one out of its file. |
| `/macro edit <name> add <step>` · `step <n> <step>` · `insert <n> <step>` · `remove <n>` · `move <n> <to>` | Adds, changes, inserts, deletes or moves a step. Steps are numbered from 1 as `/macro show` prints them. |
| `/macro edit <name> header <name> [params]` · `describe [text]` · `book` | Renames it or changes its parameters · replaces its description (a vertical bar starts a new line) · gives you a book to edit all of it in. |
| `/macro undo` | Undoes your last change to a macro file (up to 20 back), unless the file was changed since. |
| `/macro help` | Lists the commands. |

Op level 2. Tab completion offers macro names, then the parameters not given yet (`n=`) and online player names.

While a macro runs you see each step in grey, checks as ✔/✘, and a final line with clickable **[again]** (and
**[stop]** on the first line). The same lines go to the server log as `[macro <who>] …`, which is how a project's
scripted checks assert on them.

## 2. The file format

A project keeps macros in `.macro` files (any number, any sub-folder) in the folders named by **`MCTEST_MACROS`**
(paths split by the platform's path separator, `;` on Windows); without it the agent reads `macros/` in the server's
directory. A dev run should point it at the repo so edits apply at once, e.g. in Gradle:
`environment("MCTEST_MACROS", file("playtest/macros").absolutePath)`.

```
# Comments start with '#'. Comment lines right after the header describe the macro.

macro expedition.take who n=1 from=bank bank=Capital
  # {who} goes to the bank and takes expedition #{n} from {bank}'s bank menu.
  run go {who} {from}
  run hands.free {who}
  /actor {who} cmd mapfactions bank menu {bank}
  /actor {who} click Expeditions
  /actor {who} click Expedition #{n}
  expect {who} told "Your party has taken expedition #{n}"
end
```

- **Header:** `macro <name> <params…>`. A bare parameter is required (`who`); `name=value` has a default, which may
  name an earlier parameter (`who2={who}2`). Quote a value with spaces: `bank="Port Royal"`. Names are letters,
  digits, `.`, `-`, `_`; lookup ignores case, so `run area.{area}` finds `area.B` for `b`.
- **Placeholders:** `{param}`, and the built-in `{me}` (whoever runs the macro). Anything else in braces is sent as
  typed, so a command's own JSON or SNBT passes through; an unknown `{name}` is reported as a likely typo.

| Step | Does |
|---|---|
| `/command` | Runs as whoever started the macro (their permissions and position), through the real dispatcher. `/actor X …` drives an actor exactly as typing it would. A failed command stops the macro (see §5). |
| `-/command` | The same, but carries on if it fails (`-/clear {who}` on an empty inventory). |
| `+/command` | Runs in the same tick as the step before it, for a move nothing must see half done (copy an item, then delete the original). |
| `wait <duration>` | `40t`, `10s`, `1.5s`, `2m`; a bare number is seconds. |
| `waitfor <who> told "<text>" [timeout <duration>]` | Waits (default 30 s) until `who` is told a message containing the text; stops the macro if it never is. Better than a guessed `wait`. |
| `expect <who> [not] told "<text>" [within <duration>]` | A check: ✔ or ✘ (default 5 s), then carries on. `not` waits the whole time and passes if the message never comes. |
| `run <macro> [values]` | Another macro, as a step (nested up to 16 deep). |
| `say <text>` | A line to whoever runs it: a note, or what to look at now. |
| `pause [text]` | Waits for `/macro continue` (clickable): for a step only a human can do, like using an item. |

**Messages** are matched like the selectors match text (colour codes stripped, whitespace collapsed, case folded),
and only messages after the latest command count, so an old one can't satisfy a new step. **Captures:** `{=name}` in a
`waitfor`/`expect` text takes one word of the message into `{name}` for the later steps of that macro:

```
  /execute as {who} run mapfactions admin appraise Capital
  waitfor {me} told "listed it as #{=listing}"
  /actor {who} cmd mapfactions bank buy Capital {listing}
```

**Who is told what:** an actor's messages (chat, action bar, titles) are all seen, muted or not. For a real player or
the console, only the feedback of the commands the macro itself runs is seen (the agent can't watch a real player's
connection). The same goes for an actor someone is playing as (`/actor <name> control`): its messages go to that
person's client, so a `waitfor`/`expect` on it only sees what the macro's own commands tell it.

## 3. Arguments

Named values are taken first, then positional ones fill the remaining parameters in declaration order, so the
first parameters are the ones worth putting first (`who`, then the target). `/macro again` keeps the last run's
values and replaces what you give: named ones by name, positional ones from the first parameter not named now.

## 4. Where it lives

| Piece | File |
|---|---|
| Model, parser, arguments | `agents/core/.../bench/Macro.java`, `MacroParser.java`, `Args.java` |
| Folder loading (re-read on change) | `bench/MacroLibrary.java` |
| Running, one command per tick | `bench/MacroRun.java` |
| What players were told | `bench/ToldLog.java` |
| Recording | `bench/CommandLog.java` |
| Guide checker | `bench/GuideCheck.java` |
| NeoForge `/macro` + `/m` | `agents/server-neoforge/.../mappings/MacroCommands.java` |
| Fabric `/macro` + `/m` | `agents/server-fabric/.../mappings/MacroCommands.java` |
| Did a command work? | `mappings/CommandOutcome.java` in each agent |
| Hearing typed commands, for recording | NeoForge: `CommandEvent`. Fabric: `mappings/mixin/CommandManagerMixin.java` (Fabric API has no such event) |
| The menu's screens: what each slot shows, what a click does | `bench/MacroMenu.java` |
| Editing a macro's text in its file; undo | `bench/MacroSource.java`, `bench/MacroEditor.java` |
| Where the menu shows each macro | `bench/MacroLayout.java` (`macros.layout`) |
| Drawing the menu as a chest, the edit book | `mappings/MacroMenus.java` in each agent |

Tests: `agents/core/src/test/java/io/mctest/agent/core/bench/` (`gradlew :core:test` in `agents/`). The live check is
**`node tests/e2e/run-bench-macros.mjs [fabric|neoforge]`**: it boots a real server per loader with `MCTEST_MACROS` set,
joins a real client, and checks arguments, `/macro again`, `expect … told`, a `{=capture}`, a refused actor command
stopping the run, `-/`, record → save → replay, and a file added while running, on the `[macro …]` log lines. Change
the engine or a shim, run it. The menu's live check is **`node tests/e2e/run-bench-macro-menu.mjs [fabric|neoforge]`**
(§8): it clicks the menu the way a vanilla client does and checks the slots, the files and the log. MapFactions' `checkPlaytest` is the same kind of check in a consuming project.

## 5. Running, and what counts as failing

Steps run on the server thread, at most one command per tick (so a menu a command opened is there for the next
click), as the player or console that started the macro; its position is read fresh for every step. One macro runs
per player at a time, and a macro finishes on the tick after its last command, so a script that starts the next
macro the moment the last command's output appears gets "Already running": wait for the `done` line.

A command **fails** when it doesn't run at all (a syntax error: the dispatcher calls nothing back), throws (vanilla's
"No items were found"), or returns 0 after telling its source off in red (how most mods' commands refuse). Returning
0 alone isn't failure: `/gamerule doDaylightCycle false` returns 0. An `/actor X cmd …` step also fails when **the
actor's** command fails by the same rule, so a refused `faction join` stops the macro instead of carrying on in the
wrong state.

**Guards:** a macro can stop itself before doing damage with a plain condition, e.g.
`/execute unless items entity {who} weapon.mainhand *` fails (so stops the macro) when the actor's hand isn't empty.

## 6. Recording

The agent remembers the last 100 commands each operator typed (not actors', not a macro's own steps, not ones that
didn't parse). `record save` and `last … as` write the commands to `recorded.macro` in the first macro folder,
turning each actor named in them into a parameter (`who`, `who2`, … in order of appearance, defaulting to the name
used) and your own name into `{me}`. So `/macro last 4 as invite` followed by `/m invite Carol` replays them for Carol.
Commands that ran but failed are kept; delete them from the file.

## 7. Test guides: writing them, and checking them

A manual test guide (a project's `docs/TEST_GUIDE.md` or similar) is where macros pay off. The rules, for people and
for agents writing guides:

1. **Every step says what to do, for its own target.** Never "the same way", "as in 3.3", "(step 2)", "repeat …",
   "invite him back": the tester then rebuilds commands for a new name by hand, which is slow and where mistakes come
   from. Write the macro call (`/m expedition.take Carol n=2`) or the commands, with real names and values (no
   `<placeholders>` in a macro call).
2. **A macro never replaces the thing being tested.** The first time a gesture is tested (a menu path, a hand-over),
   write its commands out. Macros are for setup, and for repeats of something the guide already tested.
3. **Each macro call is in backticks** (`` `/m name values` `` or in a fenced block), so it can be checked and copied.
4. **Name the macros in the setup section**, with what each does and its raw commands once (`/macro show <name>`
   prints them), so the guide still works without the tool.

**The checker** enforces 1 and 3 and checks every macro call against the macro files (the macro exists, the values
fit its parameters, no placeholder):

```
java -cp mc-test-agent-core-0.1.0.jar io.mctest.agent.core.bench.GuideCheck --macros <folder> [--macros <folder>] <guide.md>…
```

It prints `file:line: error: …` per problem and exits 1 when there are errors. A sentence that points back is fine
when the command it means follows the pointer in the same sentence ("re-ally the factions (2.6 step 3): `/faction
ally South`"). A pointer that's an explanation, not an instruction, can opt out with `<!-- guide-check: ok -->` in
its paragraph or list item. It can't see a back-reference by name ("give B back to South"); rule 1 still applies.

A project should run it from its build (MapFactions: `./gradlew checkTestGuide`) and say so in its `CLAUDE.md`, so
agents writing guides keep them runnable.

## 8. The macro menu

`/macro` (or `/m` on its own) opens a chest-style menu, so it works with a vanilla client and needs no client mod.
Nothing in it is a real item: every click is answered by redrawing the menu, so an icon can't be taken out of it.
A spectator can't click in a menu, so leave spectator mode first (`/actor back` if you're viewing an actor).

**The list** shows every macro as a shulker box, one colour per file. Hover over one to see its parameters,
description, its first 12 steps, and where it's defined.

| On a macro | Does |
|---|---|
| Click | Picks it up. Click a slot to put it down; dropping it on another macro picks that one up instead (like moving items). Carry it onto ▶ to move it to the next page. |
| Right-click | Opens it (below). |
| Shift-click | Runs it with its defaults. If it has a parameter with no default, the command is put in chat for you to fill in. |

The bottom row has: previous/next page, **New macro**, **Record** (start; while recording, click saves, right-click
throws it away), **Run again**, help, **Stop**/**Continue** for a running macro, **Reload** (hover for the files'
problems), **Arrange by file** (shift-click: forget the arrangement).

Where you drag macros is kept in **`macros.layout`** in the first macro folder (`page * 45 + slot` then the name,
one per line), so the arrangement survives restarts and can be shared in the repo. A macro nobody placed takes the
first free slot. It's safe to delete the file.

**One macro** (right-click) shows every step in order, one icon each, so you can see everything it will run. The
icon shows the kind of step: a command block for `/command`, a repeating one for `-/`, a chain one for `+/`, a clock
for `wait`, a spyglass for `waitfor`, a target for `expect`, a shulker box for `run`, a sign for `say`, a bell for
`pause`, and a barrier for a line that isn't a step (hover to see why).

| On a step | Does |
|---|---|
| Click | Picks it up; the others close up. Click a step to put it in front of that one, or an empty slot to put it last. |
| Right-click | Edit: puts `/macro edit <name> step <n> <the step>` in chat, filled in. |
| Shift-click | Puts `/macro edit <name> insert <n> ` in chat, to add a step before it. |
| Q | Deletes it. **Undo** brings it back. |

The bottom row has: back to the list, the macro itself (click: rename it or change its parameters; right-click:
change its description), **Run** (right-click: with other values), **Add a step**, **Edit in a book**, the page (when
there are more than 45 steps), **Copy**, **Undo**, and **Delete** (asks first).

**Typing text.** A chest menu has no text box, so anything you type goes through chat: the menu closes and puts a
clickable `[click to fill in]` line in chat. Clicking it puts the command in your chat box, filled in, for you to
finish and send. When the command works, the menu opens again on that macro (if it's within 10 minutes).

**Editing in a book.** **Edit in a book** (or `/macro edit <name> book`) puts a book and quill in an empty hotbar
slot and selects it. The book holds the whole macro, header to `end`, without indentation. Right-click it, edit, and
press **Done** (signing it works too). The agent then checks the text and saves it, takes the book back, and opens
the macro again. If the text doesn't parse (for example a missing `macro <name>` header), nothing is saved, the
book stays, and chat says what's wrong; fix it and press Done again, or `/macro book cancel`. Logging out takes the
book back unsaved.

**What an edit does to the file.** Each change reads the file fresh, changes only that macro's lines, and keeps the
file's other macros, comments, blank lines, indentation and line endings as they were. An edit that would add a
parse error to the macro is refused and the file is left alone; warnings (an unknown `{placeholder}`) are shown but
don't stop it. A new macro goes into the file of the macros that share its name's prefix (`area.give` joins
`area.take`'s file), else `new.macro` in the first folder. `/macro undo` puts back the text from before your last
change, but only if nobody changed the file since. Undo is kept per person, for this server run.
