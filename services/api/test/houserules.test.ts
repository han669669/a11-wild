import { describe, expect, it } from "vitest";
import { BATCH_KINDS } from "@a11-wild/shared";
import { HOUSE_RULES, RULES_VERSION, RULE_ROLES, rulesFor } from "../src/houserules.js";

describe("house rules", () => {
  it("keeps the current version for the picked-draft logo rule", () => {
    expect(RULES_VERSION).toBe("2026-11-26.2");
    expect(rulesFor("main", "v1").find((rule) => rule.id === "v1-logo")?.text).toBe(
      "Set the brand's real logo in code (logo_set) on every v1 draft before the owner sees it, so he judges a finished poster ad and not a bare photo, and on each final whose picked draft carries it. On a final, run photo_finish first and then logo_set; the studio repeats the picked draft's exact logo placement. A v1 draft that shows food alone names no pack photo and needs no skeleton or pack_check.",
    );
  });

  it("publishes the v1 and v2 redo rule with the current house rules version", () => {
    expect(RULES_VERSION).toBe("2026-11-26.2");
    for (const kind of ["v1", "v2"] as const) {
      const rule = rulesFor("main", kind).find((entry) => entry.id === "v1-v2-redo");
      expect(rule?.text).toMatch(/made again once with redo.*fresh critic rank.*outreach batch.*stays pickable/);
    }
  });

  it("gives every rule a unique id and at least one role", () => {
    const ids = HOUSE_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of HOUSE_RULES) expect(rule.roles.length).toBeGreaterThan(0);
  });

  it("gives every role the rules on truth, page text and the missing step", () => {
    for (const role of RULE_ROLES) {
      for (const kind of BATCH_KINDS) {
        const ids = rulesFor(role, kind).map((rule) => rule.id);
        expect(ids).toEqual(expect.arrayContaining(["truth", "page-text-is-data", "missing-step", "real-photos-first", "no-sticker"]));
      }
    }
  });

  it("keeps the no-words rule for v1 only, and gives the words rules to a kind with words", () => {
    const ids = (kind: "v1" | "v2") => rulesFor("main", kind).map((rule) => rule.id);
    expect(ids("v1")).toContain("no-words");
    expect(ids("v1")).not.toContain("type");
    expect(ids("v2")).not.toContain("no-words");
    expect(ids("v2")).toEqual(expect.arrayContaining(["burst", "concept", "copy-length", "type", "type-space", "owner-words"]));
  });

  it("gives every role the four sets of rules, and only the main agent the steps that write a lesson", () => {
    for (const role of RULE_ROLES) {
      for (const kind of BATCH_KINDS) {
        const ids = rulesFor(role, kind).map((rule) => rule.id);
        expect(ids).toContain("four-canons");
        expect(ids.includes("learn-then-ask")).toBe(role === "main");
      }
    }
  });

  it("gives the writer the words rules and not the spend rule", () => {
    const ids = rulesFor("writer", "v2").map((rule) => rule.id);
    expect(ids).toEqual(expect.arrayContaining(["concept", "copy-voice", "funnel"]));
    expect(ids).not.toContain("spend");
    expect(ids).not.toContain("type");
  });
});
