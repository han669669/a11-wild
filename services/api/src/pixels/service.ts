import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Batch, BatchImage, ImageKind, Lockup, PixelJob, PixelTool } from "@a11-wild/shared";
import type { BatchStore } from "../batch/store.js";
import { hasWords } from "../batch/state.js";
import { type BoardService, countedOf, finishOf, pickedStamp, REPAIR_KINDS } from "../board/service.js";
import { fontOf } from "../brand/fonts.js";
import type { CopyStore } from "../copy/store.js";
import { photoNamed, roughPackReferences } from "../render/service.js";
import type { BrandStore } from "../brand/store.js";
import { PACK_CHECK, type CheckStore } from "../checks/store.js";
import type { ImageStore } from "../images/store.js";
import { Refusal } from "../mcp/registry.js";
import type { Pictures } from "../pictures/store.js";
import type { PickStore } from "../picks/store.js";
import type { RenderStore } from "../render/store.js";
import type { PixelRunner } from "./runner.js";
import { planShowsPack } from "./plan.js";
import { lockupLayout } from "../direction/lockup.js";
import type { DirectionStore } from "../direction/store.js";
import { type JobStore, jobView, type StoredJob } from "./store.js";

/** A job with no result after this long did not run to its end. */
const JOB_MINUTES = 10;
const RESULT_BYTES = 20_000;
const RENDERED: ImageKind[] = ["draft", "final", ...REPAIR_KINDS];
const SKELETON_STATES = ["ideas", "judged", "worded", "directed", "priced", "waiting_spend", "drafting"];
const cutoutEdges = (cutout?: Record<string, unknown>) =>
  typeof cutout?.edges === "string" ? cutout.edges : "top,bottom,left,right";
const effectiveCutout = (cutout?: Record<string, unknown>) => ({
  darkMax: cutout?.darkMax ?? 48,
  lightSat: cutout?.lightSat ?? 0.17,
  lightMin: cutout?.lightMin ?? 150,
  open: cutout?.open ?? 3,
  smooth: cutout?.smooth ?? 0,
  erode: cutout?.erode ?? 1,
  outline: cutout?.outline ?? 12,
  edges: [...new Set(cutoutEdges(cutout).split(",").map((edge) => edge.trim()))].sort().join(","),
});

interface Deps {
  batches: BatchStore;
  brands: BrandStore;
  images: ImageStore;
  checks: CheckStore;
  picks: PickStore;
  board: BoardService;
  renders: RenderStore;
  jobs: JobStore;
  pictures: Pictures;
  copy: CopyStore;
  directions: DirectionStore;
  /** Missing where the pixel function is not deployed. */
  runner: PixelRunner | undefined;
  now: () => Date;
}

/** What the pixel function wrote for a job. */
interface PixelResult {
  ok: boolean;
  line?: string;
  passed?: boolean;
  imageKey?: string;
  error?: string;
}

interface PackReference {
  packKey: string;
  cutout?: Record<string, unknown>;
  box?: number[];
  number: number;
}

interface SkeletonContext {
  skeleton?: BatchImage;
  input: Record<string, unknown>;
  lineagePacks: string[];
  product: { photos: { kind: string; key: string }[] };
}

export type PixelView = PixelJob & { image?: BatchImage & { viewUrl: string }; next?: string; state?: string; stillMissing?: string[] };

interface NoPackCheckView {
  batchId: string;
  imageId: string;
  tool: "pack_check";
  status: "done";
  line: "no pack shown";
  passed: true;
  state: Batch["state"];
  stillMissing?: string[];
}

/** The pixel scripts read a plan's colours with their "#". */
const hashed = (colour: unknown) => `#${String(colour).replace("#", "")}`;

function planColours(plan: unknown): unknown {
  if (typeof plan !== "object" || plan === null) return plan;
  const { bg, shapes, ...rest } = plan as { bg?: unknown; shapes?: { fill?: unknown }[] };
  return { ...rest, bg: hashed(bg), shapes: (shapes ?? []).map((shape) => ({ ...shape, fill: hashed(shape.fill) })) };
}

/** A whole number from a picture's id, so the same picture gets the same grain each time. */
const seedOf = (imageId: string) => createHash("sha256").update(imageId).digest().readUInt32BE(0);

/**
 * The pixel tools: the real pack in a skeleton, the pack and cap measures, the repairs, the real-camera finish and the food crop.
 * Each one runs as a job in the pixel function. What a check measured goes into the picture's checks, where no agent can clear it.
 */
export class PixelService {
  constructor(private readonly deps: Deps) {}

