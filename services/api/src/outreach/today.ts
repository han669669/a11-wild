import type { OutreachAd, OutreachAdView, OutreachStep, OutreachTemplates, ProspectFile, ProspectRow, TodayLine, TodayPage } from "@a11-wild/shared";
import { isSendingDay, nextSendingDay, singaporeDay } from "./days.js";
import { messagesFor } from "./messages.js";
import { chosen, nextStep, sameContact, type OutreachSequence } from "./sequence.js";
import { adWaits, approvedAd, candidatesWait, channelOf, defaultRoute, newestAd, owedAnswer, routeHeldUnresolved, sendTarget, stageOf, verdictOf } from "./stage.js";
import type { OutreachStore } from "./store.js";
import type { Pictures } from "../pictures/store.js";

/** A prospect as a line of a list: no number and no address. */
const utcDay = (day: string): number => {
  const [year, month, date] = day.split("-").map(Number);
  return Date.UTC(year!, month! - 1, date!);
};

export function rowOf(file: ProspectFile, optOuts: ReadonlySet<string>, shared: ReadonlyMap<string, ProspectFile>, now = new Date()): ProspectRow {
  const { profile } = file;
  const stage = stageOf(file, optOuts);
  const channel = channelOf(file);
  const target = sendTarget(file);
  const staleDays = profile.newestAd ? Math.max(0, Math.floor((utcDay(singaporeDay(now)) - utcDay(profile.newestAd)) / 86_400_000)) : undefined;
  const next = stage === "contacted" ? nextStep(file) : undefined;
  const earlier = shared.get(profile.id);
  return {
    id: profile.id,
    n: profile.n,
    brand: profile.brand,
    sector: profile.sector,
    liveAds: profile.liveAds,
    tier: profile.tier,
    stage,
    ...(channel ? { channel } : {}),
    ...(stage !== "opted_out" && target?.direct && profile.decisionMaker ? { person: profile.decisionMaker } : {}),
    ...(staleDays !== undefined ? { staleDays } : {}),
    flags: {
      duplicate: profile.flags?.some((flag) => flag.kind === "duplicate") ?? false,
      blocked: profile.flags?.some((flag) => flag.kind === "blocked") ?? false,
      check: routeHeldUnresolved(file),
    },
    adWaits: adWaits(file) && stage !== "opted_out",
    ...(next ? { next } : {}),
    ...(earlier && !chosen(file) ? { sameContactAs: earlier.profile.brand } : {}),
    ...(profile.test ? { test: true as const } : {}),
  };
}

/** The two links of a picture: one to look at, one to save as a file. */
export type AdLinks = Pick<Pictures, "viewUrl" | "downloadUrl">;

export async function adView(file: ProspectFile, ad: OutreachAd, pictures: AdLinks): Promise<OutreachAdView> {
  const verdict = verdictOf(file, ad)?.type;
  const name = `${file.profile.brand}-ad-${ad.n}.${ad.key.split(".").at(-1) ?? "png"}`;
  const [viewUrl, downloadUrl] = await Promise.all([pictures.viewUrl(ad.key), pictures.downloadUrl(ad.key, name)]);
  return { ...ad, viewUrl, downloadUrl, ...(verdict ? { verdict: verdict === "ad_yes" ? ("yes" as const) : ("no" as const) } : {}) };
}

/** The prospects that wait for the owner today, before any picture link is made for them. */
export interface TodayLists {
  day: string;
  daily: number;
  firstsSent: number;
  templates: OutreachTemplates | undefined;
  optOuts: ReadonlySet<string>;
  shared: ReadonlyMap<string, ProspectFile>;
  /** The answer that has waited longest is first. */
  owed: { file: ProspectFile; reply: { text?: string; at: string } }[];
  followUps: { file: ProspectFile; step: OutreachStep }[];
  firsts: ProspectFile[];
  adsWaiting: ProspectFile[];
  /** The brands whose drafts wait for the owner's pick, with how many he can pick from. */
  picks: { file: ProspectFile; drafts: number }[];
}

/**
 * Which prospects wait for the owner today. The Today page and the count on the start page both read this, so they cannot disagree.
 * The weekdays are the plan, and a follow-up is due on one. The lists are the same on every day: the owner sends when he chooses.
 */
