import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contentValidator } from "../src/schemas.js";

describe("kit content schemas", () => {
  it("accepts kit example content and rejects broken content with a precise message", () => {
    const v = contentValidator(["rpg"]);
    const good = JSON.parse(readFileSync(new URL("../../games/examples/kit-rpg/data/creatures/sunnip.json", import.meta.url), "utf8"));
    expect(v.check("data/creatures/sunnip.json", good)).toEqual([]);
    const errs = v.check("data/creatures/bad.json", { ...good, types: "sun" });
    expect(errs?.length).toBeGreaterThan(0);
    expect(errs!.join(" ")).toMatch(/types/);
    expect(v.check("data/unknown_kind/x.json", {})).toBeNull(); // no schema → not checked
  });

  it("routes by folder name when schemas don't carry a title path", () => {
    const v = contentValidator(["deckbuilder"]);
    expect(v.patterns.some((p) => p.startsWith("data/cards/"))).toBe(true);
    const errs = v.check("data/cards/strike.json", { cost: "one" });
    expect(errs?.length).toBeGreaterThan(0);
  });
});
