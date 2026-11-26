import { randomUUID } from "node:crypto";
import { OUTREACH_TIERS, type OutreachTier, type Prospect, type ProspectFlag, type ProspectRoute, type ProspectSells } from "@a11-wild/shared";
import { Refusal } from "../mcp/registry.js";
import { blockedValues, EMAIL_IN_TEXT, IG_HANDLE_IN_TEXT, IG_URL_IN_TEXT, instagramKey, isBlockedTarget, numberKey } from "./blocked.js";
import { EMAIL } from "./messages.js";
import { hasUnbalancedBrackets, hasUnsafePhoneRouteNote, routeOf, trailingBracketGroup } from "./routes.js";
import { sendTarget, stageOf } from "./stage.js";
import { type OutreachStore, prospectId } from "./store.js";

/** One row of the owner's list, as plain text and numbers. The spreadsheet is read outside the server. */
export interface LoadRow {
  n: number;
  brand: string;
  sector: string;
  liveAds: number | string;
  tier?: string | undefined;
  newestAd?: string | undefined;
  bestRoute?: string | undefined;
  secondRoute?: string | undefined;
  whatsapp?: string | undefined;
  email?: string | undefined;
  phone?: string | undefined;
  instagram?: string | undefined;
  decisionMaker?: string | undefined;
  dmTitle?: string | undefined;
  linkedin?: string | undefined;
  dmEmail?: string | undefined;
  dmVerify?: "valid" | "risky" | "invalid" | "unknown" | undefined;
  dmPhone?: string | undefined;
  notes?: string | undefined;
  pitch?: string | undefined;
  sells?: ProspectSells | "" | undefined;
  mergedInto?: number | undefined;
}

/** A refused row names its number and its field. It never repeats the value: a contact detail must not come back. */
export interface LoadRefusal {
  row: number;
  field: string;
  why: string;
}

class RowError extends Error {
  constructor(
    readonly field: string,
    readonly why: string,
  ) {
    super(why);
  }
}

const SG = "65";
const LOCAL = /^[3689]\d{7}$/;

// eslint-disable-next-line no-control-regex
const plain = (value: string | undefined): string | undefined => value?.replace(/[\u0000-\u001f\u007f]+/g, " ").trim() || undefined;

/** The digits of each number, with the country code. A Singapore number of eight digits gets 65. */
export function numbers(value: string | undefined): string[] {
  const text = plain(value);
  if (!text) return [];
  const found = text
    .split(/[;,/]/)
    // Two local numbers with a space between them are two numbers, not one.
    .flatMap((piece) => (/^\s*\d{8}\s+\d{8}\s*$/.test(piece) ? piece.trim().split(/\s+/) : [piece]))
    .map((piece) => piece.replace(/[\s().-]/g, "").replace(/^\+/, ""))
    .filter((piece) => piece !== "")
    .map((digits) => {
      if (!/^\d+$/.test(digits)) throw new RowError("whatsapp", "the WhatsApp number is not a number");
      const full = LOCAL.test(digits) ? SG + digits : digits;
      if (full.length < 10 || full.length > 15) throw new RowError("whatsapp", "the WhatsApp number does not have the length of a number with its country code");
      return full;
    });
  return [...new Set(found)];
}

export function address(value: string | undefined): string | undefined {
  const text = plain(value)?.toLowerCase();
  if (!text) return undefined;
  if (text.length > 254 || !EMAIL.test(text)) throw new RowError("email", "the address is not an email address");
  return text;
}

function count(value: number | string): number {
  const n = typeof value === "number" ? value : /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > 100000) throw new RowError("liveAds", "the number of live ads is not a whole number");
  return n;
}

const tierOf = (liveAds: number): OutreachTier => (liveAds >= 20 ? OUTREACH_TIERS[0] : liveAds >= 5 ? OUTREACH_TIERS[1] : OUTREACH_TIERS[2]);

function day(value: string | undefined): string | undefined {
  const text = plain(value);
  if (!text) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) throw new RowError("newestAd", "the day of the newest ad is not a date as YYYY-MM-DD");
  return text;
}

const optional = <K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> => (value === undefined ? {} : ({ [key]: value } as Record<K, string>));

const routeLabel = (field: "bestRoute" | "secondRoute", value: string | undefined): string | undefined => {
  const text = plain(value);
  if (text && text.length > 64) throw new RowError(field, "the route label is longer than 64 characters");
  if (text && /^(?:DM phone|Phone|WhatsApp)(?:\s|$)/i.test(text)) {
    if (hasUnbalancedBrackets(text) || (!routeOf(text) && /[()]/.test(text))) {
      throw new RowError(field, "the route can't be read as one number; write a note in words in brackets after it");
    }
    if (hasUnsafePhoneRouteNote(text)) {
      throw new RowError(field, "a route note can't hold a number or address; put it in Second route or Notes");
    }
  }
  return text;
};

