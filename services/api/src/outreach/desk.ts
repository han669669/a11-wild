import { OUTREACH_STAGES, type Batch, type OutreachAd, type OutreachStage, type OutreachTier, type ProspectBrief, type ProspectContacts, type ProspectFile, type ProspectRoute } from "@a11-wild/shared";
import type { BatchStore } from "../batch/store.js";
import type { IdeaFinal } from "../board/service.js";
import { Refusal } from "../mcp/registry.js";
import { noteText } from "./candidates.js";
import type { SpendLedger } from "../spend/ledger.js";
import { labelShowsClosed } from "./routes.js";
import { chosen, sameContact } from "./sequence.js";
import { adWaits, candidatesWait, kindOf, optedOut, owedNow, stageOf, standingAd, TAKES_NO_AD, wantsAd } from "./stage.js";
import { contactKeys, type OutreachStore } from "./store.js";

/** The owner's campaign: the first 50 product brands of his two top tiers, in list order. */
export const CAMPAIGN = { brands: 50, tiers: ["20+", "5-19"] as readonly OutreachTier[] } as const;

export interface NextBrand extends ProspectBrief {
  /** `first`: no ad yet. `again`: the owner said no to its ad. `more`: the brand replied and asked for one more. */
  why: "first" | "again" | "more";
  /** The owner's words with his no. The next ad is made from them. */
  ownerSaid?: string;
  /** What the brand sells, when someone has marked it. */
  sells?: "product";
  /** An outreach batch of this brand that is not done: resume it before you start a new one. */
  openBatchId?: string;
}

/** A brand whose owner has chosen: the agent's work on it comes before any new brand. */
export interface OwedBrand extends ProspectBrief {
  batchId: string;
  /** `final`: make the final of the draft he picked, then batch_done and outreach_attach. `words`: set other words on that draft, then outreach_show. */
  owes: "final" | "words";
  ideaId: string;
  imageId: string;
  /** His words with "other words": what the words should say. */
  ownerSaid?: string;
}

interface Deps {
  store: OutreachStore;
  batches: BatchStore;
  board: { finals(batch: Batch): Promise<IdeaFinal[]> };
  ledger: SpendLedger;
}

/** A number as its digits with the country code, so that "+65 6123 4567" and "61234567" are one number. */
const digitsOf = (value: string): string => {
  const digits = value.replace(/\D/g, "");
  return digits.length === 8 ? `65${digits}` : digits;
};

/** A prospect as the work list names it. Its contacts come from `contacts`. */
function briefOf(file: ProspectFile): ProspectBrief {
  const { id, n, brand, sector, liveAds, tier, newestAd, instagram } = file.profile;
  return { id, n, brand, sector, liveAds, tier, ...(newestAd ? { newestAd } : {}), ...(instagram ? { instagram } : {}) };
}

export const inCampaign = (file: ProspectFile, openBatchId?: string): boolean =>
  !file.profile.test && (CAMPAIGN.tiers.includes(file.profile.tier) || file.ads.length > 0 || file.events.some((event) => event.type === "candidates") || openBatchId !== undefined);

function openBatchIdByProspect(files: ProspectFile[], all: Batch[]): Map<string, string> {
  const refused = new Set(files.flatMap((file) => file.events.flatMap((event) => (event.type === "none" ? [event.batchId] : []))));
  const open = new Map<string, string>();
  for (const batch of all) {
    if (batch.purpose !== "outreach" || !batch.prospectId) continue;
    // A batch whose drafts the owner refused whole is not resumed: the next try is a new batch.
    if (batch.state !== "done" && !open.has(batch.prospectId) && !refused.has(batch.id)) open.set(batch.prospectId, batch.id);
  }
  return open;
}

/** The agent's side of the outreach: which brand needs an ad, where a finished ad goes, and the contacts of the list. */
export class OutreachDesk {
  constructor(private readonly deps: Deps) {}

  async openBatchIds(): Promise<ReadonlyMap<string, string>> {
    const [files, batches] = await Promise.all([this.deps.store.all(), this.deps.batches.list()]);
    return openBatchIdByProspect(files, batches);
  }

  private async read() {
    const { store, batches } = this.deps;
    const [files, optOuts, all] = await Promise.all([store.all(), store.optOuts(), batches.list()]);
    const newest = new Map<string, Batch>();
    for (const batch of all) {
      if (batch.purpose !== "outreach" || !batch.prospectId) continue;
      if (!newest.has(batch.prospectId)) newest.set(batch.prospectId, batch);
    }
    const open = openBatchIdByProspect(files, all);
    const started = files.filter((file) => inCampaign(file, open.get(file.profile.id)) && (file.ads.length > 0 || file.events.some((event) => event.type === "candidates"))).length;
    return { files, optOuts, open, started, shared: sameContact(files) };
  }