  private async packKey(batchId: string, name?: string): Promise<string> {
    const { batches, brands } = this.deps;
    const product = await brands.product((await batches.get(batchId)).productId);
    const pack = name ? photoNamed(product, name) : product.photos.find((photo) => photo.kind === "pack");
    if (!pack) throw new Refusal("This product has no pack photo. Save one with product_photos_save first: the tool needs the real pack.");
    if (pack.kind !== "pack") throw new Refusal(`Photo ${name} is not a pack photo.`);
    return pack.key;
  }

  /** A draft, a final or a repair of one: a picture a check or a repair can work on. */
  private async rendered(batchId: string, imageId: string): Promise<BatchImage> {
    const image = await this.deps.images.get(batchId, imageId);
    if (!RENDERED.includes(image.kind)) throw new Refusal(`Picture ${imageId} is a ${image.kind}. This tool works on a draft, a final, or a repair of one.`);
    return image;
  }

  private async start(
    tool: PixelTool,
    batchId: string,
    input: Record<string, unknown>,
    about: { imageId?: string; out?: Omit<NonNullable<StoredJob["out"]>, "key"> },
  ): Promise<PixelView> {
    const { jobs, runner } = this.deps;
    if (!runner) throw new Refusal("The pixel tools are not deployed in this studio.");
    const id = randomUUID();
    const job = await jobs.add({
      id,
      batchId,
      tool,
      input,
      resultKey: `jobs/${batchId}/${id}.json`,
      ...(about.imageId ? { imageId: about.imageId } : {}),
      ...(about.out ? { out: { ...about.out, key: `batches/${batchId}/${about.out.kind}s/${id}.jpg` } } : {}),
    });
    await runner.start({ jobId: id, batchId, tool, input, resultKey: job.resultKey, ...(job.out ? { outKey: job.out.key } : {}) });
    return { ...jobView(job), next: "pixel_status reads the result. It takes a few seconds." };
  }

  /** The draft or final a picture stands for. */
  private root = (image: BatchImage) => image.rootId ?? image.id;

  async skeleton(input: { batchId: string; ideaId: string; placement: Record<string, unknown>; pack?: string }): Promise<PixelView> {
    const { batches } = this.deps;
    const batch = await batches.get(input.batchId);
    if (!SKELETON_STATES.includes(batch.state)) throw new Refusal(`A skeleton is made before a draft. This batch is at "${batch.state}".`);
    if (!(await batches.ideas(batch.id)).some((idea) => idea.id === input.ideaId)) throw new Refusal(`This batch has no idea ${input.ideaId}.`);
    if (!input.placement.plan && !input.placement.bg) throw new Refusal("A skeleton needs the canvas colour (bg), or a plan that has one.");
    const placement = input.placement.plan ? { ...input.placement, plan: await this.planPhotos(batch.productId, planColours(input.placement.plan)) } : input.placement;
    const product = await this.deps.brands.product(batch.productId);
    const firstPack = product.photos.find((photo) => photo.kind === "pack");
    const planProducts = (input.placement.plan as { products?: { photo?: string }[] } | undefined)?.products ?? [];
    const firstPlanPhoto = planProducts[0]?.photo;
    const planPack =
      firstPlanPhoto &&
      /^pack-\d{1,2}$/.test(firstPlanPhoto) &&
      planProducts.every((entry) => entry.photo === firstPlanPhoto) &&
      photoNamed(product, firstPlanPhoto)?.kind === "pack"
        ? firstPlanPhoto
        : undefined;
    const packName = input.pack ?? planPack ?? (firstPack ? "pack-1" : undefined);
    const pack = packName ? photoNamed(product, packName) : undefined;
    if (input.pack && pack?.kind !== "pack") throw new Refusal(`This product has no pack photo named ${input.pack}.`);
    // A product with no pack (a cake, a dish) is still built from real photos: each item of the plan names one.
    const named = (input.placement.plan as { products?: { photo?: string }[] } | undefined)?.products?.every((entry) => entry.photo);
    if (!pack && !named) {
      throw new Refusal('Real photos first: this product has no pack photo, so the skeleton is a plan in which each item names a saved real photo of the product ("food-1", "prop-1"). Save the photos with product_save.');
    }
    const workerPlanProducts = (placement.plan as { products?: { photoKey?: string }[] } | undefined)?.products;
    const allPlanItemsHavePhotos = Boolean(workerPlanProducts?.length && workerPlanProducts.every((entry) => entry.photoKey));
    const workerPlacement = { ...placement };
    delete workerPlacement.packKey;
    if (pack && !allPlanItemsHavePhotos) workerPlacement.packKey = pack.key;
    return this.start(
      "skeleton",
      batch.id,
      workerPlacement,
      { out: { kind: "skeleton", ideaId: input.ideaId, ...(pack && packName ? { pack: packName } : {}) } },
    );
  }

