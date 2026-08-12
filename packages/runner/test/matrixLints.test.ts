/**
 * The static §5.3 lints (spec commandcenter/40-testing-loop.md §5, control 3).
 *
 * Every fixture below is DELIBERATELY BAD in one specific way — that is the
 * point: a matrix can look like coverage while proving nothing, and these two
 * lints are what say so before a single server boots. The good fixture at the
 * end is the control: a well-formed matrix must stay silent, or the warnings
 * become noise everyone learns to ignore.
 */
import { describe, expect, it } from "vitest";
import { expandMatrix, lintMatrix, parseStepDocument, renderLints } from "../src/index.js";

const lintsFor = (doc: unknown, name = "fixture.mctest.yml") => {
  const test = parseStepDocument(doc, name);
  return lintMatrix(test, expandMatrix(test));
};

describe("§5.3 vacuous-branch lint", () => {
  it("fires on a branch whose when: names a value no case has", () => {
    const lints = lintsFor({
      name: "vacuous-value",
      matrix: { neighbor: { values: { free: null, occupied: "minecraft:stone" } } },
      anchors: { chest: "0,64,0" },
      steps: [{ join: {} }],
      expect: [
        { when: { neighbor: "free" }, block: { pos: "chest + up", is: "*_sign" } },
        // `flooded` is not one of the declared values — this branch can never run.
        { when: { neighbor: "flooded" }, block: { pos: "chest + up", is: "minecraft:water" } },
      ],
    });

    expect(lints).toHaveLength(1);
    expect(lints[0]).toMatchObject({ rule: "vacuous-branch", ref: "vacuous-value#expect[1]" });
    expect(lints[0]!.message).toContain("matches 0 of 2 generated case(s)");
    expect(lints[0]!.message).toContain("no combination of the declared values satisfies it");
  });

  it("names the dimension that does not exist when the when: is a typo", () => {
    const lints = lintsFor({
      name: "typo",
      matrix: { face: { values: ["north", "south"] } },
      steps: [{ join: {} }],
      expect: [{ when: { faces: "north" }, chat: { contains: "placed" } }],
    });

    // A typo'd `when:` costs twice: the branch judges nothing, AND the dimension
    // it meant to name is now constrained by nothing.
    expect(lints.map((l) => `${l.rule} ${l.ref}`)).toEqual([
      "vacuous-branch typo#expect[0]",
      "dead-dimension typo#matrix.face",
    ]);
    expect(lints[0]!.message).toContain("'faces', which is not a dimension of this matrix");
  });

  it("distinguishes 'dead branch' from 'pairwise dropped the cases it would judge'", () => {
    // 3 binary dimensions: the pairwise subset covers every PAIR, but not every
    // triple — so a branch pinned to one exact triple can go unexercised.
    const lints = lintsFor({
      name: "pairwise-gap",
      matrix: {
        a: { values: ["a0", "a1"] },
        b: { values: ["b0", "b1"] },
        c: { values: ["c0", "c1"] },
      },
      coverage: "pairwise",
      steps: [{ chat: "case $a/$b/$c" }],
      expect: [
        { when: { a: "a0" }, chat: { contains: "$a" } },
        { when: { b: "b0" }, chat: { contains: "$b" } },
        { when: { c: "c0" }, chat: { contains: "$c" } },
        { when: { a: "a1", b: "b1", c: "c1" }, chat: { contains: "all-ones" } },
      ],
    });
    const cases = expandMatrix(parseStepDocument({
      name: "pairwise-gap",
      matrix: { a: { values: ["a0", "a1"] }, b: { values: ["b0", "b1"] }, c: { values: ["c0", "c1"] } },
      coverage: "pairwise",
      steps: [{ chat: "case $a/$b/$c" }],
    }, "x.mctest.yml"));
    const ranAllOnes = cases.some((c) => c.id === "a=a1,b=b1,c=c1");

    // Either the subset happens to include the triple (no lint), or it doesn't and
    // the lint says WHY — never a silent "that branch judged something".
    if (ranAllOnes) {
      expect(lints).toEqual([]);
    } else {
      expect(lints).toHaveLength(1);
      expect(lints[0]!.ref).toBe("pairwise-gap#expect[3]");
      expect(lints[0]!.message).toContain("coverage: pairwise generated none of them");
      expect(lints[0]!.message).toContain("would judge 1 declared case(s)");
    }
  });

  it("fires on an except: override that names a case the matrix never generates", () => {
    const lints = lintsFor({
      name: "stale-exception",
      matrix: { face: { values: ["north", "south"] } },
      steps: [{ join: {} }],
      expect: [{ chat: { contains: "placed" } }],
      except: [
        {
          when: { face: "up" },
          reason: "left behind after the up/down faces were dropped from the matrix",
          expect: [{ chat: { contains: "anything" } }],
        },
      ],
    });

    expect(lints).toHaveLength(1);
    expect(lints[0]).toMatchObject({ rule: "vacuous-branch", ref: "stale-exception#except[0]" });
    expect(lints[0]!.message).toContain("VACUOUS except override");
  });

  it("says so when a when:-filtered branch sits on a test with no matrix at all", () => {
    const lints = lintsFor({
      name: "no-matrix",
      steps: [{ join: {} }],
      expect: [{ when: { face: "north" }, chat: { contains: "placed" } }],
    });

    expect(lints[0]!.message).toContain("the test declares no matrix:");
  });
});

