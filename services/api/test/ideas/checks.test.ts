import { beforeEach, describe, expect, it } from "vitest";
import { RULES_VERSION } from "../../src/houserules.js";
import { batchAtTruth, idea, savedProduct, sheet, v1Ideas } from "../helpers/batch.js";
import { approvedClient, callTool, createStudio, type Studio } from "../helpers/deps.js";

let studio: Studio;
beforeEach(async () => {
  studio = await createStudio();
  await approvedClient(studio);
});

const refused = (pattern: RegExp) => ({ ok: false, error: expect.stringMatching(pattern) });

describe("ideas", () => {
  it("refuses ideas from a caller that did not read the house rules", async () => {
    const { batchId } = await batchAtTruth(studio);
    const saved = await callTool(studio, "ideas_save", { batchId, ideas: v1Ideas() });
    expect(saved).toEqual(refused(/Call rules_get/));
  });

  it("saves five sound ideas and moves the batch to ideas", async () => {
    const { batchId } = await batchAtTruth(studio);
    const saved = await callTool(studio, "ideas_save", { rulesVersion: RULES_VERSION, batchId, ideas: v1Ideas() });
    expect(saved.value).toMatchObject({ state: "ideas", nextStep: expect.stringMatching(/blind pick/) });
    expect(saved.value.ideas.map((i: { id: string }) => i.id)).toEqual(["idea-1", "idea-2", "idea-3", "idea-4", "idea-5"]);
    const got = await callTool(studio, "batch_get", { batchId });
    expect(got.value).toMatchObject({ batch: { state: "ideas" }, tasteNotRead: [] });
    expect(got.value.ideas).toHaveLength(5);
  });

  it("refuses an idea with six elements, and names it", async () => {
    const { batchId } = await batchAtTruth(studio);
    const busy = idea(2, { title: "The busy one", elements: ["pack", "rock", "wave", "gull", "boat", "sun"] });
    const ideas = v1Ideas();
    ideas[1] = busy;
    const saved = await callTool(studio, "ideas_save", { rulesVersion: RULES_VERSION, batchId, ideas });
    expect(saved).toEqual(refused(/Idea 2 \("The busy one"\) has 6 elements\. The most is 5/));
    expect((await callTool(studio, "batch_get", { batchId })).value).toMatchObject({ batch: { state: "truth" }, ideas: [] });
  });

  it("refuses an idea whose kill test is recorded as failed", async () => {
    const { batchId } = await batchAtTruth(studio);
    const killed = idea(3, { killTest: { passed: false, note: "It says the crisps lower blood pressure." } });
    const ideas = v1Ideas();
    ideas[2] = killed;
    const saved = await callTool(studio, "ideas_save", { rulesVersion: RULES_VERSION, batchId, ideas });
    expect(saved).toEqual(refused(/Idea 3 .* fails its kill test \(It says the crisps lower blood pressure\.\)/));
  });

  it("keeps the real photos a v1 idea says it shows, and refuses a photo the product does not have", async () => {
    // Real photos first holds for every kind of ad, v1 too.
    const { batchId } = await batchAtTruth(studio);
    const missingIdeas = v1Ideas();
    missingIdeas[0] = idea(1, { shows: ["food-1", "prop-1"] });
    const missing = await callTool(studio, "ideas_save", { rulesVersion: RULES_VERSION, batchId, ideas: missingIdeas });
    expect(missing).toEqual(refused(/Idea 1 shows prop-1, and this product has no such photo\. Its photos: food-1\./));
    const ideas = v1Ideas();
    ideas[0] = idea(1, { shows: ["food-1"] });
    const saved = await callTool(studio, "ideas_save", { rulesVersion: RULES_VERSION, batchId, ideas });
    expect(saved.ok ? "" : saved.error).toBe("");
    expect((await callTool(studio, "batch_get", { batchId })).value.ideas[0].shows).toEqual(["food-1"]);
  });

  it("refuses an idea with no outside-category reference", async () => {
    const { batchId } = await batchAtTruth(studio);
    const ideas = v1Ideas();
    ideas[0] = idea(1, { references: [] });
    const saved = await callTool(studio, "ideas_save", { rulesVersion: RULES_VERSION, batchId, ideas });
    expect(saved).toEqual(refused(/Idea 1 .* has no reference from outside the product's category/));
  });

  it("refuses four and six ideas", async () => {
    const { batchId } = await batchAtTruth(studio);
    expect(await callTool(studio, "ideas_save", { rulesVersion: RULES_VERSION, batchId, ideas: v1Ideas().slice(0, 4) })).toEqual(refused(/holds 5 ideas\. This call has 4/));
    expect(await callTool(studio, "ideas_save", { rulesVersion: RULES_VERSION, batchId, ideas: [...v1Ideas(), idea(6)] })).toEqual(refused(/This call has 6/));
  });

  it("refuses ideas on a batch with no read of the canon, and names canon_get", async () => {
    const { brand, product } = await savedProduct(studio);
    const batchId = (await callTool(studio, "batch_create", { kind: "v1", brandId: brand.id, productId: product.id })).value.batch.id;
    await callTool(studio, "truth_save", { batchId, ...sheet });
    await callTool(studio, "taste_log", { batchId });
    await callTool(studio, "swipe_search", { batchId });
    const saved = await callTool(studio, "ideas_save", { rulesVersion: RULES_VERSION, batchId, ideas: v1Ideas() });
    expect(saved).toEqual(refused(/Not read yet: canon_get\./));
    await callTool(studio, "canon_get", { batchId });
    expect((await callTool(studio, "ideas_save", { rulesVersion: RULES_VERSION, batchId, ideas: v1Ideas() })).ok).toBe(true);
  });

  it("refuses an idea with a field the studio does not know", async () => {
    const { batchId } = await batchAtTruth(studio);
    const ideas = v1Ideas();
    ideas[0] = idea(1, { secondDevice: "also a boat" });
    const saved = await callTool(studio, "ideas_save", { rulesVersion: RULES_VERSION, batchId, ideas });
    expect(saved.ok).toBe(false);
  });
});
