import { randomUUID } from "node:crypto";
import type { BrandKit, Product, ProductPhoto } from "@a11-wild/shared";
import { Refusal } from "../mcp/registry.js";
import { type Item, record, type Table } from "../store/table.js";

const DAY_SECONDS = 24 * 60 * 60;
const BRANDS = "BRAND";
export const PHOTOS_MAX = 16;
const brandKey = (brandId: string) => `BRAND#${brandId}`;
type ProductItem = Item & Product & { photoVersion?: string };

function productRecord(item: ProductItem): Product {
  const { photoVersion: _photoVersion, ...product } = record<ProductItem>(item);
  return product;
}

/**
 * What an extract or a picture search offered. Kept for a day, so that a save can prove the
 * owner chose among things the studio itself found, and nothing else gets in.
 */
export interface Offer {
  id: string;
  kind: "brand" | "product" | "images";
  /** The page the offer was read from. */
  url: string;
  /** The address that was fetched, before a page-provided base changes link resolution. */
  pageUrl?: string;
  logos: string[];
  photos: string[];
  productPages: string[];
  colours: string[];
}

export class BrandStore {
  constructor(
    private readonly table: Table,
    private readonly now: () => Date,
  ) {}

  async offer(offer: Omit<Offer, "id">): Promise<Offer> {
    const saved: Offer = { ...offer, id: randomUUID() };
    await this.table.put({ pk: "OFFER", sk: saved.id, ...saved, expiresAt: Math.floor(this.now().getTime() / 1000) + DAY_SECONDS });
    return saved;
  }

  async offered(id: string): Promise<Offer> {
    const item = await this.table.get<Item & Offer & { expiresAt: number }>("OFFER", id);
    if (!item || item.expiresAt * 1000 < this.now().getTime()) {
      throw new Refusal(`There is no extract ${id}, or it is more than a day old. Run the extract again.`);
    }
    return record<Offer>(item);
  }

  async saveBrand(kit: Omit<BrandKit, "id" | "createdAt"> & { id?: string }): Promise<BrandKit> {
    // A brand that is saved again keeps the day it was first saved.
    const before = kit.id ? await this.table.get<Item & BrandKit>(BRANDS, kit.id) : undefined;
    const saved: BrandKit = { ...kit, id: kit.id ?? randomUUID(), createdAt: before?.createdAt ?? this.now().toISOString() };
    await this.table.put({ pk: BRANDS, sk: saved.id, ...saved });
    return saved;
  }

  async brand(brandId: string): Promise<BrandKit> {
    const item = await this.table.get<Item & BrandKit>(BRANDS, brandId);
    if (!item) throw new Refusal(`There is no brand ${brandId}. Call brand_list for the saved brands.`);
    return record<BrandKit>(item);
  }

  async brands(): Promise<BrandKit[]> {
    const items = await this.table.query<Item & BrandKit>(BRANDS);
    return items.map((item) => record<BrandKit>(item)).sort((a, b) => a.name.localeCompare(b.name));
  }

  async saveProduct(product: Omit<Product, "id" | "createdAt"> & { id?: string }): Promise<Product> {
    await this.brand(product.brandId);
    const before = product.id ? await this.table.get<Item & Product>(brandKey(product.brandId), `PRODUCT#${product.id}`) : undefined;
    const saved: Product = { ...product, id: product.id ?? randomUUID(), createdAt: before?.createdAt ?? this.now().toISOString() };
    await this.table.put({ pk: brandKey(saved.brandId), sk: `PRODUCT#${saved.id}`, ...saved, photoVersion: randomUUID() });
    // A second item finds the product by its id alone.
    await this.table.put({ pk: "PRODUCT", sk: saved.id, brandId: saved.brandId });
    return saved;
  }

  async product(productId: string): Promise<Product> {
    const pointer = await this.table.get<Item & { brandId: string }>("PRODUCT", productId);
    const item = pointer && (await this.table.get<ProductItem>(brandKey(pointer.brandId), `PRODUCT#${productId}`));
    if (!item) throw new Refusal(`There is no product ${productId}. Call brand_list for the saved products.`);
    return productRecord(item);
  }

  async appendProductPhotos(productId: string, photos: ProductPhoto[]): Promise<Product> {
    const pointer = await this.table.get<Item & { brandId: string }>("PRODUCT", productId);
    const item = pointer && (await this.table.get<ProductItem>(brandKey(pointer.brandId), `PRODUCT#${productId}`));
    if (!item) throw new Refusal(`There is no product ${productId}. Call brand_list for the saved products.`);

    const product = productRecord(item);
    const duplicates = photos.filter((photo) => product.photos.some((existing) => existing.sourceUrl === photo.sourceUrl));
    if (duplicates.length > 0) throw new Refusal(`The picture ${duplicates[0]!.sourceUrl} is already on this product.`);
    if (photos.length > 1 && new Set(photos.map((photo) => photo.sourceUrl)).size !== photos.length) {
      throw new Refusal("A picture is repeated in this call.");
    }
    if (product.photos.length + photos.length > PHOTOS_MAX) {
      throw new Refusal(`This product can hold at most ${PHOTOS_MAX} photos.`);
    }

    const next: ProductItem = { ...item, photos: [...product.photos, ...photos], photoVersion: randomUUID() };
    const saved = item.photoVersion
      ? await this.table.put(next, { ifEquals: { attribute: "photoVersion", value: item.photoVersion } })
      : await this.table.put(next, { ifNotExistsAttribute: "photoVersion" });
    if (!saved) throw new Refusal("The product's photos changed while they were being added. Run product_photos_add again.");
    return productRecord(next);
  }

  async products(brandId: string): Promise<Product[]> {
    const items = await this.table.query<ProductItem>(brandKey(brandId));
    return items
      .filter((item) => item.sk.startsWith("PRODUCT#"))
      .map(productRecord)
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}
