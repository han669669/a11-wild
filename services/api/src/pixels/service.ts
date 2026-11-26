import { createHash, randomUUID } from "node:crypto";
import type { Batch, BatchImage, ImageKind, Lockup, PixelJob, PixelTool } from "@a11-wild/shared";
import type { BatchStore } from "../batch/store.js";
import { hasWords } from "../batch/state.js";
import { type BoardService, countedOf, finishOf, pickedStamp, REPAIR_KINDS } from "../board/service.js";
import { fontOf } from "../brand/fonts.js";
import type { CopyStore } from "../copy/store.js";
import { photoNamed } from "../render/service.js";
import type { BrandStore } from "../brand/store.js";
import type { CheckStore } from "../checks/store.js";
import type { ImageStore } from "../images/store.js";
import { Refusal } from "../mcp/registry.js";
import { MAX_PICTURE_BYTES, type Pictures } from "../pictures/store.js";
import type { PickStore } from "../picks/store.js";
import type { RenderStore } from "../render/store.js";
import type { PixelRunner } from "./runner.js";
import { lockupLayout } from "../direction/lockup.js";
import type { DirectionStore } from "../direction/store.js";
import { type JobStore, jobView, type StoredJob } from "./store.js";

/** A job with no result after this long did not run to its end. */
const JOB_MINUTES = 10;
const RESULT_BYTES = 20_000;
const RENDERED: ImageKind[] = ["draft", "final", ...REPAIR_KINDS];
const SKELETON_STATES = ["ideas", "judged", "worded", "directed", "priced", "waiting_spend", "drafting"];

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
}

export type PixelView = PixelJob & { image?: BatchImage & { viewUrl: string }; next?: string; state?: string; stillMissing?: string[] };