  /** A plan product that names another real photo of the product ("food-2", "prop-1") gets that photo's key. An agent never types a key. */
  private async planPhotos(productId: string, plan: unknown): Promise<unknown> {
    const { products, ...rest } = plan as { products: ({ photo?: string } & Record<string, unknown>)[] };
    if (!products.some((entry) => entry.photo)) return plan;
    const product = await this.deps.brands.product(productId);
    return {
      ...rest,
      products: products.map(({ photo, ...entry }) => {
        if (!photo) return entry;
        const found = photoNamed(product, photo);
        if (!found) throw new Refusal(`Real photos first: this product has no photo ${photo}. Find a real one (image_search or the brand's own pages) and save it with product_save.`);
        return { ...entry, photoKey: found.key };
      }),
    };
  }

  async packCheck(input: { batchId: string; imageId: string; noPack?: boolean; at?: [number, number]; bg?: string; sideways?: boolean; tilted?: boolean; box?: number[]; pack?: number; photo?: string; item?: number }): Promise<PixelView | NoPackCheckView> {
    const image = await this.rendered(input.batchId, input.imageId);
    if (input.noPack) {
      const { batches, images, checks, board, now } = this.deps;
      const batch = await batches.get(input.batchId);
      const evidence = await board.packEvidence(batch, image, await images.list(input.batchId));
      if (evidence.direct) throw new Refusal("This picture was built with a pack photo, so measure its pack.");
      if (batch.kind !== "v3" || image.kind !== "draft" || !evidence.rough) {
        throw new Refusal("noPack is only for a v3 draft whose pack came only from its rough.");
      }
      await checks.measure(input.batchId, image.id, PACK_CHECK, null, now().toISOString(), input.pack ?? 1);
      const { batch: progressed, missing } = await board.progress(batch);
      return {
        batchId: input.batchId,
        imageId: image.id,
        tool: "pack_check",
        status: "done",
        line: "no pack shown",
        passed: true,
        state: progressed.state,
        ...(missing.length > 0 ? { stillMissing: missing } : {}),
      };
    }
    if (!input.at) throw new Refusal("Give at to measure the pack, or set noPack: true.");
    if (!input.bg) throw new Refusal("Give bg to measure the pack, or set noPack: true.");
    const at = input.at;
    const bg = input.bg;
    const sideways = input.sideways ?? false;
    const { batchId: _batchId, imageId: _imageId, noPack: _noPack, box: around, photo, item, pack, tilted } = input;
    // `box` in a job is the pack's box in the pack photo, so the box round the drawn pack goes as `around`.
    const { number, ...reference } = await this.packRef(input.batchId, image, {
      requirePackLabel: true,
      ...(photo !== undefined ? { photo } : {}),
      ...(item !== undefined ? { item } : {}),
      ...(pack !== undefined ? { pack } : {}),
    });
    return this.start("pack_check", input.batchId, { at, bg, sideways, ...(tilted !== undefined ? { tilted } : {}), pack: number, ...(around ? { around } : {}), ...reference, renderKey: image.key }, { imageId: image.id });
  }

  async capCheck(input: { batchId: string; imageId: string; box: number[]; split: number; pack?: number }): Promise<PixelView> {
    const image = await this.rendered(input.batchId, input.imageId);
    return this.start("cap_check", input.batchId, { box: input.box, split: input.split, ...(input.pack ? { pack: input.pack } : {}), renderKey: image.key }, { imageId: image.id });
  }

