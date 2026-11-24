import { z } from "zod";
import type { BrandStore } from "../../brand/store.js";
import { findAllUsd, monitorExecutions, MONITOR_HOURS, PRICES, SHOP_MARKETS, type MonitorFrequency, type ParallelClient } from "../../parallel/client.js";
import { WATCHES_MAX, type Watches } from "../../parallel/watches.js";
import { isPublicHttpsUrl } from "../../urlsafety.js";
import { defineTool, Refusal, type ToolDefinition } from "../registry.js";
import { DATA } from "./facts.js";

export interface LeadToolDeps {
  brands: BrandStore;
  parallel: ParallelClient;
  watches: Watches;
}

const id = z.string().min(1).max(64);
const batchId = id.optional().describe("The batch this is for, so its cost counts on that batch.");
const objective = z.string().min(3).max(500).describe("What you want to find, in one or two sentences.");
const key = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, "Letters, digits, _ and - only.");
const runId = z.string().min(1).max(200);
const LEAD = "Each result is a lead, not a fact: a fact is saved only with facts_save, from a page that states it, and a contact it gives is checked by the owner before he writes to it.";
const usd = (value: number) => `US$${value.toFixed(value < 0.1 ? 3 : 2)}`;
const FREQUENCIES = Object.keys(MONITOR_HOURS) as [MonitorFrequency, ...MonitorFrequency[]];

/**
 * The rest of Parallel (owner, 24-11-2026): decisions, shopping, places, the search for companies and people,
 * FindAll and watches. A paid tool is the owner's already; the ones that find leads or run on at Parallel are
 * owner-only by name too, their free reads included. Every paid call goes through the ledger.
 */