export async function todayLists(deps: { store: OutreachStore; sequence: OutreachSequence; now: () => Date }): Promise<TodayLists> {
  const { store, sequence } = deps;
  const now = deps.now();
  const day = singaporeDay(now);
  const [files, optOuts, daily, firstsSent, templates] = await Promise.all([store.all(), store.optOuts(), sequence.daily(), store.placesTaken(day), sequence.templates()]);
  const shared = sameContact(files);
  const lists: TodayLists = { day, daily, firstsSent, templates, optOuts, shared, owed: [], followUps: [], firsts: [], adsWaiting: [], picks: [] };
  const firstCandidates: ProspectFile[] = [];

  for (const file of files) {
    const stage = stageOf(file, optOuts);
    if (stage === "opted_out") continue;
    const reply = owedAnswer(file);
    if (reply && (stage === "replied" || stage === "in_talks")) lists.owed.push({ file, reply: { ...(reply.text ? { text: reply.text } : {}), at: reply.at } });
    if (adWaits(file) && stage !== "lost" && stage !== "parked") lists.adsWaiting.push(file);
    const shown = candidatesWait(file);
    if (shown && stage !== "lost" && stage !== "parked") lists.picks.push({ file, drafts: shown.drafts });
    if (stage === "contacted") {
      const next = nextStep(file);
      if (next && next.due <= day) lists.followUps.push({ file, step: next.step });
    }
    if (stage === "ready") {
      // A test prospect takes no place of the day. A brand that shares its contact waits for the owner's choice.
      if (shared.has(file.profile.id) && !chosen(file)) continue;
      firstCandidates.push(file);
    }
  }
  lists.owed.sort((a, b) => a.reply.at.localeCompare(b.reply.at));
  firstCandidates.sort((a, b) => {
    const aStale = rowOf(a, optOuts, shared, now).staleDays ?? 0;
    const bStale = rowOf(b, optOuts, shared, now).staleDays ?? 0;
    return Number(a.profile.test) - Number(b.profile.test) || Number(bStale >= 30) - Number(aStale >= 30) || a.profile.n - b.profile.n;
  });
  let places = Math.max(0, daily - firstsSent);
  for (const file of firstCandidates) {
    if (file.profile.test) lists.firsts.push(file);
    else if (places > 0) {
      places -= 1;
      lists.firsts.push(file);
    }
  }
  return lists;
}

/** What the owner does today, in his order: answers that are owed, follow-ups that are due, new first messages, and ads that wait for his look. */
export async function todayPage(deps: { store: OutreachStore; sequence: OutreachSequence; pictures: AdLinks; now: () => Date }): Promise<TodayPage> {
  const { pictures } = deps;
  const now = deps.now();
  const { day, daily, firstsSent, templates, optOuts, shared, owed, followUps, firsts, adsWaiting, picks } = await todayLists(deps);

  const line = async (file: ProspectFile, step: OutreachStep | undefined, ad: OutreachAd | undefined, extra: Partial<TodayLine> = {}): Promise<TodayLine> => {
    const found = defaultRoute(file);
    const routeCheck =
      routeHeldUnresolved(file) && file.profile.routeHeld && found
        ? {
            kept: file.profile.routeHeld,
            found,
          }
        : undefined;
    const target = step !== undefined && templates ? sendTarget(file) : undefined;
    const targetIsHeld = Boolean(target && file.profile.routeHeld?.channel === target.channel && file.profile.routeHeld.to === target.to);
    const sendTo = target
      ? {
          ...target,
          ...(target.direct && !target.person && !targetIsHeld && file.profile.decisionMaker ? { person: file.profile.decisionMaker } : {}),
          ...(target.direct && !target.person && !targetIsHeld && file.profile.dmTitle ? { title: file.profile.dmTitle } : {}),
        }
      : undefined;
    return {
      prospect: rowOf(file, optOuts, shared, now),
      ...(ad ? { ad: await adView(file, ad, pictures) } : {}),
      ...(step !== undefined ? { step } : {}),
      ...(step !== undefined && templates ? { messages: messagesFor(templates.steps[step], file.profile, target) } : {}),
      ...(sendTo ? { sendTo } : {}),
      ...(routeCheck ? { routeCheck } : {}),
      ...(file.profile.flags?.length ? { flags: file.profile.flags } : {}),
      ...extra,
    };
  };

  const [owedLines, followUpLines, firstLines, waitingLines, pickLines] = await Promise.all([
    Promise.all(owed.map(({ file, reply }) => line(file, undefined, approvedAd(file), { reply }))),
    Promise.all(followUps.map(({ file, step }) => line(file, step, approvedAd(file)))),
    Promise.all(firsts.map((file) => line(file, 0, approvedAd(file)))),
    Promise.all(adsWaiting.map((file) => line(file, undefined, newestAd(file)))),
    Promise.all(picks.map(({ file, drafts }) => line(file, undefined, undefined, { drafts }))),
  ]);
  return {
    day,
    sendingDay: isSendingDay(day),
    nextSendingDay: nextSendingDay(day),
    daily,
    firstsSent,
    templates: templates !== undefined,
    owed: owedLines,
    followUps: followUpLines,
    firsts: firstLines,
    adsWaiting: waitingLines,
    picks: pickLines,
  };
}