  /** What the skeleton of a picture was made with, through its draft when the picture is a final or a repair. */
  private async skeletonContext(batchId: string, image: BatchImage): Promise<SkeletonContext> {
    const { batches, brands, images, jobs, renders } = this.deps;
    const batch = await batches.get(batchId);
    const product = await brands.product(batch.productId);
    const allImages = await images.list(batchId);
    const imageById = new Map(allImages.map((entry) => [entry.id, entry] as const));
    imageById.set(image.id, image);
    const allRenders = await renders.list(batchId);
    const renderById = new Map(allRenders.map((entry) => [entry.id, entry] as const));
    const pending = [image.id];
    const seen = new Set<string>();
    const lineagePacks: string[] = [];
    let skeleton: BatchImage | undefined;
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const current = imageById.get(id);
      const render = renderById.get(id);
      if (current?.kind === "skeleton" && !skeleton) skeleton = current;
      for (const name of [...(render?.packPhotos ?? []), ...(render?.pack ? [render.pack] : [])]) {
        if (!lineagePacks.includes(name)) lineagePacks.push(name);
      }
      if (render) {
        for (const name of roughPackReferences(render, allRenders, allImages, batch.kind, product)) {
          if (!lineagePacks.includes(name)) lineagePacks.push(name);
        }
      }
      const parents = [current?.fromId, current?.rootId, render?.fromId].filter((parent): parent is string => typeof parent === "string");
      for (const parent of parents.reverse()) pending.push(parent);
    }
    const input = skeleton
      ? { ...(await jobs.get(batchId, skeleton.id)).input, ...(skeleton.pack ? { pack: skeleton.pack } : {}) }
      : {};
    return { ...(skeleton ? { skeleton } : {}), input, lineagePacks, product };
  }

  private async packRef(
    batchId: string,
    image: BatchImage,
    options: { photo?: string; pack?: number; item?: number; requirePackLabel?: boolean } = {},
    context?: SkeletonContext,
  ): Promise<PackReference> {
    const skeletonContext = context ?? await this.skeletonContext(batchId, image);
    const { product } = skeletonContext;
    const productPacks = product.photos.filter((entry) => entry.kind === "pack");
    const productPackKeys = new Set(productPacks.map((entry) => entry.key));
    const { skeleton, input, lineagePacks } = skeletonContext;
    const packNameForKey = (key: string) => {
      const index = productPacks.findIndex((entry) => entry.key === key);
      return index >= 0 ? `pack-${index + 1}` : undefined;
    };
    let defaultName = typeof input.pack === "string" ? input.pack : undefined;
    if (!defaultName && typeof input.packKey === "string") defaultName = packNameForKey(input.packKey);
    const namedDefault = defaultName ? photoNamed(product, defaultName) : undefined;
    const defaultPhoto = namedDefault?.kind === "pack" ? namedDefault : undefined;
    const firstProductPack = productPacks[0];
    const lineagePackNames = lineagePacks.filter((name) => photoNamed(product, name)?.kind === "pack");
    const lineagePackKeys = new Set(lineagePackNames.flatMap((name) => {
      const photo = photoNamed(product, name);
      return photo?.kind === "pack" ? [photo.key] : [];
    }));
    const plan = input.plan as { products?: { cx: number; photoKey?: string; cutout?: Record<string, unknown>; box?: number[] }[] } | undefined;
    const planItems = (plan?.products ?? [])
      .map((item, index) => ({ item, index }));
    const isPackItem = ({ item }: typeof planItems[number]) => !item.photoKey || productPacks.some((entry) => entry.key === item.photoKey);
    const packItems = planItems
      .filter(isPackItem)
      .sort((left, right) => left.item.cx - right.item.cx || left.index - right.index);
    const planPackKeys = new Set(packItems.flatMap(({ item }) => {
      const selected = item.photoKey ? productPacks.find((entry) => entry.key === item.photoKey) : defaultPhoto ?? firstProductPack;
      return selected ? [selected.key] : [];
    }));
    const mayShowMultiplePacks = packItems.length > 1
      || new Set([...planPackKeys, ...lineagePackKeys]).size > 1;
    if (options.requirePackLabel && options.pack === undefined && mayShowMultiplePacks) {
      throw new Refusal("This picture's layout and references use more than one pack photo: give pack, the pack's number from the left in this picture (1 if it shows only one pack).");
    }
    const number = options.pack ?? 1;
    const itemRef = (entry: typeof packItems[number]): PackReference => {
      const { item } = entry;
      const selected = item.photoKey ? productPacks.find((entry) => entry.key === item.photoKey) : defaultPhoto ?? firstProductPack;
      if (!selected) throw new Refusal("This product has no pack photo. Save one with product_photos_save first: the tool needs the real pack.");
      const cutout = item.photoKey ? item.cutout : input.cutout as Record<string, unknown> | undefined;
      const box = item.photoKey ? item.box : input.box as number[] | undefined;
      return {
        packKey: selected.key,
        ...(cutout ? { cutout } : {}),
        ...(box ? { box } : {}),
        number,
      };
    };
    const selectedPhoto = options.photo !== undefined ? photoNamed(product, options.photo) : undefined;
    if (options.item !== undefined) {
      const selectedItem = planItems[options.item - 1];
      if (!selectedItem || !isPackItem(selectedItem)) {
        throw new Refusal(`This picture's plan has no pack at item ${options.item}.`);
      }
      const reference = itemRef(selectedItem);
      if (options.photo !== undefined && (selectedPhoto?.kind !== "pack" || selectedPhoto.key !== reference.packKey)) {
        throw new Refusal(`This picture's pack at item ${options.item} does not use pack photo ${options.photo}.`);
      }
      return reference;
    }
    const candidates = options.photo !== undefined && selectedPhoto?.kind === "pack"
      ? packItems.filter(({ item }) => {
          const itemPhoto = item.photoKey ? productPacks.find((entry) => entry.key === item.photoKey) : defaultPhoto ?? firstProductPack;
          return itemPhoto?.key === selectedPhoto.key;
        })
      : options.photo === undefined ? packItems : [];
    if (candidates.length > 0) {
      const references = candidates.map((candidate) => itemRef(candidate));
      const firstReference = references[0]!;
      const sameReference = references.every((reference) =>
        reference.packKey === firstReference.packKey
        && isDeepStrictEqual(effectiveCutout(reference.cutout), effectiveCutout(firstReference.cutout))
        && isDeepStrictEqual(reference.box, firstReference.box),
      );
      if (!sameReference) {
        throw new Refusal("Packs of this plan use different photos or crops: give item, the pack's place in the skeleton plan (1 for the first).");
      }
      return firstReference;
    }

    if (options.photo !== undefined) {
      if (selectedPhoto?.kind === "pack" && lineagePackKeys.has(selectedPhoto.key)) return { packKey: selectedPhoto.key, number };
      throw new Refusal(`This picture did not use pack photo ${options.photo}.`);
    }

    const hasPackItem = planShowsPack(plan, productPackKeys);
    const firstLineagePack = lineagePackNames[0] ? photoNamed(product, lineagePackNames[0]) : undefined;
    if (!hasPackItem) {
      if (lineagePackNames.length === 0) throw new Refusal("This picture's plan has no pack 1.");
      if (firstLineagePack?.kind === "pack") return { packKey: firstLineagePack.key, number };
    }
    if (skeleton && defaultPhoto) {
      return {
        packKey: defaultPhoto.key,
        ...(input.cutout ? { cutout: input.cutout as Record<string, unknown> } : {}),
        ...(input.box ? { box: input.box as number[] } : {}),
        number,
      };
    }
    const fallback = firstLineagePack?.kind === "pack" ? firstLineagePack : firstProductPack;
    if (!fallback) throw new Refusal("This product has no pack photo. Save one with product_photos_save first: the tool needs the real pack.");
    return { packKey: fallback.key, number };
  }

  private async planOf(batchId: string, image: BatchImage, context?: SkeletonContext): Promise<unknown> {
    const { plan } = (context ?? await this.skeletonContext(batchId, image)).input;
    if (!plan) throw new Refusal("A reprint needs the plan of the skeleton the picture was built round. This picture's skeleton was made without a plan: repair it with product_swap, or render it again.");
    return plan;
  }

  async reprint(input: { batchId: string; imageId: string; face: number[] }): Promise<PixelView> {
    const image = await this.rendered(input.batchId, input.imageId);
    const context = await this.skeletonContext(input.batchId, image);
    const plan = await this.planOf(input.batchId, image, context);
    const products = (plan as { products?: { photoKey?: unknown }[] }).products ?? [];
    if (products.some(({ photoKey }) => photoKey !== undefined)) {
      throw new Refusal("A reprint works on a plan built round the default pack photo; repair this picture with product_swap.");
    }
    const { number, ...reference } = await this.packRef(
      input.batchId,
      image,
      { pack: 1 },
      context,
    );
    return this.start(
      "reprint",
      input.batchId,
      { face: input.face, plan, ...reference, pack: number, renderKey: image.key },
      { imageId: image.id, out: { kind: "reprint", fromId: image.id, rootId: this.root(image), ...(image.ideaId ? { ideaId: image.ideaId } : {}) } },
    );
  }

  async swap(input: { batchId: string; imageId: string; old: number[]; scale?: number; cx?: number; lowerOnly: boolean; bandTop?: number; photo?: string; pack?: number; item?: number }): Promise<PixelView> {
    const image = await this.rendered(input.batchId, input.imageId);
    const { batchId: _batchId, imageId: _imageId, photo, item, pack, ...rest } = input;
    const { number, ...reference } = await this.packRef(input.batchId, image, {
      pack: pack ?? 1,
      ...(photo !== undefined ? { photo } : {}),
      ...(item !== undefined ? { item } : {}),
    });
    return this.start(
      "swap",
      input.batchId,
      { ...rest, ...reference, pack: number, renderKey: image.key },
      { imageId: image.id, out: { kind: "swap", fromId: image.id, rootId: this.root(image), ...(image.ideaId ? { ideaId: image.ideaId } : {}) } },
    );
  }

  async finish(input: { batchId: string; imageId: string; strength: number; sharp: number[][]; keep: string[] }): Promise<PixelView> {
    const { images } = this.deps;
    const image = await this.rendered(input.batchId, input.imageId);
    const root = image.rootId ? await images.get(input.batchId, image.rootId) : image;
    if (root.kind !== "final") throw new Refusal("The real-camera finish goes on a final, or on a repair of a final. A draft stays as the model made it.");
    return this.start(
      "photo_finish",
      input.batchId,
      { strength: input.strength, sharp: input.sharp, keep: input.keep, seed: seedOf(root.id), renderKey: image.key },
      { imageId: image.id, out: { kind: "finish", fromId: image.id, rootId: root.id, ...(image.ideaId ? { ideaId: image.ideaId } : {}) } },
    );
  }

  async foodCrop(input: { batchId: string; imageId: string; box: number[]; photo: number }): Promise<PixelView> {
    const { batches, brands } = this.deps;
    const image = await this.rendered(input.batchId, input.imageId);
    const food = (await brands.product((await batches.get(input.batchId)).productId)).photos.filter((photo) => photo.kind === "food");
    const chosen = food[input.photo - 1];
    if (!chosen) throw new Refusal(food.length === 0 ? "This product has no food photo of the brand's own to compare with. Save one with product_photos_save." : `This product has ${food.length} food photo(s). Give a number from 1 to ${food.length}.`);
    return this.start(
      "food_crop",
      input.batchId,
      { box: input.box, renderKey: image.key, foodKey: chosen.key },
      { imageId: image.id, out: { kind: "food_crop", fromId: image.id, rootId: this.root(image), ...(image.ideaId ? { ideaId: image.ideaId } : {}) } },
    );
  }

  /** A repair that makes a new picture, which then stands for the draft or the final. */
  private repair(tool: PixelTool, kind: ImageKind, batchId: string, image: BatchImage, input: Record<string, unknown>): Promise<PixelView> {
    return this.start(tool, batchId, { ...input, renderKey: image.key }, { imageId: image.id, out: { kind, fromId: image.id, rootId: this.root(image), ...(image.ideaId ? { ideaId: image.ideaId } : {}) } });
  }

  async foodGrade(input: { batchId: string; imageId: string; photo: number; refBox: number[]; regions: number[][]; strength: number; refBg?: number[]; satMin?: number; dist?: number }): Promise<PixelView> {
    const { batches, brands } = this.deps;
    const image = await this.rendered(input.batchId, input.imageId);
    const food = (await brands.product((await batches.get(input.batchId)).productId)).photos.filter((photo) => photo.kind === "food");
    const chosen = food[input.photo - 1];
    if (!chosen) throw new Refusal(`This product has ${food.length} food photo(s) of the brand's own. The colour is matched to a real close-up: save one with product_save.`);
    const { batchId: _batchId, imageId: _imageId, photo: _photo, ...rest } = input;
    return this.repair("food_grade", "grade", input.batchId, image, { ...rest, foodKey: chosen.key });
  }

  async relight(input: { batchId: string; imageId: string; box: number[]; light: "left" | "right"; floor: number[] } & Record<string, unknown>): Promise<PixelView> {
    const image = await this.rendered(input.batchId, input.imageId);
    const { batchId: _batchId, imageId: _imageId, ...rest } = input;
    return this.repair("relight", "relight", input.batchId, image, rest);
  }

  async boxPrint(input: { batchId: string; imageId: string; face: number[]; blocks: Record<string, unknown>[] }): Promise<PixelView> {
    const image = await this.rendered(input.batchId, input.imageId);
    return this.repair("box_print", "box_print", input.batchId, image, { face: input.face, blocks: input.blocks, packKey: await this.packKey(input.batchId) });
  }

  /**
   * Sets the approved words and the real logo on a draft or a final, in the brand's own font. The words come from the owner's
   * approval and never from the caller, so a picture cannot carry words he did not approve.
   */
  async typeSet(input: { batchId: string; imageId: string; family?: string; weight: number; subFamily?: string; subWeight?: number; logo: boolean; layout: Record<string, unknown> }): Promise<PixelView> {
    const { batches, images, copy } = this.deps;
    const batch = await batches.get(input.batchId);
    if (!hasWords(batch.kind)) throw new Refusal("R16: a v1 picture carries the brand logo and no words. Only a batch with words (v2) has its words set.");
    const given = await this.rendered(input.batchId, input.imageId);
    const all = await images.list(input.batchId);
    const root = given.rootId ? await images.get(input.batchId, given.rootId) : given;
    const counted = countedOf(root, all);
    // A final takes its words after the real-camera finish, so the grain and the softness never touch the type.
    const on = root.kind === "final" ? finishOf(counted, all) : counted;
    if (!on) throw new Refusal(`The words go on a final after its real-camera finish. Run photo_finish on picture ${counted.id} first.`);
    const words = root.ideaId ? await copy.get(input.batchId, root.ideaId) : undefined;
    if (!words) throw new Refusal("The owner has not approved the words of this idea yet. Show him the headline and the subline as text, and save his yes with copy_approve.");
    // The words of a concept ad stand where its direction says: the place follows the picture, not a habit.
    const plan = batch.kind === "v3" ? (await this.deps.directions.get(input.batchId))?.concepts.find((concept) => concept.ideaId === root.ideaId) : undefined;
    if (batch.kind === "v3" && !plan) throw new Refusal(`Concept ${root.ideaId} has no direction, so the studio does not know where its words stand. Save it first (direction_save).`);
    // A final carries its words as the draft the owner picked carries them: the place, the size, the colour, the font and the logo are that draft's, not a second choice.
    const picked = root.kind === "final" && root.fromId ? await this.setAs(input.batchId, root.fromId, all) : undefined;
    const how = picked ?? (await this.asGiven(batch, input, plan && root.ideaId ? { lockup: plan.lockup, ideaId: root.ideaId } : undefined));
    const view = await this.start(
      "headline",
      input.batchId,
      {
        ...how,
        headline: words.headline,
        subline: words.subline,
        ...(words.footnote ? { footnote: words.footnote } : {}),
        renderKey: on.key,
      },
      // The picture keeps the version of the words it was sent with: the owner can change them while the job runs.
      { imageId: on.id, out: { kind: "typeset", fromId: on.id, rootId: root.id, wordsVersion: words.version, ...(root.ideaId ? { ideaId: root.ideaId } : {}) } },
    );
    return picked ? { ...view, next: `The words and the logo are set as on the draft the owner picked; the place, the colour and the logo you gave were not used. ${view.next}` } : view;
  }

  /** Places the brand's real logo on a v1 draft or final with no words. A final repeats the picked draft's exact logo placement after photo_finish. */
  async logoSet(input: { batchId: string; imageId: string; logoWidth?: number; logoTop?: number; logoX?: number; logoColour?: string }): Promise<PixelView> {
    const { batches, brands, images } = this.deps;
    const batch = await batches.get(input.batchId);
    if (hasWords(batch.kind)) throw new Refusal("logo_set is for v1 pictures (logo only, no words). Use type_set on a v2 or v3 batch.");
    const given = await this.rendered(input.batchId, input.imageId);
    const all = await images.list(input.batchId);
    const root = given.rootId ? await images.get(input.batchId, given.rootId) : given;
    const counted = countedOf(root, all);
    const on = root.kind === "final" ? finishOf(counted, all) : counted;
    if (!on) throw new Refusal(`The logo goes on a final after its real-camera finish. Run photo_finish on picture ${counted.id} first.`);
    const brand = await brands.brand(batch.brandId);
    if (!brand.logo) throw new Refusal("This brand has no saved logo. Use brand_logo_save to add one from its brand_extract candidates.");
    const picked = root.kind === "final" && root.fromId ? await this.setAs(input.batchId, root.fromId, all, true) : undefined;
    const how = picked ?? {
      logoKey: brand.logo.key,
      ...(input.logoWidth !== undefined ? { logoWidth: input.logoWidth } : {}),
      ...(input.logoTop !== undefined ? { logoTop: input.logoTop } : {}),
      ...(input.logoX !== undefined ? { logoX: input.logoX } : {}),
      ...(input.logoColour ? { logoColour: input.logoColour } : {}),
    };
    const view = await this.start(
      "logo_set",
      input.batchId,
      { ...how, logoKey: brand.logo.key, renderKey: on.key },
      { imageId: on.id, out: { kind: "typeset", fromId: on.id, rootId: root.id, ...(root.ideaId ? { ideaId: root.ideaId } : {}) } },
    );
    return picked ? { ...view, next: `The logo is set as on the draft the owner picked; the place, size and colour you gave were not used. ${view.next}` } : view;
  }

  /** How the caller asks for the words: its place, in the brand's own font, with the brand's saved logo. */
  private async asGiven(batch: Batch, input: Parameters<PixelService["typeSet"]>[0], concept: { lockup: Lockup; ideaId: string } | undefined): Promise<Record<string, unknown>> {
    if (!input.layout.area) throw new Refusal("Give area: the place of the words on this picture, as x0,y0,x1,y1.");
    const brand = await this.deps.brands.brand(batch.brandId);
    const family = input.family ?? brand.fonts[0];
    const font = fontOf(brand.fontFiles, family, input.weight);
    if (!font) {
      throw new Refusal(`The studio holds no font file ${family ? `of "${family}" ` : ""}for this brand. Save the brand's own font with font_save (the headline weight and the subline weight). The words are never set in another family without the owner's yes.`);
    }
    // A brand that sets its small words in a second face of its own: the subline takes that one.
    const sub = input.subFamily || input.subWeight ? fontOf(brand.fontFiles, input.subFamily ?? font.family, input.subWeight ?? input.weight) : undefined;
    if (input.subFamily && !sub) {
      throw new Refusal(`The studio holds no font file of "${input.subFamily}" for this brand. Save it with font_save, or leave subFamily out and the subline takes the headline font.`);
    }
    if (input.logo && !brand.logo) throw new Refusal("This brand has no saved logo. Use brand_logo_save to add one from its brand_extract candidates, or send logo false and tell the owner the ad has no logo yet.");
    return {
      ...(concept ? lockupLayout(concept.lockup, concept.ideaId, input.layout) : input.layout),
      fontKey: font.key,
      ...(sub && sub.key !== font.key ? { subFontKey: sub.key } : {}),
      // A variable font holds every weight in one file: the tool sets its weight axis. A file of one weight keeps its own.
      weight: input.weight,
      ...(input.subWeight ? { subWeight: input.subWeight } : {}),
      ...(input.logo && brand.logo ? { logoKey: brand.logo.key } : {}),
    };
  }

  /** How the words (or v1 logo) stand on a draft as the owner last saw it: prefers a set on the counted draft and falls back to the draft's root if a repair was not restamped. */
  private async setAs(batchId: string, draftId: string, all: BatchImage[], v1 = false): Promise<Record<string, unknown> | undefined> {
    const draft = all.find((image) => image.id === draftId);
    const counted = draft ? countedOf(draft, all) : undefined;
    const onCounted = counted ? all.filter((image) => image.kind === "typeset" && image.fromId === counted.id) : [];
    const pool = onCounted.length > 0 ? onCounted : all.filter((image) => image.kind === "typeset" && image.rootId === draftId);
    const pick = v1 ? (await this.deps.picks.all(batchId)).find((entry) => entry.imageId === draftId) : undefined;
    const newest = pick ? pickedStamp(pick, all) : pool.sort((one, other) => other.createdAt.localeCompare(one.createdAt))[0];
    // The picture of a set of words has the id of the job that made it.
    const job = newest ? await this.deps.jobs.find(batchId, newest.id) : undefined;
    if (!job) return undefined;
    const { headline: _headline, subline: _subline, footnote: _footnote, renderKey: _renderKey, ...how } = job.input;
    return how;
  }

  private async result(job: StoredJob): Promise<PixelResult | undefined> {
    const body = await this.deps.pictures.read(job.resultKey, RESULT_BYTES);
    if (!body) return undefined;
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
      if (typeof parsed === "object" && parsed !== null && typeof (parsed as PixelResult).ok === "boolean") return parsed as PixelResult;
    } catch {
      // An unreadable result is a failed job.
    }
    return { ok: false, error: "The tool's result could not be read." };
  }

  /** Reads a job. The first read after it ends saves what it made or measured, one time. */
  async status(batchId: string, jobId: string): Promise<PixelView> {
    const { jobs, images, checks, pictures, batches, board, now } = this.deps;
    let job = await jobs.get(batchId, jobId);
    if (job.status === "queued") {
      const result = await this.result(job);
      if (!result) {
        if (now().getTime() - Date.parse(job.createdAt) < JOB_MINUTES * 60_000) return { ...jobView(job), next: "Read again in a few seconds." };
        job = (await jobs.end(job, { status: "failed", error: "The tool did not answer. Send it again." })) ?? (await jobs.get(batchId, jobId));
      } else if (!result.ok || (job.out && result.imageKey !== job.out.key) || (!job.out && typeof result.passed !== "boolean")) {
        job = (await jobs.end(job, { status: "failed", error: String(result.error ?? "The tool gave no result.").slice(0, 600) })) ?? (await jobs.get(batchId, jobId));
      } else {
        const line = String(result.line ?? "").slice(0, 600);
        // What the job made or measured is saved before the job ends, so a read that stops half way is done again by the next one. Each write gives the same row again.
        if (job.out) {
          const { key, kind, ideaId, fromId, rootId, pack, wordsVersion } = job.out;
          await images.add({ id: job.id, batchId, kind, key, ...(ideaId ? { ideaId } : {}), ...(fromId ? { fromId } : {}), ...(rootId ? { rootId } : {}), ...(pack ? { pack } : {}), ...(wordsVersion ? { wordsVersion } : {}) });
        } else if (job.imageId) {
          // D11 is the product drawn wrong: the pack's shape, and where the cap sits. Each pack of a picture keeps its own result.
          const pack = typeof job.input.pack === "number" ? job.input.pack : 1;
          await checks.measure(batchId, job.imageId, job.tool, result.passed === true ? null : { code: "D11", note: pack > 1 ? `Pack ${pack}: ${line}` : line }, job.createdAt, pack);
        }
        const ended = await jobs.end(job, { status: "done", line, ...(job.out ? { madeId: job.id } : { passed: result.passed === true }) });
        job = ended ?? (await jobs.get(batchId, jobId));
      }
    }
    const view: PixelView = jobView(job);
    if (job.status === "done" && job.madeId) {
      const image = await images.get(batchId, job.madeId);
      view.image = { ...image, viewUrl: await pictures.viewUrl(image.key) };
    }
    if (job.status === "done" && job.tool !== "skeleton" && job.tool !== "food_crop") {
      const { batch, missing } = await board.progress(await batches.get(batchId));
      view.state = batch.state;
      if (missing.length > 0) view.stillMissing = missing;
    }
    return view;
  }
}