  /** What the owner is owed first (the final of his pick, or other words), then the brands that need an ad now: a "more" reply first, then the list's order. */
  async next(limit: number): Promise<{ owed: OwedBrand[]; brands: NextBrand[]; brandsWithAnAd: number; brandsLimit: number }> {
    const { files, optOuts, open, started, shared } = await this.read();
    const owed: OwedBrand[] = [];
    for (const file of files) {
      const choice = owedNow(file, optOuts);
      if (!choice) continue;
      owed.push({ ...briefOf(file), batchId: choice.batchId, owes: choice.type === "pick" ? "final" : "words", ideaId: choice.ideaId, imageId: choice.imageId, ...(choice.type === "words" ? { ownerSaid: choice.ownerSaid } : {}) });
    }
    const more: { at: string; brand: NextBrand }[] = [];
    const others: NextBrand[] = [];
    let firsts = Math.max(0, CAMPAIGN.brands - started);
    for (const file of files) {
      if (file.profile.test) continue;
      const want = wantsAd(file, optOuts);
      if (!want) continue;
      const openBatchId = open.get(file.profile.id);
      const brand: NextBrand = { ...briefOf(file), why: want.why, ...(want.ownerSaid ? { ownerSaid: want.ownerSaid } : {}), ...(kindOf(file) === "product" ? { sells: "product" as const } : {}), ...(openBatchId ? { openBatchId } : {}) };
      if (want.why === "more") {
        const asked = file.events.filter((event) => event.type === "reply" && event.reply === "more").at(-1);
        more.push({ at: asked?.at ?? "", brand });
        continue;
      }
      if (!inCampaign(file, openBatchId)) continue;
      // One person gets the first message once: a brand that shares its contact with an earlier one waits for the owner's choice.
      if (shared.has(file.profile.id) && !chosen(file)) continue;
      if (want.why === "first") {
        if (firsts === 0) continue;
        firsts -= 1;
      }
      others.push(brand);
    }
    more.sort((a, b) => a.at.localeCompare(b.at));
    return { owed, brands: [...more.map((entry) => entry.brand), ...others].slice(0, limit), brandsWithAnAd: started, brandsLimit: CAMPAIGN.brands };
  }

  private async file(id: string) {
    const read = await this.read();
    const file = read.files.find((entry) => entry.profile.id === id);
    if (!file) {
      await this.deps.store.assertWritable(id);
      throw new Refusal(`There is no prospect ${id}. outreach_next gives the brands that need an ad.`);
    }
    return { ...read, file };
  }

  /** Refuses an outreach batch for a brand that needs no ad now. */
  async checkNew(prospectId: string): Promise<void> {
    const { file, optOuts, started } = await this.file(prospectId);
    if (file.profile.test) throw new Refusal("That is a test prospect. No ad is made for it.");
    const want = wantsAd(file, optOuts);
    if (!want) throw new Refusal(adWaits(file) ? "An ad of this brand waits for the owner's yes or no. Make no other until he has answered." : candidatesWait(file) ? "The drafts of this brand wait for the owner's pick. Make no other until he has chosen." : owedNow(file, optOuts) ? "The owner has chosen for this brand. outreach_next names what he is owed: do that first." : `This brand is at "${stageOf(file, optOuts)}": it needs no ad now. outreach_next gives the brands that do.`);
    if (want.why === "more") return;
    if (!inCampaign(file)) throw new Refusal(`The campaign is for the tiers ${CAMPAIGN.tiers.join(" and ")} live ads. This brand is in "${file.profile.tier}".`);
    if (want.why === "first" && started >= CAMPAIGN.brands) throw new Refusal(`The campaign's ${CAMPAIGN.brands} brands have their ad. A new brand needs the owner's say.`);
  }

  /** What the brand sells, or that no good ad can be made for it. Only for a brand the owner has not written to. */
  async mark(id: string, input: { mark: "product" | "service" | "parked"; reason?: string | undefined }): Promise<{ stage: OutreachStage }> {
    const { store } = this.deps;
    const { file, optOuts } = await this.file(id);
    if (optedOut(file, optOuts)) throw new Refusal("This contact opted out. Nothing is changed for it.");
    if (file.sends.length > 0) throw new Refusal("The owner has written to this brand. Tell him what you found: only he changes it now.");
    if (input.mark === "parked") {
      if (!input.reason) throw new Refusal("Give the reason: what was missing for a good ad (too few facts, no usable real photo).");
      const stage = stageOf(file, optOuts);
      if (stage !== "new") throw new Refusal(`Only a brand with no ad can be parked. This one is at "${stage}".`);
      await store.addEvent(id, { type: "stage", stage: "parked", reason: input.reason }, "agent");
    } else {
      await store.addEvent(id, { type: "kind", kind: input.mark }, "agent");
    }
    const after = (await store.all()).find((entry) => entry.profile.id === id) as ProspectFile;
    return { stage: stageOf(after, optOuts) };
  }