describe("§5.3 dead-dimension lint", () => {
  it("fires on a dimension that changes the actions but no expectation", () => {
    // `held` decides what the player is holding, yet every case asserts the same
    // sign lands: three values, one assertion — theater.
    const lints = lintsFor({
      name: "theater",
      matrix: {
        face: { values: ["north", "south"], bind: { step: "useBlock", param: "face" } },
        held: { values: { empty: null, sign: "minecraft:oak_sign", block: "minecraft:cobblestone" } },
      },
      anchors: { chest: "0,64,0" },
      steps: [
        { setHeldItem: { item: "$held" } },
        { useBlock: { pos: { x: 0, y: 64, z: 0 }, sneak: true } },
      ],
      expect: [{ block: { pos: "chest + $face", is: "*_sign" } }],
    });

    expect(lints).toHaveLength(1);
    expect(lints[0]).toMatchObject({ rule: "dead-dimension", ref: "theater#matrix.held" });
    expect(lints[0]!.message).toContain("3 value(s) are varied but no expectation depends on it");
  });

  it("counts a dimension as live when it is referenced by when: OR by a $token", () => {
    const lints = lintsFor({
      name: "live",
      matrix: {
        face: { values: ["north", "south"] },
        held: { values: { empty: null, sign: "minecraft:oak_sign" } },
      },
      anchors: { chest: "0,64,0" },
      steps: [{ join: {} }],
      expect: [
        { when: { held: "sign" }, block: { pos: "chest + $face", is: "*_sign" } },
        { when: { held: "empty" }, block: { pos: "chest + $face", absent: true } },
      ],
    });

    expect(lints).toEqual([]);
  });

  it("counts a dimension woven into an authored ASSERTION step as live, but not one used only by an action", () => {
    const asserted = lintsFor({
      name: "asserted",
      matrix: { region: { values: ["Spawn", "Market"] } },
      steps: [{ click: "$region" }, { assertChat: { contains: "Region loaded: $region" } }],
    });
    expect(asserted).toEqual([]);

    const actionOnly = lintsFor({
      name: "action-only",
      matrix: { region: { values: ["Spawn", "Market"] } },
      steps: [{ click: "$region" }, { assertChat: { contains: "Region loaded" } }],
    });
    expect(actionOnly).toHaveLength(1);
    expect(actionOnly[0]).toMatchObject({ rule: "dead-dimension", ref: "action-only#matrix.region" });
  });

  it("exempts an environment-bound dimension — the same oracle holding across boots is the point", () => {
    const lints = lintsFor({
      name: "env",
      matrix: {
        flavor: { values: ["paper", "fabric"], bind: { environment: "server-flavor" } },
        face: { values: ["north", "south"] },
      },
      anchors: { chest: "0,64,0" },
      steps: [{ join: {} }],
      expect: [{ block: { pos: "chest + $face", is: "*_sign" } }],
    });

    expect(lints).toEqual([]);
  });
});

describe("§5.3 lints stay quiet on a well-formed matrix", () => {
  it("reports nothing when every branch selects cases and every dimension is asserted on", () => {
    const lints = lintsFor({
      name: "good",
      matrix: {
        face: { values: ["north", "south"], bind: { step: "useBlock", param: "face" } },
        neighbor: { values: { free: null, occupied: "minecraft:stone" } },
      },
      anchors: { chest: { x: 0, y: 64, z: 0 } },
      steps: [{ useBlock: { pos: { x: 0, y: 64, z: 0 }, sneak: true } }],
      expect: [
        { when: { neighbor: "free" }, block: { pos: "chest + $face", is: "*_sign" } },
        { when: { neighbor: "occupied" }, block: { pos: "chest + $face", is: "minecraft:stone" } },
      ],
    });

    expect(lints).toEqual([]);
  });

  it("renders findings for the console with rule + ref", () => {
    const rendered = renderLints([{ rule: "dead-dimension", ref: "t#matrix.held", message: "theater" }]);
    expect(rendered).toContain("Matrix lints");
    expect(rendered).toContain("! dead-dimension  t#matrix.held: theater");
  });
});
