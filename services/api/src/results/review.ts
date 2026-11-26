import { CREATIVE_TAG_FIELDS, type AdPerformanceRead, type AdResult, type CreativeTag, type PerformanceTotals, type TagPerformanceRead } from "@a11-wild/shared";

const sum = (rows: AdResult[], field: "spend" | "conversions" | "conversionValue"): number | undefined =>
  rows.every((row) => row[field] !== undefined) ? rows.reduce((total, row) => total + (row[field] as number), 0) : undefined;

/** A row count as money divided by a count. Undefined stays unknown; division by zero stays unknown. */
const ratio = (top: number | undefined, bottom: number | undefined, scale = 1) => (top !== undefined && bottom !== undefined && bottom > 0 ? (top / bottom) * scale : undefined);

/** The totals of one ad over rows. Reach and frequency are not additive, so only a single-period total can carry them. */
export function totalsOf(rows: AdResult[]): PerformanceTotals {
  const impressions = rows.reduce((total, row) => total + row.impressions, 0);
  const clicks = rows.reduce((total, row) => total + row.clicks, 0);
  const spend = sum(rows, "spend");
  const conversions = sum(rows, "conversions");
  const conversionValue = sum(rows, "conversionValue");
  return {
    impressions,
    clicks,
    ctr: impressions === 0 ? 0 : clicks / impressions,
    ...(spend !== undefined ? { spend } : {}),
    ...(rows.length === 1 && rows[0]?.reach !== undefined ? { reach: rows[0].reach } : {}),
    ...(rows.length === 1 && rows[0]?.frequency !== undefined ? { frequency: rows[0].frequency } : {}),
    ...(conversions !== undefined ? { conversions } : {}),
    ...(conversionValue !== undefined ? { conversionValue } : {}),
    ...(ratio(spend, impressions, 1000) !== undefined ? { cpm: ratio(spend, impressions, 1000) as number } : {}),
    ...(ratio(spend, conversions) !== undefined ? { cpa: ratio(spend, conversions) as number } : {}),
    ...(ratio(conversionValue, spend) !== undefined ? { roas: ratio(conversionValue, spend) as number } : {}),
  };
}

/** Totals of already grouped ads. Unique reach is never added across ads or periods. */
function combineTotals(reads: PerformanceTotals[]): PerformanceTotals {
  const impressions = reads.reduce((total, read) => total + read.impressions, 0);
  const clicks = reads.reduce((total, read) => total + read.clicks, 0);
  const every = (field: "spend" | "conversions" | "conversionValue") => (reads.every((read) => read[field] !== undefined) ? reads.reduce((total, read) => total + (read[field] as number), 0) : undefined);
  const spend = every("spend");
  const conversions = every("conversions");
  const conversionValue = every("conversionValue");
  return {
    impressions,
    clicks,
    ctr: impressions === 0 ? 0 : clicks / impressions,
    ...(spend !== undefined ? { spend } : {}),
    ...(conversions !== undefined ? { conversions } : {}),
    ...(conversionValue !== undefined ? { conversionValue } : {}),
    ...(ratio(spend, impressions, 1000) !== undefined ? { cpm: ratio(spend, impressions, 1000) as number } : {}),
    ...(ratio(spend, conversions) !== undefined ? { cpa: ratio(spend, conversions) as number } : {}),
    ...(ratio(conversionValue, spend) !== undefined ? { roas: ratio(conversionValue, spend) as number } : {}),
  };
}

/** A simple fatigue read from the first and latest non-overlapping periods. It is a warning only, never proof. */
function fatigueOf(rows: AdResult[]): { level?: "warning" | "severe"; reasons: string[] } {
  const ordered = [...rows].sort((a, b) => a.from.localeCompare(b.from));
  if (ordered.length < 2) return { reasons: [] };
  const first = ordered[0] as AdResult;
  const latest = ordered.at(-1) as AdResult;
  if (latest.from <= first.to || first.ctr <= 0 || latest.frequency === undefined) return { reasons: [] };
  const drop = (first.ctr - latest.ctr) / first.ctr;
  if (drop < 0.2) return { reasons: [] };
  const percent = Math.round(drop * 100);
  if (latest.frequency >= 5) return { level: "severe", reasons: [`CTR fell ${percent}% from the first period while frequency reached ${latest.frequency.toFixed(1)}.`] };
  if (latest.frequency >= 3) return { level: "warning", reasons: [`CTR fell ${percent}% from the first period while frequency reached ${latest.frequency.toFixed(1)}.`] };
  return { reasons: [] };
}

