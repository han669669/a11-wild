import { beforeEach, describe, expect, it } from "vitest";
import { PACK_CHECK, pickedStamp } from "../../src/board/service.js";
import { RULES_VERSION } from "../../src/houserules.js";
import { draftsPerIdea } from "../../src/render/service.js";
import { IDEAS_PER_BATCH } from "../../src/ideas/checks.js";
import { batchAtTruth, judgeIdeas, rankDrafts, v1Ideas } from "../helpers/batch.js";
import { approvedClient, callTool, config, createStudio, json, sessionCookie, type Studio } from "../helpers/deps.js";
import { fakeNet } from "../helpers/net.js";

const SCENE = "The pouch stands on a wet black rock at dusk, low camera, a wave about to break behind it.";
const LOGO_URL = "https://wongi.example/logo.png";
const REAL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=", "base64");
const refused = (pattern: RegExp) => ({ ok: false, error: expect.stringMatching(pattern) });
const rules = { rulesVersion: RULES_VERSION };
const IDEA_IDS = Array.from({ length: IDEAS_PER_BATCH }, (_, index) => `idea-${index + 1}`);

let studio: Studio;
let batchId: string;
/** The picture ids of the drafts, by idea, in the order they were sent. */
let drafts: Record<string, string[]>;

async function render(ideaId: string, kind: "draft" | "final", fromId?: string, references?: string[]) {
  const sent = await callTool(studio, "render_submit", { ...rules, batchId, ideaId, kind, prompt: SCENE, ...(fromId ? { fromId } : {}), ...(references ? { references } : {}) });
  if (!sent.ok) return sent;
  return callTool(studio, "render_status", { batchId, renderId: sent.value.id });
}

/** A v1 batch with ten finished drafts, none checked yet. */
async function batchWithDrafts() {
  studio = await createStudio({ net: fakeNet({ [LOGO_URL]: { body: REAL_PNG, headers: { "content-type": "image/png" } } }) });
  await approvedClient(studio);
  batchId = (await batchAtTruth(studio)).batchId;
  await callTool(studio, "ideas_save", { ...rules, batchId, ideas: v1Ideas() });
  await judgeIdeas(studio, batchId);
  drafts = {};
  for (const ideaId of IDEA_IDS) {
    for (let n = 0; n < draftsPerIdea("v1"); n++) {
      studio.clock.now = new Date(studio.clock.now.getTime() + 1000);
      (drafts[ideaId] ??= []).push((await render(ideaId, "draft")).value.image.id);
    }
  }
}

const check = (imageId: string, items: object[] = []) => callTool(studio, "checks_save", { ...rules, batchId, imageId, items });
/** Every draft looked at, and each idea's drafts ranked by the blind critic. */
const checkAll = async () => {
  for (const imageId of Object.values(drafts).flat()) await check(imageId);
  await rankDrafts(studio, batchId);
};
const pick = (ideaId: string, imageId: string | null, ownerSaid = "this one, the rock reads at once", as: { sub?: string } = {}) =>
  callTool(studio, "pick_save", { batchId, ideaId, imageId, ownerSaid }, as);
const state = async () => (await callTool(studio, "batch_get", { batchId })).value.batch.state;

beforeEach(batchWithDrafts);

