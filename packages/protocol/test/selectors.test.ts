import { describe, it, expect } from "vitest";
import { describeSelector, SELECTOR_ROLES, type Selector } from "../src/selectors";

describe("describeSelector", () => {
  it("renders a single label predicate", () => {
    expect(describeSelector({ label: "Regions" })).toBe('label="Regions"');
  });

  it("renders the ROADMAP example: label + within(role)", () => {
    expect(describeSelector({ label: "Regions", within: { role: "tab" } })).toBe(
      'label="Regions" within(role=tab)',
    );
  });

  it("renders the PROTOCOL example with a fixed canonical key order", () => {
    const sel: Selector = { text: "Region", role: "button", within: { testId: "regions:list" }, nth: 0 };
    expect(describeSelector(sel)).toBe('text="Region" role=button within(testId="regions:list") nth=0');
  });

  it("puts testId first regardless of insertion order", () => {
    expect(describeSelector({ label: "x", testId: "y" })).toBe('testId="y" label="x"');
  });

  it("renders a loreContains array", () => {
    expect(describeSelector({ loreContains: ["Owner: Notch", "loaded"] })).toBe(
      'loreContains=["Owner: Notch","loaded"]',
    );
  });

  it("renders a single loreContains string", () => {
    expect(describeSelector({ loreContains: "loaded" })).toBe('loreContains="loaded"');
  });

  it("renders index and nth as bare numbers", () => {
    expect(describeSelector({ role: "listItem", index: 2 })).toBe("role=listItem index=2");
  });

  it("is deterministic across insertion orders", () => {
    const a = describeSelector({ label: "A", role: "button", itemType: "minecraft:book" });
    const b = describeSelector({ itemType: "minecraft:book", role: "button", label: "A" });
    expect(a).toBe(b);
  });

  it("handles an empty selector defensively", () => {
    expect(describeSelector({} as Selector)).toBe("<empty selector>");
  });

  it("exposes the canonical closed role set", () => {
    expect(SELECTOR_ROLES).toEqual(["button", "slot", "label", "input", "tab", "list", "listItem"]);
  });
});