const junkName = /source_url|<|>|%|^null$|^n\/?a$|^unknown$/i;
const person = (value: string | undefined): string | undefined => {
  const text = plain(value);
  return text && !junkName.test(text) ? text : undefined;
};
function withRoutePerson(route: ProspectRoute, decisionMaker: string | undefined, dmTitle: string | undefined): ProspectRoute;
function withRoutePerson(route: undefined, decisionMaker: string | undefined, dmTitle: string | undefined): undefined;
function withRoutePerson(route: ProspectRoute | undefined, decisionMaker: string | undefined, dmTitle: string | undefined): ProspectRoute | undefined {
  if (!route) return undefined;
  if (!route.direct) {
    const withoutPerson = { ...route };
    delete withoutPerson.person;
    delete withoutPerson.title;
    return withoutPerson;
  }
  const withPerson = { ...route };
  if (decisionMaker) withPerson.person = decisionMaker;
  else delete withPerson.person;
  if (dmTitle) withPerson.title = dmTitle;
  else delete withPerson.title;
  return withPerson;
}

function flagsFrom(notes: string | undefined): ProspectFlag[] {
  const flags: ProspectFlag[] = [];
  for (const segment of notes?.split(" | ") ?? []) {
    let text = segment.trim();
    if (!text) continue;
    if (/^MERGED(?:-INTO)?\b/i.test(text)) {
      const duplicate = text.match(/DUP-CHECK:\s*([\s\S]*)/i);
      if (!duplicate) continue;
      text = `DUP-CHECK: ${duplicate[1]!.trim()}`;
    }
    if (/^DUP-CHECK:/i.test(text)) flags.push({ kind: "duplicate", text });
    else if (/^QA-FLAG:/i.test(text)) flags.push({ kind: "fixed", text });
    else if (/^AUDIT-FLAG:/i.test(text) || /do[\s-]+not[\s-]+send|quarantin|pending[\s-]+source[\s-]+check/i.test(text)) flags.push({ kind: "blocked", text });
  }
  return flags;
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function removeBlocked(profile: Prospect): Prospect {
  const blocked = blockedValues(profile.flags ?? []);
  const isEmailBlocked = (value: string | undefined) => value !== undefined && blocked.emails.has(value.toLowerCase());
  const isNumberBlocked = (value: string | undefined) => value !== undefined && blocked.numbers.has(numberKey(value));
  const isInstagramBlocked = (value: string | undefined) => value !== undefined && blocked.instagram.has(instagramKey(value));
  const isRouteBlocked = (value: ProspectRoute | undefined) =>
    value !== undefined && isBlockedTarget(blocked, value);
  const stripSegment = (segment: string): string =>
    segment
      .replace(EMAIL_IN_TEXT, (email) => (blocked.emails.has(email.toLowerCase()) ? "" : email))
      .replace(/\+?\d[\d().\s-]{5,}\d/g, (number) => (blocked.numbers.has(numberKey(number)) ? "" : number))
      .replace(IG_URL_IN_TEXT, (url) => (blocked.instagram.has(instagramKey(url)) ? "" : url))
      .replace(IG_HANDLE_IN_TEXT, (match, handle: string) => (blocked.instagram.has(instagramKey(handle)) ? match.slice(0, match.indexOf("@")) : match))
      .replace(/\s{2,}/g, " ")
      .trim();
  const stripRoute = (value: string | undefined): string | undefined => {
    if (!value) return undefined;
    const bracket = trailingBracketGroup(value);
    if (bracket && /\p{L}/u.test(bracket.content)) {
      const prefix = stripSegment(bracket.prefix);
      const note = stripSegment(bracket.content);
      const clean = [prefix, note ? `(${note})` : ""].filter(Boolean).join(" ").trim();
      return clean || undefined;
    }
    return stripSegment(value) || undefined;
  };
  const saved: Prospect = {
    ...profile,
    whatsapp: profile.whatsapp.filter((number) => !isNumberBlocked(number)),
  };
  if (isEmailBlocked(saved.email)) delete saved.email;
  if (isEmailBlocked(saved.dmEmail)) delete saved.dmEmail;
  if (isNumberBlocked(saved.phone)) delete saved.phone;
  if (isNumberBlocked(saved.dmPhone)) delete saved.dmPhone;
  if (isInstagramBlocked(saved.instagram)) delete saved.instagram;
  if (isRouteBlocked(saved.route)) delete saved.route;
  if (isRouteBlocked(saved.second)) delete saved.second;
  const bestRoute = stripRoute(saved.bestRoute);
  const secondRoute = stripRoute(saved.secondRoute);
  if (bestRoute) saved.bestRoute = bestRoute;
  else delete saved.bestRoute;
  if (secondRoute) saved.secondRoute = secondRoute;
  else delete saved.secondRoute;
  return saved;
}

/** Checks one row and gives its profile. */
export function profileOf(row: LoadRow, loadedAt: string): Prospect {
  if (!Number.isInteger(row.n) || row.n < 1 || row.n > 99999) throw new RowError("n", "the number in the list is not a whole number from 1");
  const brand = plain(row.brand);
  if (!brand) throw new RowError("brand", "the brand has no name");
  const liveAds = count(row.liveAds);
  const bestRoute = routeLabel("bestRoute", row.bestRoute);
  const secondRoute = routeLabel("secondRoute", row.secondRoute);
  const notes = row.notes;
  if (notes && notes.length > 500) throw new RowError("notes", "the notes are longer than 500 characters");
  const pitch = row.pitch?.trim();
  if (pitch && pitch.length > 500) throw new RowError("pitch", "the pitch context is longer than 500 characters");
  if (row.dmTitle && row.dmTitle.length > 189) throw new RowError("dmTitle", "the title is longer than 189 characters");
  if (row.dmVerify !== undefined && !["valid", "risky", "invalid", "unknown"].includes(row.dmVerify)) throw new RowError("dmVerify", "the email check is not one of valid, risky, invalid or unknown");
  if (row.sells !== undefined && row.sells !== "" && !["product", "service", "hybrid"].includes(row.sells)) throw new RowError("sells", "the value is not product, service, hybrid or blank");
  if (row.mergedInto !== undefined && (!Number.isInteger(row.mergedInto) || row.mergedInto < 1 || row.mergedInto > 99999)) throw new RowError("mergedInto", "the survivor is not a whole number from 1");
  const route = routeOf(bestRoute);
  const second = routeOf(secondRoute);
  const decisionMaker = person(row.decisionMaker);
  const dmTitle = person(row.dmTitle);
  return removeBlocked({
    id: prospectId(row.n),
    n: row.n,
    brand,
    sector: plain(row.sector) ?? "Other",
    liveAds,
    tier: tierOf(liveAds),
    ...(row.sells ? { sells: row.sells } : {}),
    ...optional("newestAd", day(row.newestAd)),
    ...optional("bestRoute", bestRoute),
    ...optional("secondRoute", secondRoute),
    ...(route ? { route: withRoutePerson(route, decisionMaker, dmTitle) } : {}),
    ...(second ? { second: withRoutePerson(second, decisionMaker, dmTitle) } : {}),
    whatsapp: numbers(row.whatsapp),
    ...optional("email", address(row.email)),
    ...optional("phone", plain(row.phone)),
    ...optional("instagram", plain(row.instagram)),
    ...optional("decisionMaker", decisionMaker),
    ...optional("dmTitle", dmTitle),
    ...optional("linkedin", plain(row.linkedin)),
    ...optional("dmEmail", plain(row.dmEmail)?.toLowerCase()),
    ...(row.dmVerify ? { dmVerify: row.dmVerify } : {}),
    ...optional("dmPhone", plain(row.dmPhone)),
    ...(notes ? { notes } : {}),
    ...(pitch ? { pitch } : {}),
    ...(notes ? { flags: flagsFrom(notes) } : {}),
    ...(row.mergedInto !== undefined ? { mergedInto: prospectId(row.mergedInto) } : {}),
    loadedAt,
  });
}

const sameChannelAndTo = (a: { channel: string; to: string } | undefined, b: { channel: string; to: string } | undefined) =>
  (!a && !b) || Boolean(a && b && a.channel === b.channel && a.to === b.to);

/**
 * Loads rows of the list. It can be run again: it adds new rows and updates the list's own fields.
 * It writes profiles and the opt-out register, without changing history, ads, sends or existing opt-outs.
 */
export async function loadRows(
  store: OutreachStore,
  rows: LoadRow[],
  now: () => Date,
  openBatches: ReadonlyMap<string, string> = new Map(),
): Promise<{ added: number; updated: number; merged: number; blocked: number; refused: LoadRefusal[] }> {
  const files = new Map((await store.all({ includeMerged: true })).map((file) => [file.profile.id, file]));
  const optOuts = await store.optOuts();
  const loadedAt = now().toISOString();
  const prepared = rows.map((row, index) => {
    try {
      return { row, index, profile: profileOf(row, loadedAt), error: undefined as unknown, duplicate: false };
    } catch (error) {
      return { row, index, profile: undefined, error, duplicate: false };
    }
  });
  const seen = new Set<number>();
  for (const item of prepared) {
    if (!item.profile) continue;
    item.duplicate = seen.has(item.profile.n);
    seen.add(item.profile.n);
  }
  const order = [
    ...prepared.filter((item) => item.profile && !item.duplicate && !item.profile.mergedInto),
    ...prepared.filter((item) => item.profile && !item.duplicate && item.profile.mergedInto),
    ...prepared.filter((item) => !item.profile || item.duplicate),
  ];
  const refused: { index: number; refusal: LoadRefusal }[] = [];
  let added = 0;
  let updated = 0;
  let merged = 0;
  let blocked = 0;
  for (const item of order) {
    const { row } = item;
    try {
      if (item.error) throw item.error;
      if (item.duplicate) throw new RowError("n", "this number is in the rows twice");
      let profile = item.profile!;
      const file = files.get(profile.id);
      const before = file?.profile;
      // A number that now names another brand would give that brand the first one's history.
      if (before && !sameName(before.brand, profile.brand)) throw new RowError("brand", `number ${profile.n} is saved as "${before.brand}": a row keeps its number`);
      if (profile.mergedInto) {
        const survivor = files.get(profile.mergedInto)?.profile ?? await store.find(profile.mergedInto);
        if (!survivor || survivor.mergedInto || survivor.id === profile.id) throw new RowError("mergedInto", "the survivor does not exist or is itself merged");
        if (file && (file.ads.length > 0 || file.sends.length > 0 || file.events.length > 0 || openBatches.has(profile.id))) {
          throw new RowError("mergedInto", "the merged row has its own history: the owner decides");
        }
      }
      if (file && before) {
        const previous = { ...file, profile: before };
        const oldTarget = sendTarget(previous, optOuts);
        const active = ["pick_waits", "pick_made", "ad_waits", "ready"].includes(stageOf(previous, optOuts));
        const nextTarget = sendTarget({ ...file, profile }, optOuts);
        if (oldTarget && nextTarget && !sameChannelAndTo(oldTarget, nextTarget) && active) {
          profile.routeCheck = { since: loadedAt, channel: oldTarget.channel, direct: oldTarget.direct };
        } else if (before.routeCheck) {
          profile.routeCheck = before.routeCheck;
        }
        if (before.newestAd && (!profile.newestAd || before.newestAd > profile.newestAd)) profile.newestAd = before.newestAd;
      }
      profile = removeBlocked(profile);
      await store.saveProfile(profile);
      // An opt-out is for the contact. A number or an address the list now gives to an opted-out brand is off every list too.
      if (file && !profile.test && file.events.some((event) => event.type === "optout")) await store.addOptOut(profile);
      files.set(profile.id, { profile, ads: file?.ads ?? [], sends: file?.sends ?? [], events: file?.events ?? [] });
      if (before) updated += 1;
      else added += 1;
      if (profile.mergedInto) merged += 1;
      if (profile.flags?.some((flag) => flag.kind === "blocked")) blocked += 1;
    } catch (error) {
      if (!(error instanceof RowError)) throw error;
      refused.push({ index: item.index, refusal: { row: row.n, field: error.field, why: error.why } });
    }
  }
  return { added, updated, merged, blocked, refused: refused.sort((a, b) => a.index - b.index).map((entry) => entry.refusal) };
}

/** A prospect made to try the pages. Its name says what it is. */
export async function makeTestProspect(store: OutreachStore, input: { brand: string; whatsapp?: string | undefined; email?: string | undefined }, now: () => Date): Promise<Prospect> {
  let checked: Prospect;
  try {
    checked = profileOf({ n: 1, brand: input.brand, sector: "Test", liveAds: 0, tier: OUTREACH_TIERS[0], whatsapp: input.whatsapp, email: input.email }, now().toISOString());
  } catch (error) {
    if (error instanceof RowError) throw new Refusal(`The test prospect was not made: ${error.message}.`);
    throw error;
  }
  const profile: Prospect = { ...checked, id: `T${randomUUID().replace(/-/g, "").slice(0, 8)}`, n: 0, test: true };
  await store.saveProfile(profile);
  return profile;
}