/** The pixel scripts read a plan's colours with their "#". */
const hashed = (colour: unknown) => `#${String(colour).replace("#", "")}`;
const JPEG_FRAME_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegWidth(bytes: Uint8Array): number | undefined {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === undefined || marker === 0xda || marker === 0xd9) return undefined;
    if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) return undefined;
    const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (length < 2 || offset + length > bytes.length) return undefined;
    if (JPEG_FRAME_MARKERS.has(marker)) {
      if (length < 7) return undefined;
      const width = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
      return width > 0 ? width : undefined;
    }
    offset += length;
  }
  return undefined;
}

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

  async packCheck(input: { batchId: string; imageId: string; at: [number, number]; bg: string; sideways: boolean; tilted?: boolean; box?: number[]; pack?: number; photo?: string }): Promise<PixelView> {
    const image = await this.rendered(input.batchId, input.imageId);
    const { batchId: _batchId, imageId: _imageId, box: around, photo, pack, ...rest } = input;
    // `box` in a job is the pack's box in the pack photo, so the box round the drawn pack goes as `around`.
    const { number, ...reference } = await this.packRef(input.batchId, image, {
      ...(photo !== undefined ? { photo } : {}),
      pack: pack ?? 1,
      x: input.at[0],
    });
    return this.start("pack_check", input.batchId, { ...rest, pack: number, ...(around ? { around } : {}), ...reference, renderKey: image.key }, { imageId: image.id });
  }

  async capCheck(input: { batchId: string; imageId: string; box: number[]; split: number; pack?: number }): Promise<PixelView> {
    const image = await this.rendered(input.batchId, input.imageId);
    return this.start("cap_check", input.batchId, { box: input.box, split: input.split, ...(input.pack ? { pack: input.pack } : {}), renderKey: image.key }, { imageId: image.id });
  }

  /** What the skeleton of a picture was made with, through its draft when the picture is a final or a repair. */
  private async skeletonContext(batchId: string, image: BatchImage): Promise<SkeletonContext> {
    const { images, jobs, renders } = this.deps;
    const imageById = new Map((await images.list(batchId)).map((entry) => [entry.id, entry] as const));
    imageById.set(image.id, image);
    const renderById = new Map((await renders.list(batchId)).map((entry) => [entry.id, entry] as const));
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
      const parents = [current?.fromId, current?.rootId, render?.fromId].filter((parent): parent is string => typeof parent === "string");
      for (const parent of parents.reverse()) pending.push(parent);
    }
    const input = skeleton
      ? { ...(await jobs.get(batchId, skeleton.id)).input, ...(skeleton.pack ? { pack: skeleton.pack } : {}) }
      : {};
    return { ...(skeleton ? { skeleton } : {}), input, lineagePacks };
  }

  private async imageWidth(image: BatchImage, context: SkeletonContext): Promise<number> {
    const plan = context.input.plan as { size?: unknown } | undefined;
    for (const size of [context.input.size, plan?.size]) {
      if (Array.isArray(size) && typeof size[0] === "number" && Number.isFinite(size[0]) && size[0] > 0) return size[0];
    }
    const bytes = await this.deps.pictures.read(image.key, MAX_PICTURE_BYTES);
    return (bytes && jpegWidth(bytes)) || 1024;
  }

  private async packRef(
    batchId: string,
    image: BatchImage,
    options: { photo?: string; pack?: number; x?: number } = {},
    context?: SkeletonContext,
  ): Promise<PackReference> {
    const { batches, brands } = this.deps;
    const product = await brands.product((await batches.get(batchId)).productId);
    const productPacks = product.photos.filter((entry) => entry.kind === "pack");
    const skeletonContext = context ?? await this.skeletonContext(batchId, image);
    const { skeleton, input, lineagePacks } = skeletonContext;
    const number = options.pack ?? 1;
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
    const plan = input.plan as { size?: number[]; products?: { cx: number; photoKey?: string; cutout?: Record<string, unknown>; box?: number[] }[] } | undefined;
    const packItems = (plan?.products ?? [])
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => !item.photoKey || productPacks.some((entry) => entry.key === item.photoKey))
      .sort((left, right) => left.item.cx - right.item.cx || left.index - right.index);
    const itemRef = ({ item }: typeof packItems[number]): PackReference => {
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
    const candidates = options.photo !== undefined && selectedPhoto?.kind === "pack"
      ? packItems.filter(({ item }) => {
          const itemPhoto = item.photoKey ? productPacks.find((entry) => entry.key === item.photoKey) : defaultPhoto ?? firstProductPack;
          return itemPhoto?.key === selectedPhoto.key;
        })
      : options.photo === undefined ? packItems : [];
    let selectedItem = candidates[0];
    if (selectedItem && options.x !== undefined && candidates.length > 1) {
      const x = options.x / (await this.imageWidth(image, skeletonContext));
      selectedItem = candidates.slice(1).reduce((nearest, candidate) => {
        const distance = Math.abs(candidate.item.cx - x);
        const nearestDistance = Math.abs(nearest.item.cx - x);
        return distance < nearestDistance - 1e-12 || (Math.abs(distance - nearestDistance) <= 1e-12 && candidate.index < nearest.index) ? candidate : nearest;
      }, selectedItem);
    }
    if (selectedItem) return itemRef(selectedItem);

    if (options.photo !== undefined) {
      if (selectedPhoto?.kind === "pack" && lineagePackNames.includes(options.photo)) return { packKey: selectedPhoto.key, number };
      throw new Refusal(`This picture did not use pack photo ${options.photo}.`);
    }

    if (plan) throw new Refusal("This picture's plan has no pack 1.");
    if (skeleton && defaultPhoto) {
      return {
        packKey: defaultPhoto.key,
        ...(input.cutout ? { cutout: input.cutout as Record<string, unknown> } : {}),
        ...(input.box ? { box: input.box as number[] } : {}),
        number,
      };
    }
    const firstLineagePack = lineagePackNames[0] ? photoNamed(product, lineagePackNames[0]) : undefined;
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
    const { number, ...reference } = await this.packRef(input.batchId, image, {}, context);
    return this.start(
      "reprint",
      input.batchId,
      { face: input.face, plan, ...reference, pack: number, renderKey: image.key },
      { imageId: image.id, out: { kind: "reprint", fromId: image.id, rootId: this.root(image), ...(image.ideaId ? { ideaId: image.ideaId } : {}) } },
    );
  }

  async swap(input: { batchId: string; imageId: string; old: number[]; scale?: number; cx?: number; lowerOnly: boolean; bandTop?: number; photo?: string; pack?: number }): Promise<PixelView> {
    const image = await this.rendered(input.batchId, input.imageId);
    const { batchId: _batchId, imageId: _imageId, photo, pack, ...rest } = input;
    const { number, ...reference } = await this.packRef(input.batchId, image, {
      ...(photo !== undefined ? { photo } : {}),
      pack: pack ?? 1,
      x: (input.old[0]! + input.old[1]!) / 2,
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