export function leadTools({ brands, parallel, watches }: LeadToolDeps): ToolDefinition[] {
  return [
    defineTool({
      name: "web_decide",
      description: `Answers up to 20 typed questions from current web pages through Parallel, in one call. Costs ${usd(PRICES.decisions)}. noul: a statement that is true or false; the answer is a probability from 0 to 1, and no evidence is not a "false". choice: one of the options you name in criteria (add an option such as unknown). score: a level of the scale you give in criteria as a list of 2 to 10 levels, lowest first; the answer counts the levels from 0. Put what the questions are about in state, such as the brand and its site. The pages behind the answers come back as citations. ${LEAD} ${DATA}`,
      input: {
        state: z.record(key, z.union([z.string().max(500), z.number(), z.boolean()])).describe("What the questions are about, as a few named values."),
        questions: z
          .array(
            z.strictObject({
              name: key,
              type: z.enum(["noul", "choice", "score"]),
              instructions: z.string().min(5).max(500).describe("The question, in one sentence."),
              criteria: z
                .union([z.record(z.string().min(1).max(60), z.string().min(1).max(300)), z.array(z.string().min(1).max(300)).min(2).max(10)])
                .optional()
                .describe("noul: optional true and false, by name. choice: 2 or more options, by name. score: a list of 2 to 10 levels, lowest first."),
            }),
          )
          .min(1)
          .max(20),
        batchId,
      },
      paid: true,
      handler: async ({ state, questions, batchId }) => {
        if (new Set(questions.map((question) => question.name)).size !== questions.length) throw new Refusal("Give each question its own name.");
        for (const question of questions) {
          const levels = Array.isArray(question.criteria);
          if (question.type === "score" && !levels) throw new Refusal(`Question ${question.name} is a score: give criteria as a list of 2 to 10 levels, lowest first.`);
          if (question.type !== "score" && levels) throw new Refusal(`Question ${question.name} is no score: give criteria by name, not as a list.`);
          if (question.type === "choice" && Object.keys(question.criteria ?? {}).length < 2) throw new Refusal(`Question ${question.name} needs two or more options in criteria.`);
        }
        const asked = questions.map(({ criteria, ...rest }) => ({ ...rest, ...(criteria ? { criteria } : {}) }));
        return { untrusted: true, ...(await parallel.decide({ state, questions: asked, ...(batchId ? { batchId } : {}) })) };
      },
    }),
    defineTool({
      name: "shop_search",
      description: `Finds products a shopper can buy through Parallel: each result is one product at one store, with its price, its store and a picture. Costs ${usd(PRICES.shopping)}. Use it for a pack's real photo and for a price lead. The market is a country code and sets the stores and the currency; it is sg when left out. Returns a searchId: product_save accepts these pictures with fromId set to it. A price here is a lead, not a fact. ${DATA}`,
      input: {
        queries: z.array(z.string().min(2).max(200)).min(1).max(5).describe("A brand with its model finds one product; a product type with its key attributes finds a category."),
        objective: objective.optional(),
        market: z.enum(SHOP_MARKETS).default("sg").describe("The country code of a market that Parallel serves."),
        minPrice: z.number().min(0).optional(),
        maxPrice: z.number().positive().optional(),
        condition: z.enum(["new", "used", "refurbished", "any"]).optional(),
        maxResults: z.number().int().min(1).max(40).default(20),
        batchId,
      },
      paid: true,
      handler: async ({ queries, objective, market, minPrice, maxPrice, condition, maxResults, batchId }) => {
        if (minPrice !== undefined && maxPrice !== undefined && maxPrice < minPrice) throw new Refusal("maxPrice is under minPrice.");
        const found = await parallel.shopping({
          queries,
          market,
          maxResults,
          ...(objective ? { objective } : {}),
          ...(minPrice === undefined ? {} : { minPrice }),
          ...(maxPrice === undefined ? {} : { maxPrice }),
          ...(condition ? { condition } : {}),
          ...(batchId ? { batchId } : {}),
        });
        const results = found.map((result) => ({ ...result, imageUrl: result.imageUrl && isPublicHttpsUrl(result.imageUrl) ? result.imageUrl : null }));
        const photos = results.flatMap((result) => result.imageUrl ?? []);
        const offer = await brands.offer({ kind: "images", url: "", logos: [], photos, productPages: [], colours: [] });
        return { searchId: offer.id, untrusted: true, results };
      },
    }),
    defineTool({
      name: "place_search",
      description: `Finds places through Parallel, such as the outlets of a brand: the name, the address, the phone, the rating and the page of each. Costs ${usd(PRICES.places.fast)} (fast) or ${usd(PRICES.places.advanced)} (advanced, more complete). One location in a call; it is Singapore when left out. ${LEAD} ${DATA}`,
      input: {
        query: z.string().min(1).max(200).describe("A kind of place, a product or a place's name."),
        location: z.string().min(2).max(200).default("Singapore").describe("One city, area, address or postal code."),
        mode: z.enum(["fast", "advanced"]).default("fast"),
        maxResults: z.number().int().min(1).max(20).default(20),
        openNow: z.boolean().default(false),
        batchId,
      },
      paid: true,
      handler: async ({ query, location, mode, maxResults, openNow, batchId }) => ({
        untrusted: true,
        results: await parallel.places({ query, location, mode, maxResults, openNow, ...(batchId ? { batchId } : {}) }),
      }),
    }),
    defineTool({
      name: "entity_search",
      ownerOnly: true,
      description: `Finds companies or people on the web for an objective through Parallel, in seconds: the name, the page and one line on each. Costs ${usd(PRICES.entitySearch)}. Only for the owner's session. The list is ranked, not checked, and some entries do not meet the objective; use findall_start when each must be checked. People are found in their professional role only. ${LEAD} ${DATA}`,
      input: { entityType: z.enum(["companies", "people"]), objective, limit: z.number().int().min(5).max(100).default(20), batchId },
      paid: true,
      handler: async ({ entityType, objective, limit, batchId }) => ({
        untrusted: true,
        entities: await parallel.entitySearch({ entityType, objective, limit, ...(batchId ? { batchId } : {}) }),
      }),
    }),
    defineTool({
      name: "findall_plan",
      ownerOnly: true,
      description: `Turns an objective into the conditions of a FindAll run through Parallel. Parallel lists no price for this step. Only for the owner's session. Read the conditions, change what is too strict or too loose, then give them to findall_start. ${DATA}`,
      input: { objective },
      handler: async ({ objective }) => ({ untrusted: true, ...(await parallel.findAllPlan(objective)) }),
    }),
    defineTool({
      name: "findall_start",
      ownerOnly: true,
      description: `Starts a FindAll run through Parallel: it looks for companies or people and checks each one against your conditions, with the pages that prove it. Only for the owner's session. preview costs ${usd(PRICES.findAll.preview.run)} and checks 5 to 10 candidates: run it first. base costs ${usd(PRICES.findAll.base.run)} and ${usd(PRICES.findAll.base.match)} for each match; core costs ${usd(PRICES.findAll.core.run)} and ${usd(PRICES.findAll.core.match)} for each match. The studio holds the price of the run with every match of matchLimit, so a base run for 20 matches is held at ${usd(findAllUsd("base", 20))}. A run needs no yes from the owner (his rule: a FindAll run of US$10 or less goes on), but the caps of the ledger still stop it: the month's and a batch's, or the outreach campaign's and its batch's for a batch of outreach. It takes minutes to an hour: read it with findall_get. ${LEAD}`,
      input: {
        objective,
        entityType: z.string().min(3).max(40).describe("What to find, such as companies or people."),
        conditions: z
          .array(z.strictObject({ name: z.string().regex(/^[a-z][a-z0-9_]{0,59}$/, "Small letters, digits and _ only."), description: z.string().min(5).max(500) }))
          .min(1)
          .max(10)
          .describe("What each match must meet. findall_plan suggests them."),
        generator: z.enum(["preview", "base", "core"]).default("preview"),
        matchLimit: z.number().int().min(5).max(50).default(10).describe("The most matches to find. For preview: the candidates to check, 5 to 10."),
        batchId,
      },
      paid: true,
      handler: ({ objective, entityType, conditions, generator, matchLimit, batchId }) => {
        if (generator === "preview" && matchLimit > 10) throw new Refusal("A preview checks 5 to 10 candidates: give a matchLimit of 10 or fewer.");
        return parallel.findAllStart({ objective, entityType, conditions, generator, matchLimit, ...(batchId ? { batchId } : {}) });
      },
    }),
    defineTool({
      name: "findall_get",
      ownerOnly: true,
      description: `The state of a FindAll run and its candidates as they stand, each with what was found for each condition and the pages behind it. Free. Only for the owner's session. It gives the matches only, unless all is true. ${LEAD} ${DATA}`,
      input: { findAllId: runId, all: z.boolean().default(false) },
      handler: async ({ findAllId, all }) => ({ untrusted: true, ...(await parallel.findAllGet(findAllId, !all)) }),
    }),
    defineTool({
      name: "findall_cancel",
      ownerOnly: true,
      description: "Stops a FindAll run. Free. Only for the owner's session. What it found so far stays readable with findall_get. Its price stays held in the ledger as it was.",
      input: { findAllId: runId },
      writes: true,
      handler: async ({ findAllId }) => {
        await parallel.findAllCancel(findAllId);
        return { findAllId, cancelled: true };
      },
    }),
    defineTool({
      name: "watch_start",
      ownerOnly: true,
      description: `Starts a watch through Parallel: it looks at the web on a schedule for new events on one subject, such as a brand's launches, and keeps each event with the pages behind it. Only for the owner's session. Parallel charges each run: ${usd(PRICES.monitor.lite)} (lite) or ${usd(PRICES.monitor.base)} (base, wider). A watch has an end: the studio holds the price of its whole life at the start, and cancels it after days. A daily lite watch for 30 days is held at ${usd(PRICES.monitor.lite * monitorExecutions("1d", 30))}; an hourly one at ${usd(PRICES.monitor.lite * monitorExecutions("1h", 30))}. A watch of US$1 or more waits for the owner's yes. At most ${WATCHES_MAX} run at one time. It finds only what is new after its start. Say what to look for in plain words, with no dates.`,
      input: {
        query: z.string().min(10).max(500).describe("What to watch for, in one sentence."),
        frequency: z.enum(FREQUENCIES).default("1d"),
        processor: z.enum(["lite", "base"]).default("lite"),
        days: z.number().int().min(1).max(30).default(30).describe("Its life in days."),
      },
      paid: true,
      writes: true,
      handler: ({ query, frequency, processor, days }, context) => watches.start({ query, frequency, processor, days, by: context.user.email }),
    }),
    defineTool({
      name: "watch_list",
      ownerOnly: true,
      description: "The watches the studio started, newest first: what each looks for, how often, its end and whether it still runs. Free. Only for the owner's session. A watch at starting had no answer from Parallel at its start and holds a place: the daily job finds it at Parallel and ends it on time, or drops it after two days.",
      input: {},
      handler: async () => ({ watches: await watches.list() }),
    }),
    defineTool({
      name: "watch_events",
      ownerOnly: true,
      description: `What a watch found, newest first: each event with its text and the pages behind it. When next comes back, give it as cursor to read the older events. Free. Only for the owner's session. ${LEAD} ${DATA}`,
      input: { monitorId: runId, limit: z.number().int().min(1).max(50).default(20), cursor: z.string().min(1).max(500).optional().describe("The next of the answer before, for the older events.") },
      handler: async ({ monitorId, limit, cursor }) => ({ untrusted: true, ...(await watches.events(monitorId, limit, cursor)) }),
    }),
    defineTool({
      name: "watch_stop",
      ownerOnly: true,
      description: "Cancels a watch at Parallel before its end. Free. Only for the owner's session. Its events stay readable. The price held for its life stays in the ledger as it was.",
      input: { monitorId: runId },
      writes: true,
      handler: ({ monitorId }) => watches.stop(monitorId),
    }),
  ];
}