  /**
   * Puts the final of the draft the owner picked on the prospect's page. His pick is his yes, so the message is ready; a no of his takes it back.
   * A batch can give more than one ad: he may pick another draft later, and each pick is attached once.
   * When the words of the final of his standing pick are set again, the newer picture is attached in the older one's place.
   */
  async attach(batchId: string, why: string): Promise<{ ad: Omit<OutreachAd, "key">; already: boolean }> {
    const { store, batches, board } = this.deps;
    const batch = await batches.get(batchId);
    if (batch.purpose !== "outreach" || !batch.prospectId) {
      throw new Refusal("This is not an outreach batch. Only the ad of a batch that was started for a prospect is attached.");
    }
    if (batch.state !== "done") {
      throw new Refusal(`This batch is "${batch.state}". Only the final of a done batch is attached: run batch_done first.`);
    }
    const { file, optOuts } = await this.file(batch.prospectId);
    const shown = ({ key: _key, ...ad }: OutreachAd) => ad;
    const picked = (await board.finals(batch)).filter((entry) => entry.pick?.imageId);
    const final = picked[0];
    if (picked.length !== 1 || !final) {
      throw new Refusal("An outreach batch has one picked final. This one does not.");
    }
    if (!final.delivered) {
      throw new Refusal(`The final is not ready for the owner: ${final.missing.join("; ")}.`);
    }
    const imageId = final.delivered.id;
    const same = (ad: OutreachAd) => ad.batchId === batch.id && ad.imageId === imageId;
    const owed = owedNow(file, optOuts);
    const owes = owed?.type === "pick" && owed.batchId === batch.id && owed.imageId === final.pick?.imageId;
    // Attached already, and he has not picked its draft again since: he may come back to a draft after a look at another.
    const before = file.ads.filter(same).at(-1);
    if (before && !owes) return { ad: shown(before), already: true };
    if (optedOut(file, optOuts)) throw new Refusal("This brand opted out. It takes no ad.");
    const stage = stageOf(file, optOuts);
    if (TAKES_NO_AD.includes(stage)) throw new Refusal(`This brand is at "${stage}" now. It takes no ad: make nothing more for it.`);
    // The same pick with its words set again: the newer picture takes the older one's place on his page. His pick stands, so it asks no second pick.
    const setAgain = !owes && final.pick?.imageId ? standingAd(file, batch.id, final.pick.imageId) : undefined;
    if (!owes && !setAgain) {
      throw new Refusal("The owner has not picked this draft on the prospect's page. Only the final of his own pick is attached: outreach_show puts the drafts before him, and outreach_next names the pick he made.");
    }
    const warning = noteText(final.warns ?? []);
    const saved = await store.putAd(file.profile.id, file.ads.length + 1, {
      batchId: batch.id,
      imageId,
      kind: batch.kind,
      picked: true,
      key: final.delivered.key,
      why,
      ...(warning ? { warning } : {}),
    });
    if (saved) return { ad: shown(saved), already: false };
    const again = (await store.all()).find((entry) => entry.profile.id === file.profile.id)?.ads.filter(same).at(-1);
    if (again) return { ad: shown(again), already: true };
    throw new Refusal("Another ad was attached to this brand at the same moment. Call outreach_attach again.");
  }

