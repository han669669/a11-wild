import { beforeEach, describe, expect, it, vi } from "vitest";
import { RULES_VERSION } from "../../src/houserules.js";
import type { PixelEvent } from "../../src/pixels/runner.js";
import { batchAtTruth, judgeIdeas, v1Ideas } from "../helpers/batch.js";
import { approvedClient, callTool, createStudio, type Studio } from "../helpers/deps.js";
import { fakeNet } from "../helpers/net.js";
import { PNG } from "../helpers/pictures.js";

const SCENE = "The pouch stands on a wet black rock at dusk, low camera, a wave about to break behind it.";
const refused = (pattern: RegExp) => ({ ok: false, error: expect.stringMatching(pattern) });
const rules = { rulesVersion: RULES_VERSION };
const PACK = "products/p/pack.png";
const PACK_TWO_URL = "https://cdn.wongi.example/clean-pack.png";
const JPEG_WIDTH_512 = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 2, 128, 2, 0, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]);
const JPEG_WIDTH_1536 = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 7, 128, 6, 0, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]);

let studio: Studio;
let batchId: string;

/** A v1 batch with five ideas whose product has a pack photo. */
async function start(
  pixels?: (event: PixelEvent) => ReturnType<NonNullable<Parameters<typeof createStudio>[0]>["pixels"] & object>,
  net?: NonNullable<Parameters<typeof createStudio>[0]>["net"],
) {
  studio = await createStudio({ ...(pixels ? { pixels } : {}), ...(net ? { net } : {}) });
  await approvedClient(studio);
  const made = await batchAtTruth(studio);
  batchId = made.batchId;
  await studio.services.brands.saveProduct({ ...made.product, photos: [...made.product.photos, { key: PACK, sourceUrl: "https://cdn.wongi.example/pack.png", kind: "pack" }] });
  await callTool(studio, "ideas_save", { ...rules, batchId, ideas: v1Ideas() });
  await judgeIdeas(studio, batchId);
}

const status = async (jobId: string) => (await callTool(studio, "pixel_status", { batchId, jobId })).value;
/** Runs a pixel tool to its end. */
async function run(tool: string, args: object) {
  const creative = ["product_reprint", "product_swap", "photo_finish"].includes(tool);
  const sent = await callTool(studio, tool, { batchId, ...(creative ? rules : {}), ...args });
  if (!sent.ok) return sent;
  return { ok: true as const, value: await status(sent.value.id) };
}
const skeleton = (ideaId = "idea-1", extra: object = { bg: "E83C28" }) => run("skeleton_make", { ...rules, ideaId, ...extra });
async function draft(ideaId = "idea-1", extra?: object) {
  const made = await skeleton(ideaId, extra);
  studio.clock.now = new Date(studio.clock.now.getTime() + 1000);
  const sent = await callTool(studio, "render_submit", { ...rules, batchId, ideaId, kind: "draft", prompt: SCENE, fromId: made.value.image.id });
  return (await callTool(studio, "render_status", { batchId, renderId: sent.value.id })).value.image.id as string;
}

async function appendPackTwo() {
  const batch = await studio.services.batches.get(batchId);
  const extract = await studio.services.brands.offer({
    kind: "product",
    url: "https://wongi.example/products/seaweed-crisps",
    pageUrl: "https://wongi.example/products/seaweed-crisps",
    logos: [],
    photos: [PACK_TWO_URL],
    productPages: [],
    colours: [],
  });
  const added = await callTool(studio, "product_photos_add", {
    productId: batch.productId,
    extractId: extract.id,
    photos: [{ url: PACK_TWO_URL, kind: "pack" }],
  });
  return added.value.product.photos.find((photo: { sourceUrl: string }) => photo.sourceUrl === PACK_TWO_URL);
}

beforeEach(() => start());

