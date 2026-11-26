import type { CreativeTag, CreativeTagInput } from "@a11-wild/shared";
import { packKey } from "../pack/store.js";
import { type Item, record, type Table } from "../store/table.js";

const sk = (adName: string, version: number) => `CREATIVE#${adName}#${String(version).padStart(4, "0")}`;

/** What each ad is testing, versioned so a correction never rewrites the reading an old result used. */
export class CreativeTagStore {
  constructor(
    private readonly table: Table,
    private readonly now: () => Date,
  ) {}

  async all(packId: string): Promise<CreativeTag[]> {
    const items = await this.table.query<Item & CreativeTag>(packKey(packId));
    return items
      .filter((item) => item.sk.startsWith("CREATIVE#"))
      .sort((a, b) => a.sk.localeCompare(b.sk))
      .map((item) => record<CreativeTag>(item));
  }

  async current(packId: string): Promise<CreativeTag[]> {
    const merged = new Map<string, CreativeTag>();
    // A version corrects or adds to the reading before it; leaving a field out does not erase it.
    for (const tag of await this.all(packId)) merged.set(tag.adName, { ...(merged.get(tag.adName) ?? { adName: tag.adName, version: 0, at: tag.at, by: tag.by }), ...tag });
    return [...merged.values()].sort((a, b) => a.adName.localeCompare(b.adName));
  }

  async save(packId: string, input: CreativeTagInput & { adName: string; by: string }): Promise<CreativeTag> {
    const newest = (await this.all(packId)).filter((tag) => tag.adName === input.adName).at(-1);
    const saved: CreativeTag = { ...input, version: (newest?.version ?? 0) + 1, at: this.now().toISOString() };
    await this.table.put({ pk: packKey(packId), sk: sk(input.adName, saved.version), ...saved });
    return saved;
  }
}