  /**
   * The contacts of the list, in its order, for an agent in the owner's session (owner, 24-11-2026).
   * An opted-out prospect comes back with no contact, its Instagram name included: its opt-out is final.
   * A number of an opted-out prospect is given for no other prospect, as a phone number or as a WhatsApp number.
   * A test prospect's opt-out stays on the test prospect: it closes no number of a real one. A real one's opt-out closes its number for a test prospect too.
   */
  async contacts(input: { prospectId?: string | undefined; after: number; limit: number }): Promise<{ prospects: ProspectContacts[]; more: boolean }> {
    const { files: all, optOuts, file: one } = input.prospectId ? await this.file(input.prospectId) : { ...(await this.read()), file: undefined };
    // The register keeps WhatsApp numbers and addresses. A phone number is free text, so it is compared by its digits.
    const closed = new Set(optOuts);
    for (const file of all) {
      if (file.profile.test || !optedOut(file, optOuts)) continue;
      contactKeys(file.profile).forEach((key) => closed.add(key));
    }
    const listed = one ? [one] : all.filter((file) => !file.profile.test && file.profile.n > input.after).sort((a, b) => a.profile.n - b.profile.n);
    const prospects = listed.slice(0, input.limit).map((file): ProspectContacts => {
      const stage = stageOf(file, optOuts);
      const { instagram: _instagram, ...named } = briefOf(file);
      if (stage === "opted_out") return { ...named, stage };
      const { profile } = file;
      const openNumber = (number: string | undefined): boolean => Boolean(number && !closed.has(`W#${digitsOf(number)}`));
      const openEmail = (address: string | undefined): boolean => Boolean(address && !closed.has(`E#${address.toLowerCase()}`));
      const openRouteLabel = (value: string | undefined): boolean => {
        const emails = value?.match(/[^\s<>()[\]"',;:|@]+@[^\s<>()[\]"',;:|\x2f@]+\.[a-z]{2,}/gi) ?? [];
        return emails.every(openEmail) && !labelShowsClosed(value, closed);
      };
      const routeOpen = (route: ProspectRoute | undefined): boolean => {
        if (!route) return false;
        const key =
          route.channel === "email"
            ? `E#${route.to.toLowerCase()}`
            : route.channel === "whatsapp" || route.channel === "call"
              ? `W#${digitsOf(route.to)}`
              : `${route.channel === "instagram" ? "I" : "F"}#${route.to.toLowerCase()}`;
        return !closed.has(key) && openRouteLabel(route.label);
      };
      const whatsapp = profile.whatsapp.filter(openNumber);
      const known = Object.fromEntries(
        Object.entries({
          bestRoute: openRouteLabel(profile.bestRoute) ? profile.bestRoute : undefined,
          secondRoute: openRouteLabel(profile.secondRoute) ? profile.secondRoute : undefined,
          sells: profile.sells,
          dmVerify: openEmail(profile.dmEmail) ? profile.dmVerify : undefined,
          dmEmail: openEmail(profile.dmEmail) ? profile.dmEmail : undefined,
          dmPhone: profile.dmPhone && openNumber(profile.dmPhone) ? profile.dmPhone : undefined,
          flags: profile.flags,
          route: routeOpen(profile.route) ? profile.route : undefined,
          second: routeOpen(profile.second) ? profile.second : undefined,
          email: openEmail(profile.email) ? profile.email : undefined,
          phone: profile.phone && openNumber(profile.phone) ? profile.phone : undefined,
          decisionMaker: profile.decisionMaker,
          dmTitle: profile.dmTitle,
          linkedin: profile.linkedin,
        }).filter(([, value]) => value !== undefined),
      );
      return { ...briefOf(file), stage, ...known, ...(whatsapp.length > 0 ? { whatsapp } : {}) };
    });
    return { prospects, more: listed.length > input.limit };
  }

  /** The campaign in numbers. It names no brand and holds no contact. */
  async state() {
    const { files, optOuts, started, open } = await this.read();
    const count = (of: ProspectFile[]) => {
      const stages = Object.fromEntries(OUTREACH_STAGES.map((stage) => [stage, 0])) as Record<OutreachStage, number>;
      for (const file of of) stages[stageOf(file, optOuts)] += 1;
      return stages;
    };
    const real = files.filter((file) => !file.profile.test);
    const campaign = real.filter((file) => inCampaign(file, open.get(file.profile.id)));
    const wants = { first: 0, again: 0, more: 0 };
    for (const file of real) {
      const want = wantsAd(file, optOuts);
      if (want && (want.why === "more" || inCampaign(file, open.get(file.profile.id)))) wants[want.why] += 1;
    }
    const spend = (await this.deps.ledger.summary()).campaign;
    return {
      prospects: real.length,
      stages: count(real),
      campaign: { tiers: CAMPAIGN.tiers, prospects: campaign.length, stages: count(campaign), brandsWithAnAd: started, brandsLimit: CAMPAIGN.brands },
      ads: {
        waitForTheOwner: real.filter((file) => adWaits(file) && !optedOut(file, optOuts)).length,
        draftsWaitForHisPick: real.filter((file) => candidatesWait(file) && !optedOut(file, optOuts)).length,
        owedByTheAgent: real.filter((file) => owedNow(file, optOuts)).length,
        wanted: wants,
      },
      firstMessagesSent: real.filter((file) => file.sends.some((send) => send.step === 0)).length,
      spend,
    };
  }
}