describe("skeleton_make", () => {
  it("sends the real pack photo by its key, and saves the skeleton as a picture of the batch", async () => {
    const made = await skeleton("idea-1", { bg: "#E83C28", height: 0.6 });
    expect(made.value.image.pack).toBe("pack-1");
    expect(made.value).toMatchObject({ tool: "skeleton", status: "done", image: { kind: "skeleton", ideaId: "idea-1", viewUrl: expect.stringContaining("signed=1") } });
    const [event] = studio.pixels.events;
    expect(event).toMatchObject({ tool: "skeleton", batchId, input: { packKey: PACK, bg: "#E83C28", height: 0.6 } });
    expect(event!.outKey).toBe(`batches/${batchId}/skeletons/${event!.jobId}.jpg`);
    expect(event!.resultKey).toBe(`jobs/${batchId}/${event!.jobId}.json`);
    // The draft of this idea can now be built round it.
    const sent = await callTool(studio, "render_submit", { ...rules, batchId, ideaId: "idea-1", kind: "draft", prompt: SCENE, fromId: made.value.image.id });
    expect(sent.ok).toBe(true);
  });

  it("defaults a uniform pack-2 plan to its photo for skeletons and repairs", async () => {
    await start(undefined, fakeNet({ [PACK_TWO_URL]: { body: PNG, headers: { "content-type": "image/png" } } }));
    const packTwo = await appendPackTwo();
    const made = await skeleton("idea-1", {
      plan: {
        bg: "E83C28",
        products: [
          { cx: 0.35, base: 0.9, height: 0.45, photo: "pack-2", cutout: { darkMax: 45, edges: "left" } },
          { cx: 0.65, base: 0.9, height: 0.45, photo: "pack-2", cutout: { darkMax: 60, edges: "right" } },
        ],
      },
    });
    expect(made.value.image).toMatchObject({ kind: "skeleton", pack: "pack-2" });
    expect(studio.pixels.events.at(-1)!.input).not.toHaveProperty("packKey");

    const sent = await callTool(studio, "render_submit", { ...rules, batchId, ideaId: "idea-1", kind: "draft", prompt: SCENE, fromId: made.value.image.id });
    const imageId = (await callTool(studio, "render_status", { batchId, renderId: sent.value.id })).value.image.id;
    await run("pack_check", { imageId, at: [512, 900], bg: "E83C28" });
    expect(studio.pixels.events.at(-1)!.input).toMatchObject({ packKey: packTwo.key, cutout: { darkMax: 45, edges: "left" }, pack: 1 });
    await run("pack_check", { imageId, at: [512, 900], bg: "E83C28", pack: 1 });
    expect(studio.pixels.events.at(-1)!.input).toMatchObject({ packKey: packTwo.key, cutout: { darkMax: 45, edges: "left" }, pack: 1 });
    await run("product_swap", { imageId, old: [400, 620, 500, 1100] });
    expect(studio.pixels.events.at(-1)!.input).toMatchObject({ packKey: packTwo.key, cutout: { darkMax: 45, edges: "left" }, pack: 1 });
    await run("pack_check", { imageId, at: [512, 900], bg: "E83C28", photo: "pack-2" });
    expect(studio.pixels.events.at(-1)!.input).toMatchObject({ packKey: packTwo.key, cutout: { darkMax: 45, edges: "left" }, pack: 1 });
  });

  it("refuses a pack check or swap when a plan has only food photos", async () => {
    await start();
    const made = await skeleton("idea-1", {
      plan: {
        bg: "E83C28",
        products: [
          { cx: 0.35, base: 0.9, height: 0.45, photo: "food-1" },
          { cx: 0.65, base: 0.9, height: 0.45, photo: "food-1" },
        ],
      },
    });
    const sent = await callTool(studio, "render_submit", { ...rules, batchId, ideaId: "idea-1", kind: "draft", prompt: SCENE, fromId: made.value.image.id });
    const imageId = (await callTool(studio, "render_status", { batchId, renderId: sent.value.id })).value.image.id;

    expect(await run("pack_check", { imageId, at: [512, 900], bg: "E83C28" })).toEqual(
      refused(/This picture's plan has no pack 1/),
    );
    expect(await run("pack_check", { imageId, at: [512, 900], bg: "E83C28", photo: "pack-1" })).toEqual(
      refused(/This picture did not use pack photo pack-1/),
    );
    expect(await run("product_swap", { imageId, old: [400, 620, 500, 1100] })).toEqual(
      refused(/This picture's plan has no pack 1/),
    );
  });

  it("selects a repeated pack photo by position, not by the result label", async () => {
    await start();
    const firstBox = [10, 20, 110, 220];
    const secondBox = [30, 40, 330, 440];
    const made = await skeleton("idea-1", {
      plan: {
        bg: "E83C28",
        products: [
          { cx: 0.35, base: 0.9, height: 0.45, photo: "pack-1", box: firstBox, cutout: { darkMax: 30 } },
          { cx: 0.65, base: 0.9, height: 0.45, photo: "pack-1", box: secondBox, cutout: { darkMax: 60 } },
        ],
      },
    });
    const sent = await callTool(studio, "render_submit", { ...rules, batchId, ideaId: "idea-1", kind: "draft", prompt: SCENE, fromId: made.value.image.id });
    const imageId = (await callTool(studio, "render_status", { batchId, renderId: sent.value.id })).value.image.id;

    await run("pack_check", { imageId, at: [700, 900], bg: "E83C28", pack: 1 });
    expect(studio.pixels.events.at(-1)!.input).toMatchObject({ packKey: PACK, box: secondBox, cutout: { darkMax: 60 }, pack: 1 });
  });

  it("keeps plan order when positions are equally near", async () => {
    await start(undefined, fakeNet({ [PACK_TWO_URL]: { body: PNG, headers: { "content-type": "image/png" } } }));
    await appendPackTwo();
    const leftBox = [20, 30, 220, 430];
    const made = await skeleton("idea-1", {
      plan: {
        bg: "E83C28",
        products: [
          { cx: 0.75, base: 0.9, height: 0.45, photo: "pack-1", box: [300, 40, 500, 440], cutout: { darkMax: 30 } },
          { cx: 0.25, base: 0.9, height: 0.45, photo: "pack-2", box: leftBox, cutout: { darkMax: 60 } },
        ],
      },
    });
    const sent = await callTool(studio, "render_submit", { ...rules, batchId, ideaId: "idea-1", kind: "draft", prompt: SCENE, fromId: made.value.image.id });
    const imageId = (await callTool(studio, "render_status", { batchId, renderId: sent.value.id })).value.image.id;

    await run("pack_check", { imageId, at: [512, 900], bg: "E83C28", pack: 1 });
    expect(studio.pixels.events.at(-1)!.input).toMatchObject({ packKey: PACK, box: [300, 40, 500, 440], cutout: { darkMax: 30 }, pack: 1 });
  });

  it("selects a product-swap reference by the centre of the old pack", async () => {
    await start();
    const firstBox = [10, 20, 110, 220];
    const secondBox = [30, 40, 330, 440];
    const made = await skeleton("idea-1", {
      plan: {
        bg: "E83C28",
        products: [
          { cx: 0.35, base: 0.9, height: 0.45, photo: "pack-1", box: firstBox, cutout: { darkMax: 30 } },
          { cx: 0.65, base: 0.9, height: 0.45, photo: "pack-1", box: secondBox, cutout: { darkMax: 60 } },
        ],
      },
    });
    const sent = await callTool(studio, "render_submit", { ...rules, batchId, ideaId: "idea-1", kind: "draft", prompt: SCENE, fromId: made.value.image.id });
    const imageId = (await callTool(studio, "render_status", { batchId, renderId: sent.value.id })).value.image.id;

    await run("product_swap", { imageId, old: [600, 760, 620, 1100], pack: 3 });
    expect(studio.pixels.events.at(-1)!.input).toMatchObject({ packKey: PACK, box: secondBox, cutout: { darkMax: 60 }, pack: 3 });
  });

  it("uses the picture width when the skeleton plan did not record a canvas size", async () => {
    await start();
    const skeletonJob = await studio.services.pixels.skeleton({
      batchId,
      ideaId: "idea-1",
      placement: {
        plan: {
          bg: "E83C28",
          products: [
            { cx: 0.25, base: 0.9, height: 0.45, photo: "pack-1", box: [10, 20, 110, 220], cutout: { darkMax: 30 } },
            { cx: 0.75, base: 0.9, height: 0.45, photo: "pack-1", box: [30, 40, 330, 440], cutout: { darkMax: 60 } },
          ],
        },
      },
    });
    const made = await status(skeletonJob.id);
    const sent = await callTool(studio, "render_submit", { ...rules, batchId, ideaId: "idea-1", kind: "draft", prompt: SCENE, fromId: made.image!.id });
    const image = (await callTool(studio, "render_status", { batchId, renderId: sent.value.id })).value.image;
    await studio.pictures.put(image.key, JPEG_WIDTH_512, "image/jpeg");

    await run("pack_check", { imageId: image.id, at: [350, 450], bg: "E83C28" });
    expect(studio.pixels.events.at(-1)!.input).toMatchObject({ packKey: PACK, box: [30, 40, 330, 440], cutout: { darkMax: 60 }, pack: 1 });
  });

  it("selects vertically stacked packs by 2D position for checks and swaps", async () => {
    await start();
    const upperBox = [10, 20, 110, 220];
    const lowerBox = [30, 40, 330, 440];
    const made = await skeleton("idea-1", {
      plan: {
        bg: "E83C28",
        products: [
          { cx: 0.5, base: 0.35, height: 0.25, photo: "pack-1", box: upperBox, cutout: { darkMax: 30 } },
          { cx: 0.5, base: 0.85, height: 0.25, photo: "pack-1", box: lowerBox, cutout: { darkMax: 60 } },
        ],
      },
    });
    const sent = await callTool(studio, "render_submit", { ...rules, batchId, ideaId: "idea-1", kind: "draft", prompt: SCENE, fromId: made.value.image.id });
    const imageId = (await callTool(studio, "render_status", { batchId, renderId: sent.value.id })).value.image.id;

    await run("pack_check", { imageId, at: [512, 928], bg: "E83C28" });
    expect(studio.pixels.events.at(-1)!.input).toMatchObject({ packKey: PACK, box: lowerBox, cutout: { darkMax: 60 } });
    await run("product_swap", { imageId, old: [400, 624, 800, 1056] });
    expect(studio.pixels.events.at(-1)!.input).toMatchObject({ packKey: PACK, box: lowerBox, cutout: { darkMax: 60 } });
  });

  it("uses a final's height instead of the skeleton canvas for pack selection", async () => {
    await start();
    const upperBox = [10, 20, 110, 220];
    const lowerBox = [30, 40, 330, 440];
    const made = await skeleton("idea-1", {
      plan: {
        bg: "E83C28",
        products: [
          { cx: 0.5, base: 0.65, height: 0.3, photo: "pack-1", box: upperBox, cutout: { darkMax: 30 } },
          { cx: 0.5, base: 0.95, height: 0.3, photo: "pack-1", box: lowerBox, cutout: { darkMax: 60 } },
        ],
      },
    });
    const sent = await callTool(studio, "render_submit", { ...rules, batchId, ideaId: "idea-1", kind: "draft", prompt: SCENE, fromId: made.value.image.id });
    const draft = (await callTool(studio, "render_status", { batchId, renderId: sent.value.id })).value.image;
    const final = await studio.services.images.add({
      batchId,
      kind: "final",
      key: `batches/${batchId}/finals/height.jpg`,
      ideaId: "idea-1",
      fromId: draft.id,
    });
    await studio.pictures.put(final.key, JPEG_WIDTH_1536, "image/jpeg");

    await run("pack_check", { imageId: final.id, at: [768, 960], bg: "E83C28" });
    expect(studio.pixels.events.at(-1)!.input).toMatchObject({ packKey: PACK, box: upperBox, cutout: { darkMax: 30 } });
    await run("product_swap", { imageId: final.id, old: [600, 936, 760, 1160] });
    expect(studio.pixels.events.at(-1)!.input).toMatchObject({ packKey: PACK, box: upperBox, cutout: { darkMax: 30 } });
  });

  it("uses a final's width instead of the skeleton canvas for pack selection", async () => {
    await start();
    const leftBox = [10, 20, 110, 220];
    const rightBox = [30, 40, 330, 440];
    const made = await skeleton("idea-1", {
      plan: {
        bg: "E83C28",
        products: [
          { cx: 0.45, base: 0.9, height: 0.45, photo: "pack-1", box: leftBox, cutout: { darkMax: 30 } },
          { cx: 0.75, base: 0.9, height: 0.45, photo: "pack-1", box: rightBox, cutout: { darkMax: 60 } },
        ],
      },
    });
    const sent = await callTool(studio, "render_submit", { ...rules, batchId, ideaId: "idea-1", kind: "draft", prompt: SCENE, fromId: made.value.image.id });
    const draft = (await callTool(studio, "render_status", { batchId, renderId: sent.value.id })).value.image;
    const final = await studio.services.images.add({
      batchId,
      kind: "final",
      key: `batches/${batchId}/finals/f.jpg`,
      ideaId: "idea-1",
      fromId: draft.id,
    });
    await studio.pictures.put(final.key, JPEG_WIDTH_1536, "image/jpeg");

    await run("pack_check", { imageId: final.id, at: [691, 1500], bg: "E83C28" });
    expect(studio.pixels.events.at(-1)!.input).toMatchObject({ packKey: PACK, box: leftBox, cutout: { darkMax: 30 } });
    await run("product_swap", { imageId: final.id, old: [600, 783, 1300, 1800] });
    expect(studio.pixels.events.at(-1)!.input).toMatchObject({ packKey: PACK, box: leftBox, cutout: { darkMax: 30 } });
  });

  it("accepts a count-based skeleton's pack 3 as the saved result label", async () => {
    await start();
    const made = await skeleton("idea-1", { bg: "E83C28", height: 0.6, count: 3 });
    const sent = await callTool(studio, "render_submit", { ...rules, batchId, ideaId: "idea-1", kind: "draft", prompt: SCENE, fromId: made.value.image.id });
    const imageId = (await callTool(studio, "render_status", { batchId, renderId: sent.value.id })).value.image.id;

    await run("pack_check", { imageId, at: [800, 900], bg: "E83C28", pack: 3 });
    expect(studio.pixels.events.at(-1)!.input).toMatchObject({ packKey: PACK, pack: 3 });
  });

  it("selects pack items by position without counting food photos", async () => {
    await start(undefined, fakeNet({ [PACK_TWO_URL]: { body: PNG, headers: { "content-type": "image/png" } } }));
    const packTwo = await appendPackTwo();
    const jarBox = [30, 40, 330, 440];
    const boxBox = [50, 60, 350, 460];
    const made = await skeleton("idea-1", {
      plan: {
        bg: "E83C28",
        products: [
          { cx: 0.2, base: 0.9, height: 0.35, photo: "food-1" },
          { cx: 0.5, base: 0.9, height: 0.45, photo: "pack-1", box: jarBox, cutout: { darkMax: 35 } },
          { cx: 0.8, base: 0.9, height: 0.5, photo: "pack-2", box: boxBox, cutout: { darkMax: 65 } },
        ],
      },
    });
    const sent = await callTool(studio, "render_submit", { ...rules, batchId, ideaId: "idea-1", kind: "draft", prompt: SCENE, fromId: made.value.image.id });
    const imageId = (await callTool(studio, "render_status", { batchId, renderId: sent.value.id })).value.image.id;

    await run("pack_check", { imageId, at: [350, 900], bg: "E83C28", pack: 1, photo: "pack-1" });
    expect(studio.pixels.events.at(-1)!.input).toMatchObject({ packKey: PACK, box: jarBox, cutout: { darkMax: 35 }, pack: 1 });
    await run("pack_check", { imageId, at: [700, 900], bg: "E83C28", pack: 2, photo: "pack-2" });
    expect(studio.pixels.events.at(-1)!.input).toMatchObject({ packKey: packTwo.key, box: boxBox, cutout: { darkMax: 65 }, pack: 2 });
    await run("pack_check", { imageId, at: [700, 900], bg: "E83C28", photo: "pack-2", pack: 2 });
    expect(studio.pixels.events.at(-1)!.input).toMatchObject({ packKey: packTwo.key, box: boxBox, cutout: { darkMax: 65 }, pack: 2 });
    await run("product_swap", { imageId, old: [600, 800, 700, 1100], pack: 2 });
    expect(studio.pixels.events.at(-1)!.input).toMatchObject({ packKey: packTwo.key, box: boxBox, cutout: { darkMax: 65 }, pack: 2 });
  });

  it("defaults the result label to one while selecting a mixed-plan pack by position", async () => {
    await start(undefined, fakeNet({ [PACK_TWO_URL]: { body: PNG, headers: { "content-type": "image/png" } } }));
    const packTwo = await appendPackTwo();
    const packBox = [50, 60, 350, 460];
    const packCutout = { darkMax: 65 };
    const made = await skeleton("idea-1", {
      plan: {
        bg: "E83C28",
        products: [
          { cx: 0.2, base: 0.9, height: 0.35, photo: "food-1" },
          { cx: 0.8, base: 0.9, height: 0.5, photo: "pack-2", box: packBox, cutout: packCutout },
        ],
      },
    });
    const sent = await callTool(studio, "render_submit", { ...rules, batchId, ideaId: "idea-1", kind: "draft", prompt: SCENE, fromId: made.value.image.id });
    const imageId = (await callTool(studio, "render_status", { batchId, renderId: sent.value.id })).value.image.id;

    await run("pack_check", { imageId, at: [700, 900], bg: "E83C28" });
    expect(studio.pixels.events.at(-1)!.input).toMatchObject({ packKey: packTwo.key, box: packBox, cutout: packCutout, pack: 1 });
  });

  it("uses skeleton-wide pack settings for the positioned default item", async () => {
    await start(undefined, fakeNet({ [PACK_TWO_URL]: { body: PNG, headers: { "content-type": "image/png" } } }));
    await appendPackTwo();
    const defaultBox = [40, 50, 640, 750];
    const defaultCutout = { darkMax: 25, edges: "right" };
    const made = await skeleton("idea-1", {
      pack: "pack-1",
      box: defaultBox,
      cutout: defaultCutout,
      plan: {
        bg: "E83C28",
        products: [
          { cx: 0.35, base: 0.9, height: 0.45, photo: "pack-2", box: [80, 90, 580, 690] },
          { cx: 0.65, base: 0.9, height: 0.45 },
        ],
      },
    });
    const sent = await callTool(studio, "render_submit", { ...rules, batchId, ideaId: "idea-1", kind: "draft", prompt: SCENE, fromId: made.value.image.id });
    const imageId = (await callTool(studio, "render_status", { batchId, renderId: sent.value.id })).value.image.id;

    await run("pack_check", { imageId, at: [700, 900], bg: "E83C28", pack: 2 });
    expect(studio.pixels.events.at(-1)!.input).toMatchObject({ packKey: PACK, box: defaultBox, cutout: defaultCutout, pack: 2 });
  });

  it("refuses a default pack that no plan item uses", async () => {
    await start(undefined, fakeNet({ [PACK_TWO_URL]: { body: PNG, headers: { "content-type": "image/png" } } }));
    await appendPackTwo();
    const made = await skeleton("idea-1", {
      pack: "pack-1",
      plan: {
        bg: "E83C28",
        products: [{ cx: 0.5, base: 0.9, height: 0.5, photo: "pack-2" }],
      },
    });
    expect(made.value.image.pack).toBe("pack-1");

    const sent = await callTool(studio, "render_submit", { ...rules, batchId, ideaId: "idea-1", kind: "draft", prompt: SCENE, fromId: made.value.image.id });
    const imageId = (await callTool(studio, "render_status", { batchId, renderId: sent.value.id })).value.image.id;
    expect(await run("pack_check", { imageId, at: [512, 900], bg: "E83C28", photo: "pack-3" })).toEqual(
      refused(/This picture did not use pack photo pack-3/),
    );
    expect(await run("pack_check", { imageId, at: [512, 900], bg: "E83C28", photo: "pack-1" })).toEqual(
      refused(/This picture did not use pack photo pack-1/),
    );
  });

  it("uses item settings for an inherited default on a legacy mixed plan", async () => {
    await start(undefined, fakeNet({ [PACK_TWO_URL]: { body: PNG, headers: { "content-type": "image/png" } } }));
    const packTwo = await appendPackTwo();
    const made = await skeleton("idea-1", {
      pack: "pack-2",
      plan: {
        bg: "E83C28",
        products: [
          { cx: 0.35, base: 0.9, height: 0.45 },
          { cx: 0.65, base: 0.9, height: 0.45, photo: "pack-1" },
        ],
      },
    });
    const savedImage = await studio.table.get<{ pk: string; sk: string; pack?: string }>(`BATCH#${batchId}`, `IMAGE#${made.value.image.id}`);
    const { pack: _pack, ...legacyImage } = savedImage!;
    await studio.table.put(legacyImage);

    const sent = await callTool(studio, "render_submit", { ...rules, batchId, ideaId: "idea-1", kind: "draft", prompt: SCENE, fromId: made.value.image.id });
    const imageId = (await callTool(studio, "render_status", { batchId, renderId: sent.value.id })).value.image.id;
    await run("pack_check", { imageId, at: [512, 900], bg: "E83C28", photo: "pack-2" });
    expect(studio.pixels.events.at(-1)!.input).toMatchObject({ packKey: packTwo.key });
  });

  it("keeps a render-only pack reference's result separate from the skeleton pack", async () => {
    let pass = false;
    await start(
      (event) => event.tool === "pack_check"
        ? { ok: true, passed: pass, line: pass ? "PASS at 2%" : "difference -10.2%; FAIL at 2%" }
        : { ok: true },
      fakeNet({ [PACK_TWO_URL]: { body: PNG, headers: { "content-type": "image/png" } } }),
    );
    const packTwo = await appendPackTwo();
    const made = await skeleton("idea-1", {
      pack: "pack-1",
      box: [40, 50, 640, 750],
      cutout: { darkMax: 25, edges: "right" },
      plan: {
        bg: "E83C28",
        products: [{ cx: 0.5, base: 0.9, height: 0.45 }],
      },
    });
    const sent = await callTool(studio, "render_submit", {
      ...rules,
      batchId,
      ideaId: "idea-1",
      kind: "draft",
      prompt: SCENE,
      fromId: made.value.image.id,
      references: ["pack-2"],
    });
    const imageId = (await callTool(studio, "render_status", { batchId, renderId: sent.value.id })).value.image.id;

    await run("pack_check", { imageId, at: [512, 900], bg: "E83C28", pack: 1 });
    pass = true;
    await run("pack_check", { imageId, at: [512, 900], bg: "E83C28", photo: "pack-2", pack: 2 });
    const input = studio.pixels.events.at(-1)!.input;
    expect(input).toMatchObject({ packKey: packTwo.key, pack: 2 });
    expect(input).not.toHaveProperty("cutout");
    expect(input).not.toHaveProperty("box");
    expect((await studio.services.checks.get(batchId, imageId))!.items).toEqual([
      { code: "D11", note: "difference -10.2%; FAIL at 2%", tool: "pack_check" },
    ]);
  });

  it("checks any pack photo named by a skeleton-free render", async () => {
    await start(undefined, fakeNet({ [PACK_TWO_URL]: { body: PNG, headers: { "content-type": "image/png" } } }));
    const packTwo = await appendPackTwo();
    const sent = await callTool(studio, "render_submit", {
      ...rules,
      batchId,
      ideaId: "idea-1",
      kind: "draft",
      prompt: SCENE,
      references: ["pack-1", "pack-2"],
    });
    expect(await studio.services.renders.get(batchId, sent.value.id)).toMatchObject({ pack: "pack-1", packPhotos: ["pack-1", "pack-2"] });
    const imageId = (await callTool(studio, "render_status", { batchId, renderId: sent.value.id })).value.image.id;
    await run("pack_check", { imageId, at: [512, 900], bg: "E83C28", photo: "pack-2" });
    expect(studio.pixels.events.at(-1)!.input).toMatchObject({ packKey: packTwo.key });
    expect(await run("pack_check", { imageId, at: [512, 900], bg: "E83C28", photo: "pack-3" })).toEqual(
      refused(/This picture did not use pack photo pack-3/),
    );
  });

  it("lets no agent name a file: a key in its input is refused", async () => {
    expect(await callTool(studio, "skeleton_make", { ...rules, batchId, ideaId: "idea-1", bg: "E83C28", packKey: "brands/other/pack.png" })).toEqual(refused(/packKey|Unrecognized|unknown/i));
    expect(
      await callTool(studio, "skeleton_make", { ...rules, batchId, ideaId: "idea-1", plan: { bg: "E83C28", products: [{ cx: 0.5, base: 0.8, height: 0.3, photo: "/etc/passwd" }] } }),
    ).toEqual(refused(/photo|Unrecognized/i));
  });

  it("needs a pack photo, an idea of the batch, a colour, and the house rules", async () => {
    expect(await skeleton("idea-9")).toEqual(refused(/no idea idea-9/));
    expect(await skeleton("idea-1", {})).toEqual(refused(/canvas colour/));
    expect(await callTool(studio, "skeleton_make", { batchId, ideaId: "idea-1", bg: "E83C28" })).toEqual(refused(/rules_get/));
    const { product } = await studio.services.board.board(batchId);
    const saved = await studio.services.brands.product(product.id);
    await studio.services.brands.saveProduct({ ...saved, photos: saved.photos.filter((photo) => photo.kind !== "pack") });
    expect(await skeleton()).toEqual(refused(/no pack photo/));
  });

  it("sends a plan with its colours as the scripts read them", async () => {
    await skeleton("idea-1", { plan: { bg: "EEE8DF", shapes: [{ rect: [0, 0.7, 1, 1], fill: "F6F5F2" }], products: [{ cx: 0.3, base: 0.8, height: 0.3 }] } });
    expect(studio.pixels.events[0]!.input.plan).toMatchObject({ bg: "#EEE8DF", shapes: [{ fill: "#F6F5F2" }], products: [{ side: "up", rot: 0 }] });
  });
});

describe("pack_check and cap_check", () => {
  it("saves a failed measure on the picture as D11, where the agent's own look cannot clear it", async () => {
    await start((event) => (event.tool === "pack_check" ? { ok: true, passed: false, line: "render H/W 1.412; packshot H/W 1.500; difference -5.9%; FAIL at 2%" } : { ok: true }));
    const imageId = await draft();
    const measured = await run("pack_check", { imageId, at: [512, 900], bg: "E83C28" });
    expect(measured.value).toMatchObject({ status: "done", passed: false, line: expect.stringContaining("-5.9%") });
    expect(studio.pixels.events.at(-1)).toMatchObject({ input: { packKey: PACK, renderKey: expect.stringContaining(`batches/${batchId}/drafts/${imageId}.`), at: [512, 900] } });
    expect(studio.pixels.events.at(-1)!.outKey).toBeUndefined();

    const looked = await callTool(studio, "checks_save", { ...rules, batchId, imageId, items: [] });
    expect(looked.value.checks.items).toEqual([{ code: "D11", note: expect.stringContaining("FAIL at 2%"), tool: "pack_check" }]);
  });

  it("cuts the pack out for a check and a repair the same way as for the skeleton", async () => {
    const tuned = { box: [10, 20, 600, 900], cutout: { darkMax: 60, edges: "top,left" } };
    const imageId = await draft("idea-1", { bg: "E83C28", ...tuned });
    await run("pack_check", { imageId, at: [512, 900], bg: "E83C28", box: [300, 600, 724, 1100] });
    expect(studio.pixels.events.at(-1)!.input).toMatchObject({ ...tuned, around: [300, 600, 724, 1100] });
    await run("product_swap", { imageId, old: [400, 620, 500, 1100] });
    expect(studio.pixels.events.at(-1)!.input).toMatchObject(tuned);
  });

  it("takes a box for a pack that stands on something", async () => {
    const imageId = await draft();
    await run("pack_check", { imageId, at: [512, 900], bg: "E83C28", box: [300, 600, 724, 1100] });
    expect(studio.pixels.events.at(-1)!.input).toMatchObject({ around: [300, 600, 724, 1100] });
    await run("pack_check", { imageId, at: [512, 900], bg: "E83C28" });
    expect(studio.pixels.events.at(-1)!.input).not.toHaveProperty("around");
  });

  it("clears its own D11 with a later pass, and keeps the cap's", async () => {
    let pass = false;
    await start((event) => (event.tool === "pack_check" ? { ok: true, passed: pass } : event.tool === "cap_check" ? { ok: true, passed: false, line: "cap centre 5.5 px right" } : { ok: true }));
    const imageId = await draft();
    await run("pack_check", { imageId, at: [512, 900], bg: "E83C28" });
    await run("cap_check", { imageId, box: [300, 380, 724, 1000], split: 500 });
    pass = true;
    await run("pack_check", { imageId, at: [512, 900], bg: "E83C28" });
    expect((await studio.services.checks.get(batchId, imageId))!.items).toEqual([{ code: "D11", note: "cap centre 5.5 px right", tool: "cap_check" }]);
  });

  it("keeps the D11 of one pack when another pack of the same picture passes", async () => {
    // Found live (22-11-2026): three pouches in one picture, the middle one 10% too wide, and a pass on its neighbour cleared it.
    let pass = false;
    await start((event) => (event.tool === "pack_check" ? { ok: true, passed: pass, line: pass ? "PASS at 2%" : "difference -10.2%; FAIL at 2%" } : { ok: true }));
    const imageId = await draft("idea-1", {
      plan: {
        bg: "E83C28",
        products: [
          { cx: 0.2, base: 0.9, height: 0.5 },
          { cx: 0.5, base: 0.9, height: 0.5 },
          { cx: 0.8, base: 0.9, height: 0.5 },
        ],
      },
    });
    await run("pack_check", { imageId, at: [512, 900], bg: "E83C28", pack: 2 });
    pass = true;
    await run("pack_check", { imageId, at: [200, 900], bg: "E83C28" });
    await run("pack_check", { imageId, at: [820, 900], bg: "E83C28", pack: 3 });
    const { checks } = studio.services;
    expect((await checks.get(batchId, imageId))!.items).toEqual([{ code: "D11", note: "Pack 2: difference -10.2%; FAIL at 2%", tool: "pack_check" }]);
    expect(await checks.measuredBy(batchId, imageId)).toEqual(["pack_check"]);
    // Only a pass on the same pack clears it.
    await run("pack_check", { imageId, at: [512, 900], bg: "E83C28", pack: 2 });
    expect((await checks.get(batchId, imageId))!.items).toEqual([]);
  });

  it("keeps a tool's D11 when the agent's look is saved at the same moment", async () => {
    const imageId = await draft();
    const { checks } = studio.services;
    await Promise.all([checks.save(batchId, imageId, []), checks.measure(batchId, imageId, "pack_check", { code: "D11", note: "5% too wide" })]);
    expect(await checks.get(batchId, imageId)).toMatchObject({ looked: true, items: [{ code: "D11", tool: "pack_check" }] });
    // An older job that is read late does not replace a newer job's pass.
    await checks.measure(batchId, imageId, "pack_check", null, "2026-11-22T10:00:00.000Z");
    await checks.measure(batchId, imageId, "pack_check", { code: "D11", note: "an older run" }, "2026-11-22T09:00:00.000Z");
    expect((await checks.get(batchId, imageId))!.items).toEqual([]);
  });

  it("saves what a job measured on the next read, when the first read stopped half way", async () => {
    await start(() => ({ ok: true, passed: false, line: "5% too wide" }));
    const imageId = await draft();
    const sent = await callTool(studio, "pack_check", { batchId, imageId, at: [512, 900], bg: "E83C28" });
    const measure = vi.spyOn(studio.services.checks, "measure").mockRejectedValueOnce(new Error("the table did not answer"));
    await callTool(studio, "pixel_status", { batchId, jobId: sent.value.id }).catch(() => undefined);
    expect(await studio.services.checks.get(batchId, imageId)).toBeUndefined();
    measure.mockRestore();
    expect((await status(sent.value.id)).status).toBe("done");
    expect((await studio.services.checks.get(batchId, imageId))!.items).toEqual([{ code: "D11", note: "5% too wide", tool: "pack_check" }]);
  });

  it("ends a job whose end mark was set by a read that then stopped", async () => {
    const imageId = await draft();
    const sent = await callTool(studio, "pack_check", { batchId, imageId, at: [512, 900], bg: "E83C28" });
    await studio.table.put({ pk: `BATCH#${batchId}`, sk: `ENDED#${sent.value.id}` });
    expect((await status(sent.value.id)).status).toBe("done");
  });

  it("applies a result one time, however often the job is read", async () => {
    const imageId = await draft();
    const sent = await callTool(studio, "pack_check", { batchId, imageId, at: [512, 900], bg: "E83C28" });
    const [first, second] = await Promise.all([status(sent.value.id), status(sent.value.id)]);
    expect(first.status).toBe("done");
    expect(second.status).toBe("done");
    expect(await studio.services.checks.measuredBy(batchId, imageId)).toEqual(["pack_check"]);
  });

  it("works on a rendered picture only, and only of this batch", async () => {
    const made = await skeleton();
    expect(await run("pack_check", { imageId: made.value.image.id, at: [1, 1], bg: "E83C28" })).toEqual(refused(/is a skeleton/));
    expect(await run("pack_check", { imageId: "not-mine", at: [1, 1], bg: "E83C28" })).toEqual(refused(/no picture not-mine/));
  });
});

describe("a job that fails", () => {
  it("says why, saves nothing, and can be sent again", async () => {
    await start((event) => (event.tool === "pack_check" ? { ok: false, error: "no pack found" } : { ok: true }));
    const imageId = await draft();
    const failed = await run("pack_check", { imageId, at: [5, 5], bg: "E83C28" });
    expect(failed.value).toMatchObject({ status: "failed", error: "no pack found" });
    expect(await studio.services.checks.measuredBy(batchId, imageId)).toEqual([]);
  });

  it("waits while the tool works, and fails after ten minutes with no answer", async () => {
    await start((event) => (event.tool === "cap_check" ? "silent" : { ok: true }));
    const imageId = await draft();
    const sent = await callTool(studio, "cap_check", { batchId, imageId, box: [300, 380, 724, 1000], split: 500 });
    expect(await status(sent.value.id)).toMatchObject({ status: "queued", next: expect.stringContaining("few seconds") });
    studio.clock.now = new Date(studio.clock.now.getTime() + 11 * 60_000);
    expect(await status(sent.value.id)).toMatchObject({ status: "failed", error: expect.stringContaining("did not answer") });
  });

  it("does not take a picture the job did not ask for", async () => {
    await start();
    const sent = await callTool(studio, "skeleton_make", { ...rules, batchId, ideaId: "idea-1", bg: "E83C28" });
    const { resultKey } = studio.pixels.events[0]!;
    await studio.pictures.put(resultKey, new TextEncoder().encode(JSON.stringify({ ok: true, imageKey: "brands/other/logo.png" })), "application/json");
    expect(await status(sent.value.id)).toMatchObject({ status: "failed" });
    expect(await studio.services.images.list(batchId, "skeleton")).toEqual([]);
  });
});

describe("repairs, the finish and the food crop", () => {
  it("reprints only a picture whose skeleton was made from a plan, with that plan", async () => {
    const plain = await draft("idea-1");
    expect(await run("product_reprint", { imageId: plain, face: [60, 90, 140, 340] })).toEqual(refused(/made without a plan/));
    const planned = await draft("idea-2", { plan: { bg: "EEE8DF", products: [{ cx: 0.4, base: 0.8, height: 0.3 }] } });
    const made = await run("product_reprint", { imageId: planned, face: [60, 90, 140, 340] });
    expect(made.value.image).toMatchObject({ kind: "reprint", fromId: planned, rootId: planned, ideaId: "idea-2" });
    expect(studio.pixels.events.at(-1)!.input).toMatchObject({ packKey: PACK, face: [60, 90, 140, 340], plan: { bg: "#EEE8DF", products: [{ cx: 0.4 }] } });
  });

  it("lets a swap stand for the draft: the board shows it, and it is checked as a new picture", async () => {
    const imageId = await draft();
    await studio.services.checks.measure(batchId, imageId, "pack_check", { code: "D11", note: "5% too wide" });
    const repair = (await run("product_swap", { imageId, old: [400, 620, 500, 1100] })).value.image;
    expect(repair).toMatchObject({ kind: "swap", fromId: imageId, rootId: imageId });
    const board = await studio.services.board.board(batchId);
    const shown = board.ideas[0]!.drafts[0]!;
    expect(shown.image.id).toBe(imageId);
    expect(shown.shown.id).toBe(repair.id);
    // The repair has no check yet: the old picture's D11 is not carried over, and nor is a pass.
    expect(shown.checks).toBeNull();
    // Nor does a final come from it before it is checked.
    const { services } = studio;
    await services.picks.save(batchId, { ideaId: "idea-1", imageId, ownerSaid: "this one", by: "owner@example.com" });
    const allow = async () => services.board.allow(await services.batches.get(batchId), "idea-1", await services.images.get(batchId, imageId));
    await expect(allow()).rejects.toThrow(/R35: the repair of this draft is not checked yet/);
    const looked = await callTool(studio, "checks_save", { ...rules, batchId, imageId: repair.id, items: [] });
    expect(looked.value.checks).toMatchObject({ imageId: repair.id, items: [], looked: true });
    expect(await studio.services.checks.measuredBy(batchId, repair.id)).toEqual([]);
  });

  it("finishes a final only, with the same seed for the same final", async () => {
    const imageId = await draft();
    expect(await run("photo_finish", { imageId })).toEqual(refused(/goes on a final/));
    const final = await studio.services.images.add({ batchId, kind: "final", key: `batches/${batchId}/finals/f.png`, ideaId: "idea-1", fromId: imageId });
    const first = await run("photo_finish", { imageId: final.id, sharp: [[0.4, 0.5, 0.6, 0.86]], keep: ["E83C28"] });
    expect(first.value.image).toMatchObject({ kind: "finish", fromId: final.id, rootId: final.id });
    await run("photo_finish", { imageId: final.id });
    const [one, two] = studio.pixels.events.filter((event) => event.tool === "photo_finish");
    expect(one!.input).toMatchObject({ strength: 1, sharp: [[0.4, 0.5, 0.6, 0.86]], keep: ["E83C28"], renderKey: final.key });
    expect(one!.input.seed).toBe(two!.input.seed);
    expect(Number.isInteger(one!.input.seed)).toBe(true);
  });

  it("crops the food beside one of the brand's own food photos", async () => {
    const imageId = await draft();
    const made = await run("food_crop", { imageId, box: [400, 600, 656, 856] });
    expect(made.value.image).toMatchObject({ kind: "food_crop", rootId: imageId });
    expect(studio.pixels.events.at(-1)!.input).toMatchObject({ foodKey: "products/p/food.jpg", box: [400, 600, 656, 856] });
    expect(await run("food_crop", { imageId, box: [400, 600, 656, 856], photo: 2 })).toEqual(refused(/1 food photo\(s\)/));
  });

  it("places the brand's real logo on a v1 draft and repeats that placement on its finished final", async () => {
    const imageId = await draft();
    const brand = await studio.services.brands.brand((await studio.services.batches.get(batchId)).brandId);
    expect(await run("logo_set", { imageId, ...rules })).toEqual(refused(/no saved logo/));
    await studio.services.brands.saveBrand({ ...brand, logo: { key: "brands/b/logo.png", sourceUrl: "https://cdn.wongi.example/logo.png" } });
    const stamped = await run("logo_set", { imageId, ...rules, logoWidth: 0.22, logoTop: 0.05, logoColour: "FFFFFF" });
    expect(stamped.value.image).toMatchObject({ kind: "typeset", fromId: imageId, rootId: imageId });
    expect(studio.pixels.events.at(-1)!.input).toMatchObject({ logoKey: "brands/b/logo.png", logoWidth: 0.22, logoTop: 0.05, logoColour: "FFFFFF" });

    const final = await studio.services.images.add({ batchId, kind: "final", ideaId: "idea-1", fromId: imageId, key: `batches/${batchId}/finals/f1.jpg` });
    expect(await run("logo_set", { imageId: final.id, ...rules })).toEqual(refused(/Run photo_finish/));
    const finished = await run("photo_finish", { imageId: final.id });
    const finalLogo = await run("logo_set", { imageId: final.id, ...rules, logoWidth: 0.4, logoTop: 0.1 });
    expect(finalLogo.value.image).toMatchObject({ kind: "typeset", fromId: finished.value.image.id, rootId: final.id });
    expect(studio.pixels.events.at(-1)!.input).toMatchObject({ logoKey: "brands/b/logo.png", logoWidth: 0.22, logoTop: 0.05, logoColour: "FFFFFF", renderKey: finished.value.image.key });
  });
});

describe("the board before the drafts", () => {
  it("is not shown to an agent while the drafts are not all sent", async () => {
    await draft();
    expect(await callTool(studio, "board_show", { batchId })).toEqual(refused(/board is not ready: the batch is at "priced"/));
  });
});

describe("a studio with no pixel function", () => {
  it("says so", async () => {
    await start();
    // @ts-expect-error the test removes the runner that the studio was built with
    studio.services.pixels.deps.runner = undefined;
    expect(await skeleton()).toEqual(refused(/not deployed/));
  });
});