describe("checks", () => {
  it("gives the meaning of every D and F code with the house rules", async () => {
    const got = await callTool(studio, "rules_get", { role: "main", kind: "v1" });
    expect(Object.keys(got.value.pictureChecks)).toHaveLength(19);
    expect(got.value.pictureChecks.D11).toMatch(/pack_check, 2%/);
    expect(got.value.pictureChecks.D1).toMatch(/^Writing in the picture\. No readable words/);
    // An ad with words: the owner's approved words, set by type_set, are not the D1 defect.
    const worded = await callTool(studio, "rules_get", { role: "critic", kind: "v2" });
    expect(worded.value.pictureChecks.D1).toMatch(/owner's approved headline, subline and footnote that type_set put on the picture.*no word the model drew/);
    expect(Object.keys(worded.value.pictureChecks)).toHaveLength(19);
  });

  it("moves the batch to checked only when every draft was looked at, and names what is missing", async () => {
    const [first, ...rest] = Object.values(drafts).flat();
    const one = await check(first!, [{ code: "F6", note: "Seven things to look at." }]);
    expect(one.value).toMatchObject({ state: "drafting", checks: { looked: true, items: [{ code: "F6" }] } });
    // Eight more looks, and the blind critic's rank of each idea's drafts.
    expect(one.value.stillMissing).toHaveLength(14);
    expect(await callTool(studio, "board_show", { batchId })).toEqual(refused(/board is not ready.*checks_save for picture/));
    // The dashboard shows the drafts so far, and tells the owner that he cannot pick yet.
    const early = await json(await studio.app.request(`/api/batches/${batchId}/board`, { headers: { cookie: await sessionCookie(studio) } }));
    expect(early.picking).toBe("not_yet");
    for (const imageId of rest) await check(imageId);
    expect(await state()).toBe("drafting");
    expect(await callTool(studio, "board_show", { batchId })).toEqual(refused(/still missing: the blind critic's rank of the drafts of idea-1/i));
    expect((await rankDrafts(studio, batchId)).value).toMatchObject({ state: "checked", saved: IDEA_IDS });
  });

  it("keeps a D item that a tool measured: the agent's save cannot remove it", async () => {
    const [first] = drafts["idea-1"]!;
    await studio.services.checks.measure(batchId, first!, PACK_CHECK, { code: "D11", note: "The pouch is 5% wider than the packshot." });
    const saved = await check(first!, []);
    expect(saved.value.checks.items).toEqual([{ code: "D11", note: "The pouch is 5% wider than the packshot.", tool: PACK_CHECK }]);
    expect(saved.value.note).toMatch(/has D11, so it cannot become a final/);
    // A new measure that passes is the only thing that clears it.
    expect((await studio.services.checks.measure(batchId, first!, PACK_CHECK, null)).items).toEqual([]);
  });

  it("tracks food-only skeletons and zero-padded pack references correctly", async () => {
    const made = await batchAtTruth(studio);
    batchId = made.batchId;
    const product = await studio.services.brands.product(made.product.id);
    await studio.services.brands.saveProduct({ ...product, photos: [...product.photos, { key: "products/p/pack.png", sourceUrl: "https://cdn.wongi.example/pack.png", kind: "pack" }] });
    await callTool(studio, "ideas_save", { ...rules, batchId, ideas: v1Ideas() });
    await judgeIdeas(studio, batchId);
    const skeletonJob = await callTool(studio, "skeleton_make", {
      ...rules,
      batchId,
      ideaId: "idea-1",
      plan: { bg: "E83C28", products: [{ cx: 0.5, base: 0.85, height: 0.3, photo: "food-1" }] },
    });
    const skeleton = await callTool(studio, "pixel_status", { batchId, jobId: skeletonJob.value.id });
    const imageIds: string[] = [];
    let foodOnlyDraft: string | undefined;
    let zeroPaddedPackDraft: string | undefined;
    for (const ideaId of IDEA_IDS) {
      for (let n = 0; n < draftsPerIdea("v1"); n += 1) {
        studio.clock.now = new Date(studio.clock.now.getTime() + 1000);
        const fromId = ideaId === "idea-1" && n === 0 ? skeleton.value.image.id : undefined;
        const references = ideaId === "idea-1" && n === 1 ? ["pack-01"] : undefined;
        const rendered = await render(ideaId, "draft", fromId, references);
        const imageId = rendered.value.image.id as string;
        imageIds.push(imageId);
        if (fromId) foodOnlyDraft = imageId;
        if (references) zeroPaddedPackDraft = imageId;
      }
    }
    const firstCheck = await check(foodOnlyDraft!);
    expect(firstCheck.value.stillMissing).not.toContain(`pack_check for picture ${foodOnlyDraft}`);
    expect(firstCheck.value.stillMissing).toContain(`pack_check for picture ${zeroPaddedPackDraft}`);
    const packMeasure = await callTool(studio, "pack_check", {
      batchId,
      imageId: zeroPaddedPackDraft!,
      photo: "pack-1",
      at: [512, 900],
      bg: "E83C28",
    });
    expect(packMeasure.ok).toBe(true);
    await callTool(studio, "pixel_status", { batchId, jobId: packMeasure.value.id });
    for (const imageId of imageIds.filter((id) => id !== foodOnlyDraft)) await check(imageId);
    await rankDrafts(studio, batchId);
    expect(await state()).toBe("checked");
    expect((await callTool(studio, "board_show", { batchId })).value.batch.state).toBe("waiting_pick");
  });

  it("requires logo_set and its check on every v1 draft when the brand has a saved logo", async () => {
    const batch = await studio.services.batches.get(batchId);
    const brand = await studio.services.brands.brand(batch.brandId);
    await studio.services.brands.saveBrand({ ...brand, logo: { key: "brands/b/logo.png", sourceUrl: "https://cdn.wongi.example/logo.png" } });
    await checkAll();
    expect(await state()).toBe("drafting");
    const lastCheck = await check(drafts["idea-1"]![0]!);
    expect(lastCheck.value.stillMissing).toEqual(expect.arrayContaining([expect.stringMatching(/logo_set for picture/)]));
  });

  it("requires logo_set on a drafting batch after brand_logo_save", async () => {
    const batch = await studio.services.batches.get(batchId);
    const offer = await studio.services.brands.offer({
      kind: "brand",
      url: "https://wongi.example/",
      pageUrl: "https://wongi.example/",
      logos: [LOGO_URL],
      photos: [],
      productPages: [],
      colours: [],
    });

    const saved = await callTool(studio, "brand_logo_save", { brandId: batch.brandId, extractId: offer.id, logoUrl: LOGO_URL });
    expect(saved.ok).toBe(true);
    const afterSave = await studio.services.batches.get(batchId);
    expect(afterSave.state).toBe("drafting");
    const imageId = drafts["idea-1"]![0]!;
    const checked = await check(imageId);
    expect(checked.value.state).toBe("drafting");
    expect(checked.value.stillMissing).toContain(`logo_set for picture ${imageId}: the brand's real logo on the draft`);
  });

  it("delivers an unstamped picked draft after a later logo save", async () => {
    await checkAll();
    const before = await callTool(studio, "board_show", { batchId });
    expect(before.value.batch.state).toBe("waiting_pick");
    expect(await state()).toBe("waiting_pick");

    const batch = await studio.services.batches.get(batchId);
    const offer = await studio.services.brands.offer({
      kind: "brand",
      url: "https://wongi.example/",
      pageUrl: "https://wongi.example/",
      logos: [LOGO_URL],
      photos: [],
      productPages: [],
      colours: [],
    });
    const saved = await callTool(studio, "brand_logo_save", { brandId: batch.brandId, extractId: offer.id, logoUrl: LOGO_URL });
    expect(saved.ok).toBe(true);
    expect(await studio.services.batches.get(batchId)).toMatchObject({ state: "waiting_pick" });

    const page = await json(await studio.app.request(`/api/batches/${batchId}/board`, { headers: { cookie: await sessionCookie(studio) } }));
    expect(page.batch.state).toBe("waiting_pick");
    expect(page.picking).toBe("open");
    expect(await state()).toBe("waiting_pick");

    const after = await callTool(studio, "board_show", { batchId });
    expect(after.value.batch.state).toBe("waiting_pick");
    expect(after.value.picking).toBe("open");
    expect(after.value.ideas.map((entry: { idea: { id: string }; drafts: { image: { id: string } }[] }) => ({
      ideaId: entry.idea.id,
      drafts: entry.drafts.map(({ image }) => image.id),
    }))).toEqual(before.value.ideas.map((entry: { idea: { id: string }; drafts: { image: { id: string } }[] }) => ({
      ideaId: entry.idea.id,
      drafts: entry.drafts.map(({ image }) => image.id),
    })));
    expect((await pick("idea-1", drafts["idea-1"]![0]!)).ok).toBe(true);
    expect(await state()).toBe("waiting_pick");

    const final = await render("idea-1", "final", drafts["idea-1"]![0]!);
    expect(final.ok).toBe(true);
    expect((await check(final.value.image.id)).ok).toBe(true);
    const job = await callTool(studio, "photo_finish", { ...rules, batchId, imageId: final.value.image.id });
    expect(job.ok).toBe(true);
    expect((await callTool(studio, "pixel_status", { batchId, jobId: job.value.id })).ok).toBe(true);

    const delivered = (await studio.services.board.finals(await studio.services.batches.get(batchId))).find((entry) => entry.ideaId === "idea-1");
    expect(delivered?.missing).toEqual([]);
    expect(delivered?.delivered).toMatchObject({ kind: "finish", fromId: final.value.image.id });
  });

  it("keeps the picked stamp's placement over a newer repair stamp", async () => {
    const batch = await studio.services.batches.get(batchId);
    const brand = await studio.services.brands.brand(batch.brandId);
    await studio.services.brands.saveBrand({
      ...brand,
      logo: { key: `brands/${brand.id}/logo.png`, sourceUrl: LOGO_URL },
    });

    const pickedDraft = drafts["idea-1"]![0]!;
    const pickedPlacement = { logoWidth: 0.22, logoTop: 0.05, logoColour: "FFFFFF" };
    const repairPlacement = { logoWidth: 0.45, logoTop: 0.18, logoColour: "000000" };
    let pickedStampId: string | undefined;
    for (const imageId of Object.values(drafts).flat()) {
      const placement = imageId === pickedDraft
        ? pickedPlacement
        : { logoWidth: 0.3, logoTop: 0.08, logoColour: "000000" };
      const stampedDraft = await callTool(studio, "logo_set", {
        ...rules,
        batchId,
        imageId,
        ...placement,
      });
      expect(stampedDraft.ok).toBe(true);
      const stamped = await callTool(studio, "pixel_status", { batchId, jobId: stampedDraft.value.id });
      expect(stamped.ok).toBe(true);
      expect(stamped.value.status).toBe("done");
      expect((await check(stamped.value.image.id)).ok).toBe(true);
      if (imageId === pickedDraft) pickedStampId = stamped.value.image.id;
    }
    await checkAll();
    expect(await state()).toBe("checked");

    expect((await pick("idea-1", pickedDraft)).ok).toBe(true);
    const savedPick = (await studio.services.picks.all(batchId)).find((entry) => entry.ideaId === "idea-1");
    expect(savedPick?.shownId).toBe(pickedStampId);
    const legacyPick = { ...savedPick! };
    delete legacyPick.shownId;
    const beforeRepair = await studio.services.images.list(batchId);
    expect(pickedStamp(savedPick!, beforeRepair)?.id).toBe(pickedStampId);
    expect(pickedStamp(legacyPick, beforeRepair)?.id).toBe(pickedStampId);

    const product = await studio.services.brands.product(batch.productId);
    await studio.services.brands.saveProduct({
      ...product,
      photos: [...product.photos, { key: "products/p/pack.png", sourceUrl: "https://cdn.wongi.example/pack.png", kind: "pack" }],
    });
    const swapJob = await callTool(studio, "product_swap", { ...rules, batchId, imageId: pickedDraft, old: [400, 620, 500, 1100] });
    expect(swapJob.ok).toBe(true);
    const repaired = await callTool(studio, "pixel_status", { batchId, jobId: swapJob.value.id });
    expect(repaired.ok).toBe(true);
    expect(repaired.value.image).toMatchObject({ kind: "swap", fromId: pickedDraft, rootId: pickedDraft });
    expect((await check(repaired.value.image.id)).ok).toBe(true);
    expect(pickedStamp(legacyPick, await studio.services.images.list(batchId))?.id).toBe(pickedStampId);

    const final = await render("idea-1", "final", pickedDraft);
    expect(final.ok).toBe(true);
    expect((await check(final.value.image.id)).ok).toBe(true);
    const job = await callTool(studio, "photo_finish", { ...rules, batchId, imageId: final.value.image.id });
    expect(job.ok).toBe(true);
    const finished = await callTool(studio, "pixel_status", { batchId, jobId: job.value.id });
    expect(finished.ok).toBe(true);

    const beforeStamp = (await studio.services.board.finals(await studio.services.batches.get(batchId))).find((entry) => entry.ideaId === "idea-1");
    expect(beforeStamp?.missing).toContain(
      `logo_set for picture ${final.value.image.id}: the brand's real logo on the finished final`,
    );

    const repairStampJob = await callTool(studio, "logo_set", {
      ...rules,
      batchId,
      imageId: repaired.value.image.id,
      ...repairPlacement,
    });
    expect(repairStampJob.ok).toBe(true);
    const repairStamp = await callTool(studio, "pixel_status", { batchId, jobId: repairStampJob.value.id });
    expect(repairStamp.ok).toBe(true);
    expect(repairStamp.value.image).toMatchObject({ kind: "typeset", fromId: repaired.value.image.id, rootId: pickedDraft });
    expect(studio.pixels.events.at(-1)!.input).toMatchObject({
      logoKey: `brands/${brand.id}/logo.png`,
      ...repairPlacement,
    });

    const stampedFinalJob = await callTool(studio, "logo_set", {
      ...rules,
      batchId,
      imageId: final.value.image.id,
      logoWidth: 0.4,
      logoTop: 0.1,
      logoColour: "000000",
    });
    expect(stampedFinalJob.ok).toBe(true);
    const stampedFinal = await callTool(studio, "pixel_status", { batchId, jobId: stampedFinalJob.value.id });
    expect(stampedFinal.ok).toBe(true);
    const finalLogoInput = studio.pixels.events.at(-1)!.input;
    expect(finalLogoInput).toMatchObject({
      logoKey: `brands/${brand.id}/logo.png`,
      ...pickedPlacement,
      renderKey: finished.value.image.key,
    });
    expect(finalLogoInput.logoWidth).not.toBe(repairPlacement.logoWidth);
    expect(finalLogoInput.logoTop).not.toBe(repairPlacement.logoTop);
    const stampId = stampedFinal.value.image.id;
    const beforeStampCheck = (await studio.services.board.finals(await studio.services.batches.get(batchId))).find((entry) => entry.ideaId === "idea-1");
    expect(beforeStampCheck?.missing).toContain(
      `checks_save for picture ${stampId}: the finished final of ${final.value.image.id} with its logo`,
    );

    expect((await check(stampId)).ok).toBe(true);
    const delivered = (await studio.services.board.finals(await studio.services.batches.get(batchId))).find((entry) => entry.ideaId === "idea-1");
    expect(delivered?.missing).toEqual([]);
    expect(delivered?.delivered).toMatchObject({ id: stampId, kind: "typeset" });
  });

  it("refuses checks for a picture that is not a draft or a final, and from a caller that did not read the rules", async () => {
    const skeleton = await studio.services.images.add({ batchId, kind: "skeleton", key: "batches/b/skeletons/s.png" });
    expect(await check(skeleton.id)).toEqual(refused(/is a skeleton/));
    expect(await callTool(studio, "checks_save", { batchId, imageId: drafts["idea-1"]![0], items: [] })).toEqual(refused(/Call rules_get/));
  });
});

describe("pick board", () => {
  beforeEach(checkAll);

  it("shows five ideas with two drafts each numbered in order, with no rank, beside the truth sheet", async () => {
    const board = (await callTool(studio, "board_show", { batchId })).value;
    expect(board.batch.state).toBe("waiting_pick");
    expect(board.truthSheet).toMatchObject({ version: 1 });
    expect(board.ideas).toHaveLength(IDEAS_PER_BATCH);
    for (const entry of board.ideas) {
      expect(entry.drafts.map((draft: { number: number }) => draft.number)).toEqual([1, 2]);
      expect(entry.drafts.map((draft: { image: { id: string } }) => draft.image.id)).toEqual(drafts[entry.idea.id]);
      expect(entry.pick).toBeNull();
      // The blind critic has ranked these drafts. The board keeps that from him until he has picked.
      expect(entry.rank).toBeNull();
    }
    expect(JSON.stringify(board)).not.toMatch(/"order"|score|only this brand could run it/i);
  });

  it("saves the owner's pick with his words to the taste log, and refuses a member's", async () => {
    await callTool(studio, "board_show", { batchId });
    expect(await pick("idea-1", drafts["idea-1"]![1]!, "this one", { sub: "sub-member" })).toEqual(refused(/Only the owner picks/));
    expect(await pick("idea-1", drafts["idea-2"]![0]!)).toEqual(refused(/not a draft of idea-1/));
    expect((await pick("idea-1", drafts["idea-1"]![1]!)).value.pick).toMatchObject({ ideaId: "idea-1", imageId: drafts["idea-1"]![1], by: "owner@example.com" });
    const log = (await callTool(studio, "taste_log", {})).value.entries;
    expect(log[0]).toMatchObject({ kind: "pick", ownerSaid: "this one, the rock reads at once", about: "WonGi, Seaweed crisps. Idea 1: draft 2 of 2.", batchId, ideaId: "idea-1", draftId: drafts["idea-1"]![1] });
  });

  it("saves a pass on both drafts with the owner's note", async () => {
    await pick("idea-2", null, "none of these: the wave hides the pack");
    const log = (await callTool(studio, "taste_log", {})).value.entries;
    expect(log[0]).toMatchObject({ kind: "pass", ownerSaid: "none of these: the wave hides the pack", about: expect.stringMatching(/passed on all 2 drafts/) });
    expect((await callTool(studio, "board_show", { batchId })).value.ideas[1].pick).toMatchObject({ imageId: null });
  });

  it("replaces a pick with a second one for the same idea and keeps both in the log", async () => {
    await pick("idea-1", drafts["idea-1"]![0]!, "first thought");
    studio.clock.now = new Date(studio.clock.now.getTime() + 1000);
    await pick("idea-1", drafts["idea-1"]![1]!, "no, the second: calmer");
    expect((await callTool(studio, "board_show", { batchId })).value.ideas[0].pick).toMatchObject({ imageId: drafts["idea-1"]![1] });
    const log = (await callTool(studio, "taste_log", {})).value.entries.filter((entry: { ideaId?: string }) => entry.ideaId === "idea-1");
    expect(log.map((entry: { ownerSaid: string }) => entry.ownerSaid)).toEqual(["no, the second: calmer", "first thought"]);
  });

  it("gives the board to a signed-in dashboard and takes the owner's pick there, from the same origin only", async () => {
    const path = `/api/batches/${batchId}/board`;
    expect((await studio.app.request(path)).status).toBe(401);
    const board = await json(await studio.app.request(path, { headers: { cookie: await sessionCookie(studio) } }));
    expect(board.ideas[0].drafts[0].viewUrl).toContain("signed=1");
    expect(board.picking).toBe("open");

    const post = (cookie: string, origin: string) =>
      studio.app.request(`/api/batches/${batchId}/picks`, {
        method: "POST",
        headers: { cookie, origin, "content-type": "application/json" },
        body: JSON.stringify({ ideaId: "idea-1", imageId: drafts["idea-1"]![0], ownerSaid: "the first" }),
      });
    expect((await post(await sessionCookie(studio, "member"), config.publicOrigin)).status).toBe(403);
    expect((await post(await sessionCookie(studio), "https://evil.example")).status).toBe(403);
    expect((await post(await sessionCookie(studio), config.publicOrigin)).status).toBe(200);
    expect(await state()).toBe("waiting_pick");
  });
});

describe("finals", () => {
  beforeEach(async () => {
    await checkAll();
    await callTool(studio, "board_show", { batchId });
  });

  it("makes a final only from the draft the owner picked", async () => {
    expect(await render("idea-1", "final", drafts["idea-1"]![0])).toEqual(refused(/R24.*has not picked a draft of idea-1/));
    await pick("idea-1", drafts["idea-1"]![1]!);
    expect(await render("idea-1", "final", drafts["idea-1"]![0])).toEqual(refused(/R24.*he picked picture/));
    await pick("idea-2", null, "none");
    expect(await render("idea-2", "final", drafts["idea-2"]![0])).toEqual(refused(/R24.*passed on all the drafts/));

    const final = await render("idea-1", "final", drafts["idea-1"]![1]);
    expect(final.value).toMatchObject({ kind: "final", status: "done", image: { kind: "final", fromId: drafts["idea-1"]![1] } });
    expect(studio.fal.submits().at(-1)?.body).toMatchObject({ image_size: { width: 1536, height: 1920 }, quality: "high" });
    expect(await state()).toBe("finals");
  });

  it("covers AE4: refuses a final for a picked draft with a D item, and names the item", async () => {
    const picked = drafts["idea-1"]![0]!;
    await studio.services.checks.measure(batchId, picked, PACK_CHECK, { code: "D11", note: "The pouch is 5% wider than the packshot." });
    expect((await pick("idea-1", picked)).value.note).toMatch(/has D11.*no final can be made/);
    expect(await render("idea-1", "final", picked)).toEqual(refused(/R35: this draft has D11 \(The pouch is 5% wider than the packshot\.\)/));
  });

  it("moves the batch to finished when every picked idea has a checked final with no D item", async () => {
    await pick("idea-1", drafts["idea-1"]![0]!);
    await pick("idea-2", null, "none");
    await pick("idea-3", drafts["idea-3"]![1]!);
    await pick("idea-4", null, "none");
    await pick("idea-5", null, "none");
    const first = await render("idea-1", "final", drafts["idea-1"]![0]);
    expect(first.value.note).toMatch(/2 finals come to about US\$0\.15, under US\$1/);
    const bad = await check(first.value.image.id, [{ code: "D10", note: "The pack keeps its studio highlight." }]);
    expect(bad.value).toMatchObject({ state: "finals", stillMissing: expect.arrayContaining([expect.stringMatching(/^a finished final of idea-3, from the picked draft/)]) });

    const third = await render("idea-3", "final", drafts["idea-3"]![1]);
    await check(third.value.image.id);
    expect(await state()).toBe("finals");
    // The failed final is made again; the newest one is the one that counts.
    studio.clock.now = new Date(studio.clock.now.getTime() + 1000);
    const again = await render("idea-1", "final", drafts["idea-1"]![0]);
    // Checked, but not yet finished: each final still needs its real-camera finish.
    expect((await check(again.value.image.id)).value).toMatchObject({
      state: "finals",
      stillMissing: [`photo_finish for picture ${again.value.image.id}`, `photo_finish for picture ${third.value.image.id}`],
    });
    const finish = async (imageId: string) => {
      const job = await callTool(studio, "photo_finish", { ...rules, batchId, imageId });
      return (await callTool(studio, "pixel_status", { batchId, jobId: job.value.id })).value;
    };
    expect((await finish(again.value.image.id)).state).toBe("finals");
    expect((await finish(third.value.image.id)).state).toBe("finished");

    // A D item found after the end takes the batch back to its finals.
    expect((await check(third.value.image.id, [{ code: "D2", note: "The fish skin has no curry leaf." }])).value).toMatchObject({ state: "finals" });
    expect((await check(third.value.image.id)).value).toMatchObject({ state: "finished" });
  });

  const finished = async (ideaId: string, draftId: string, items: object[] = []) => {
    studio.clock.now = new Date(studio.clock.now.getTime() + 1000);
    const final = await render(ideaId, "final", draftId);
    await check(final.value.image.id, items);
    const job = await callTool(studio, "photo_finish", { ...rules, batchId, imageId: final.value.image.id });
    return (await callTool(studio, "pixel_status", { batchId, jobId: job.value.id })).value;
  };

  it("does not finish while an idea has no pick and no pass", async () => {
    await pick("idea-1", drafts["idea-1"]![0]!);
    await pick("idea-2", null, "none");
    expect(await finished("idea-1", drafts["idea-1"]![0]!)).toMatchObject({
      state: "finals",
      stillMissing: ["the owner's pick, or his pass, for idea-3", "the owner's pick, or his pass, for idea-4", "the owner's pick, or his pass, for idea-5"],
    });
    await pick("idea-3", null, "none of these");
    await pick("idea-4", null, "none of these");
    await pick("idea-5", null, "none of these");
    expect((await check(drafts["idea-1"]![1]!)).value.state).toBe("finished");
  });

  it("does not finish on a final with two F items, or on the final of a draft he no longer picks", async () => {
    await pick("idea-1", drafts["idea-1"]![0]!);
    await pick("idea-2", null, "none");
    await pick("idea-3", null, "none");
    await pick("idea-4", null, "none");
    await pick("idea-5", null, "none");
    const faults = [{ code: "F1", note: "The rope sags too far." }, { code: "F2", note: "The plinth edge is soft." }];
    expect(await finished("idea-1", drafts["idea-1"]![0]!, faults)).toMatchObject({ state: "finals", stillMissing: ["a final of idea-1 with fewer than two F items"] });
    await pick("idea-1", drafts["idea-1"]![1]!, "the second one after all");
    expect((await check(drafts["idea-1"]![1]!)).value).toMatchObject({ state: "finals", stillMissing: [expect.stringMatching(/a finished final of idea-1, from the picked draft/)] });
    expect((await finished("idea-1", drafts["idea-1"]![1]!)).state).toBe("finished");
  });
});