/** Deterministic performance evidence. The agent explains it; no action fires from it. */
export function performanceReview(results: AdResult[], tags: CreativeTag[], input: { targetCpa?: number; minimumConversions?: number } = {}): { ads: AdPerformanceRead[]; tagReads: TagPerformanceRead[]; notes: string[] } {
  const minimum = input.minimumConversions ?? 3;
  const names = [...new Set(results.map((result) => result.adName))].sort();
  const notes: string[] = [];
  const ads = names.map((adName): AdPerformanceRead => {
    const rows = results.filter((result) => result.adName === adName);
    const totals = totalsOf(rows);
    const reasons: string[] = [];
    const tag = tags.find((candidate) => candidate.adName === adName);
    const baseline = rows.map((row) => row.baselineCtr).filter((value): value is number => value !== undefined).at(-1);
    const attention = baseline === undefined ? undefined : totals.ctr >= baseline * 1.2 ? "strong" : totals.ctr <= baseline * 0.8 ? "weak" : "mixed";
    if (attention === "strong") reasons.push(`CTR ${(totals.ctr * 100).toFixed(2)}% is at least 20% above the saved baseline.`);
    if (attention === "weak") reasons.push(`CTR ${(totals.ctr * 100).toFixed(2)}% is at least 20% below the saved baseline.`);
    if (attention === "mixed") reasons.push(`CTR ${(totals.ctr * 100).toFixed(2)}% is close to the saved baseline.`);
    const fatigue = fatigueOf(rows);
    reasons.push(...fatigue.reasons);

    let signal: AdPerformanceRead["signal"];
    if (rows.length === 0) signal = "no_data";
    else if (totals.conversions === undefined) {
      signal = "traffic_only";
      reasons.push("The saved reports do not all carry conversion outcomes, so this read can judge attention only, not customers or profit.");
    } else if (input.targetCpa !== undefined && totals.spend !== undefined && totals.spend >= input.targetCpa * 2 && totals.conversions === 0) {
      signal = "stop_or_fix";
      reasons.push(`Spend reached at least twice the target CPA with no saved conversion.`);
    } else if (totals.conversions < minimum) {
      signal = "not_enough_data";
      reasons.push(`Only ${totals.conversions} conversion${totals.conversions === 1 ? "" : "s"} are saved; the review floor is ${minimum}.`);
    } else if (input.targetCpa === undefined) {
      signal = "watch";
      reasons.push("No target CPA was given, so the studio does not call this a winner or a loser.");
    } else if (totals.cpa !== undefined && totals.cpa <= input.targetCpa) {
      signal = "scale_candidate";
      reasons.push(`CPA ${totals.cpa.toFixed(2)} is inside the target ${input.targetCpa.toFixed(2)} after at least ${minimum} conversions.`);
    } else if (totals.cpa !== undefined && totals.cpa > input.targetCpa * 1.25) {
      signal = "stop_or_fix";
      reasons.push(`CPA ${totals.cpa.toFixed(2)} is more than 25% above the target ${input.targetCpa.toFixed(2)}.`);
    } else {
      signal = "watch";
      reasons.push("The result is near the target or incomplete, so the correct action is to watch or test, not to scale.");
    }
    return { adName, totals, signal, ...(attention ? { attention } : {}), ...(fatigue.level ? { fatigue: fatigue.level } : {}), reasons, ...(tag ? { tag } : {}) };
  });

  if (ads.some((ad) => ad.signal === "traffic_only")) notes.push("Some ads have clicks but no complete conversion outcome. Do not call them winners from CTR alone.");
  if (ads.some((ad) => ad.fatigue)) notes.push("Fatigue is a warning from limited periods. Check the live account before replacing a profitable ad.");

  const groups = new Map<string, { field: (typeof CREATIVE_TAG_FIELDS)[number]; value: string; reads: PerformanceTotals[] }>();
  for (const ad of ads) {
    if (!ad.tag) continue;
    for (const field of CREATIVE_TAG_FIELDS) {
      const value = ad.tag[field]?.trim();
      if (!value) continue;
      const key = `${field}\0${value}`;
      const group = groups.get(key) ?? { field, value, reads: [] };
      group.reads.push(ad.totals);
      groups.set(key, group);
    }
  }
  const tagReads = [...groups.values()].map((group) => ({ field: group.field, value: group.value, ads: group.reads.length, totals: combineTotals(group.reads) }));
  return { ads, tagReads, notes };
}
