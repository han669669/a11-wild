import { Refusal } from "../mcp/registry.js";
import type { ProviderKeys } from "../secrets.js";
import type { SpendGate } from "../spend/gate.js";
import { NotBilledError, type SpendLedger } from "../spend/ledger.js";
import { toMicro } from "../spend/money.js";

const BASE = "https://api.parallel.ai";

/** Parallel's list prices in US dollars for one request, read from its pricing page on 24-11-2026. */
export const PRICES = {
  extractUrl: 0.001,
  search: { fast: 0.001, advanced: 0.005 },
  /** Each result a search asks for beyond the first ten. */
  searchExtraResult: 0.001,
  images: { fast: 0.001, advanced: 0.005 },
  task: { lite: 0.005, base: 0.01, core: 0.025, pro: 0.1 },
  decisions: 0.001,
  shopping: 0.005,
  places: { fast: 0.001, advanced: 0.005 },
  /** One request, with up to 100 results. */
  entitySearch: 0.005,
  /** One run, and each match it finds. `pro` (US$10 a run) is left out: it is over a batch's cap. */
  findAll: { preview: { run: 0.1, match: 0 }, base: { run: 0.25, match: 0.03 }, core: { run: 2, match: 0.15 } },
  /** One execution of a monitor. */
  monitor: { lite: 0.003, base: 0.01 },
} as const;

export type SearchMode = keyof typeof PRICES.search;
export type TaskProcessor = keyof typeof PRICES.task;
export type FindAllGenerator = keyof typeof PRICES.findAll;
export type MonitorProcessor = keyof typeof PRICES.monitor;
export type EntityType = "companies" | "people";

/**
 * The owner's rule of 24-11-2026: a FindAll run of this price or less needs no yes from him, and does not count
 * toward the US$1 at which other research waits. The month's cap and a batch's cap hold as before.
 */
export const FINDALL_NO_YES_USD = 10;
const NO_YES_KINDS: readonly string[] = ["findall"];

/** The hours between two executions of a monitor. */
/** The name of the studio's own id in a monitor's metadata at Parallel (16 characters at most). */
const WATCH_KEY = "studio_watch";

/** The markets that Parallel's shopping search serves. Any other country code is searched in the US, so the studio refuses it. */
export const SHOP_MARKETS = [
  "us", "ca", "mx", "br", "ar", "cl", "co", "gb", "ie", "de", "at", "fr", "be", "nl", "es", "pt", "it", "fi", "gr", "ch", "se", "no", "dk",
  "pl", "cz", "hu", "ro", "tr", "il", "ae", "sa", "za", "in", "jp", "kr", "cn", "tw", "hk", "sg", "my", "th", "id", "ph", "vn", "au", "nz",
] as const;
export type ShopMarket = (typeof SHOP_MARKETS)[number];

export const MONITOR_HOURS = { "1h": 1, "6h": 6, "12h": 12, "1d": 24, "7d": 168 } as const;
export type MonitorFrequency = keyof typeof MONITOR_HOURS;

/**
 * The executions a monitor of this life can run: the one at its start, and one for each interval.
 * One more day is counted, because the daily job that cancels it can come up to a day after its end.
 */
export const monitorExecutions = (frequency: MonitorFrequency, days: number): number => 1 + Math.ceil(((days + 1) * 24) / MONITOR_HOURS[frequency]);

export const findAllUsd = (generator: FindAllGenerator, matchLimit: number): number => {
  const price = PRICES.findAll[generator];
  return Math.round((price.run + price.match * matchLimit) * 1e6) / 1e6;
};

/** Parallel did not give a usable answer and the outcome is not known, so the call stays counted. */
export class ProviderError extends Refusal {}

export interface ExtractedPage {
  url: string;
  title: string | null;
  text: string;
}

export interface SearchResult {
  url: string;
  title: string | null;
  excerpts: string[];
}

export interface ImageResult {
  imageUrl: string;
  pageUrl: string | null;
  title: string | null;
  width: number | null;
  height: number | null;
}

export interface TaskRun {
  runId: string;
  status: string;
  /** Present when the run is complete. */
  output?: unknown;
  /** For each answer: the pages it came from, with the excerpts Parallel read. */
  basis?: unknown;
}

/** One named field of a research answer. */
export interface TaskField {
  name: string;
  description: string;
}

export interface SearchFilters {
  /** From 10 to 20. Each result over ten has its own price. */
  maxResults?: number;
  /** Only pages published on or after this day, as YYYY-MM-DD. */
  afterDate?: string;
  includeDomains?: string[];
  excludeDomains?: string[];
}

export interface DecisionQuestion {
  name: string;
  type: "noul" | "choice" | "score";
  instructions: string;
  /** noul: optional `true` and `false`, by name. choice: its options, by name. score: a list of its levels, lowest first. */
  criteria?: Record<string, string> | string[];
}

export interface Decisions {
  /** By the question's name. noul: a probability from 0 to 1. A refusal has only its type. */
  answers: Record<string, unknown>;
  /** The pages behind the whole call. */
  citations: { url: string; title: string | null; excerpts: string[] }[];
}

export interface ShopResult {
  url: string;
  title: string | null;
  merchant: string | null;
  brand: string | null;
  description: string | null;
  price: number | null;
  currency: string | null;
  originalPrice: number | null;
  rating: number | null;
  reviewCount: number | null;
  imageUrl: string | null;
  condition: string | null;
  availability: string | null;
}

export interface PlaceResult {
  name: string;
  url: string | null;
  address: string | null;
  phone: string | null;
  latitude: number | null;
  longitude: number | null;
  rating: string | null;
  description: string | null;
  openNow: boolean | null;
}

export interface Entity {
  name: string;
  url: string | null;
  description: string | null;
}

export interface FindAllPlan {
  objective: string;
  entityType: string;
  conditions: { name: string; description: string }[];
  /** The generator Parallel suggests. */
  generator: string | null;
}

export interface FindAllRun {
  findAllId: string;
  status: string;
  active: boolean;
  generated: number;
  matched: number;
  /** Why a finished run ended. */
  ended?: string;
  /** Present when the result was read. */
  candidates?: { name: string; url: string | null; description: string | null; match: string; output: unknown; basis: unknown }[];
}

export interface Monitor {
  monitorId: string;
  status: string;
}

const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" ? value : null);
const numeric = (value: unknown): number | null => (typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : null);
const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
const list = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null) : [];

/**
 * The only path to Parallel. Each call reserves its price in the ledger before it is sent.
 * An error reply never reaches the agent or the log as text, because a provider can echo the
 * request, and the request carries the key.
 */
export class ParallelClient {
  constructor(
    private readonly keys: ProviderKeys,
    private readonly ledger: SpendLedger,
    private readonly fetchFn: typeof fetch = (input, init) => fetch(input, init),
    /** Holds research at each US$1 until the owner says yes: by batch, or by month when it belongs to no batch. */
    private readonly gate?: SpendGate,
    private readonly timeoutMs = 25_000,
  ) {}

  private async send(kind: string, method: "GET" | "POST", path: string, body?: unknown): Promise<Record<string, unknown>> {
    const key = await this.keys.get("parallel");
    let response: Response;
    try {
      response = await this.fetchFn(`${BASE}${path}`, {
        method,
        headers: { "x-api-key": key, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new ProviderError(`Parallel did not answer the ${kind} request. Its outcome is not known, so it stays counted in the ledger.`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new NotBilledError(`Parallel refused the ${kind} request (status ${response.status}). Nothing was charged.`);
    }
    try {
      // A cancel answers with no body (status 204): that is a yes with nothing to read. Any other answer with no body cannot be read.
      if (response.status === 204) return {};
      return JSON.parse(await response.text()) as Record<string, unknown>;
    } catch {
      throw new ProviderError(`Parallel's answer to the ${kind} request could not be read. It stays counted in the ledger.`);
    }
  }

  private async paid<T>(
    kind: string,
    ref: string,
    usd: number,
    batchId: string | undefined,
    call: () => Promise<T>,
  ): Promise<T> {
    // Read the key first: with no key there is nothing to send, so nothing to reserve.
    await this.keys.get("parallel");
    const noYes = NO_YES_KINDS.includes(kind) && usd <= FINDALL_NO_YES_USD;
    if (this.gate && !noYes) await this.gate.research(batchId, await this.ledger.batchMicro(batchId, "parallel", NO_YES_KINDS), toMicro(usd));
    return this.ledger.paid({ service: "parallel", kind, ref, usd, ...(batchId ? { batchId } : {}) }, async () => ({
      value: await call(),
    }));
  }

  /** The full text of each page. A page Parallel could not read is in `failed`. */
  async extract(input: { urls: string[]; objective?: string; batchId?: string; maxChars?: number }): Promise<{
    pages: ExtractedPage[];
    failed: string[];
  }> {
    const usd = PRICES.extractUrl * input.urls.length;
    return this.paid("extract", input.urls[0] ?? "", usd, input.batchId, async () => {
      const reply = await this.send("extract", "POST", "/v1/extract", {
        urls: input.urls,
        ...(input.objective ? { objective: input.objective } : {}),
        advanced_settings: { full_content: { max_chars_per_result: input.maxChars ?? 60_000 } },
      });
      const pages = list(reply.results).flatMap((result): ExtractedPage[] => {
        const url = str(result.url);
        const text = str(result.full_content) ?? (Array.isArray(result.excerpts) ? result.excerpts.join("\n\n") : "");
        return url && text ? [{ url, title: str(result.title), text }] : [];
      });
      const read = new Set(pages.map((page) => page.url));
      const failed = [
        ...new Set([...list(reply.errors).flatMap((error) => str(error.url) ?? []), ...input.urls.filter((url) => !read.has(url))]),
      ].filter((url) => !read.has(url));
      return { pages, failed };
    });
  }

  async search(input: { objective: string; queries: string[]; mode?: SearchMode; batchId?: string } & SearchFilters): Promise<SearchResult[]> {
    const mode = input.mode ?? "fast";
    const policy = {
      ...(input.includeDomains?.length ? { include_domains: input.includeDomains } : {}),
      ...(input.excludeDomains?.length ? { exclude_domains: input.excludeDomains } : {}),
      ...(input.afterDate ? { after_date: input.afterDate } : {}),
    };
    const settings = { ...(input.maxResults ? { max_results: input.maxResults } : {}), ...(Object.keys(policy).length > 0 ? { source_policy: policy } : {}) };
    const usd = PRICES.search[mode] + PRICES.searchExtraResult * Math.max(0, (input.maxResults ?? 10) - 10);
    return this.paid("search", input.objective, usd, input.batchId, async () => {
      const reply = await this.send("search", "POST", "/v1/search", {
        objective: input.objective,
        search_queries: input.queries,
        mode,
        ...(Object.keys(settings).length > 0 ? { advanced_settings: settings } : {}),
      });
      return list(reply.results).flatMap((result): SearchResult[] => {
        const url = str(result.url);
        const excerpts = Array.isArray(result.excerpts) ? result.excerpts.filter((x): x is string => typeof x === "string") : [];
        return url ? [{ url, title: str(result.title), excerpts }] : [];
      });
    });
  }

  async images(input: { objective: string; queries: string[]; mode?: SearchMode; batchId?: string }): Promise<ImageResult[]> {
    const mode = input.mode ?? "fast";
    return this.paid("images", input.objective, PRICES.images[mode], input.batchId, async () => {
      const reply = await this.send("images", "POST", "/v1/images/search", {
        objective: input.objective,
        search_queries: input.queries,
        mode,
      });
      return list(reply.results).flatMap((result): ImageResult[] => {
        const imageUrl = str(result.image_url);
        return imageUrl
          ? [{ imageUrl, pageUrl: str(result.url) ?? str(result.source_url), title: str(result.title), width: num(result.width), height: num(result.height) }]
          : [];
      });
    });
  }

  /** Starts a research run. Parallel charges one run; reading its result later is free. */
  async taskStart(input: { question: string; processor: TaskProcessor; fields?: TaskField[]; batchId?: string }): Promise<TaskRun> {
    // With fields, the answer comes as one named value for each field, each with its own sources.
    const schema = input.fields?.length
      ? {
          type: "json",
          json_schema: {
            type: "object",
            properties: Object.fromEntries(input.fields.map((field) => [field.name, { type: "string", description: field.description }])),
            required: input.fields.map((field) => field.name),
            additionalProperties: false,
          },
        }
      : { type: "text" };
    return this.paid("task", input.question, PRICES.task[input.processor], input.batchId, async () => {
      const reply = await this.send("task", "POST", "/v1/tasks/runs", {
        input: input.question,
        processor: input.processor,
        task_spec: { output_schema: schema },
      });
      const runId = str(reply.run_id);
      if (!runId) throw new ProviderError("Parallel started no research run. It stays counted in the ledger.");
      return { runId, status: str(reply.status) ?? "queued" };
    });
  }

  /** The state of a research run and, when it is complete, its answer with the pages it cites. */
  async taskGet(runId: string): Promise<TaskRun> {
    const id = encodeURIComponent(runId);
    const run = await this.send("task status", "GET", `/v1/tasks/runs/${id}`);
    const status = str(run.status) ?? "unknown";
    if (status !== "completed") return { runId, status };
    const reply = await this.send("task result", "GET", `/v1/tasks/runs/${id}/result`);
    const output = (reply.output ?? {}) as Record<string, unknown>;
    return { runId, status, output: output.content, basis: output.basis };
  }

  /** Answers typed questions from current web pages: a yes or no as a probability, a choice or a score. */
  async decide(input: { state: Record<string, unknown>; questions: DecisionQuestion[]; batchId?: string }): Promise<Decisions> {
    return this.paid("decisions", input.questions[0]?.instructions ?? "", PRICES.decisions, input.batchId, async () => {
      const reply = await this.send("decisions", "POST", "/v1/decisions", {
        state: input.state,
        questions: Object.fromEntries(
          input.questions.map((question) => [question.name, { type: question.type, instructions: question.instructions, ...(question.criteria ? { criteria: question.criteria } : {}) }]),
        ),
      });
      const citations = list(reply.citations).flatMap((citation) => {
        const url = str(citation.url);
        return url ? [{ url, title: str(citation.title), excerpts: strings(citation.excerpts) }] : [];
      });
      return { answers: record(reply.answers), citations };
    });
  }

  /** Products a shopper can buy, each at one store, with its price in the market's currency. */
  async shopping(input: {
    queries: string[];
    objective?: string;
    market: ShopMarket;
    minPrice?: number;
    maxPrice?: number;
    condition?: "new" | "used" | "refurbished" | "any";
    maxResults?: number;
    batchId?: string;
  }): Promise<ShopResult[]> {
    return this.paid("shopping", input.queries[0] ?? "", PRICES.shopping, input.batchId, async () => {
      const reply = await this.send("shopping", "POST", "/v1/shopping/search", {
        search_queries: input.queries,
        ...(input.objective ? { objective: input.objective } : {}),
        ...(input.minPrice === undefined ? {} : { min_price: input.minPrice }),
        ...(input.maxPrice === undefined ? {} : { max_price: input.maxPrice }),
        ...(input.condition ? { condition: input.condition } : {}),
        advanced_settings: { location: input.market, ...(input.maxResults ? { max_results: input.maxResults } : {}) },
      });
      return list(reply.results).flatMap((result): ShopResult[] => {
        const url = str(result.url);
        if (!url) return [];
        return [
          {
            url,
            title: str(result.title),
            merchant: str(result.merchant),
            brand: str(result.brand),
            description: str(result.description),
            price: numeric(result.price),
            currency: str(result.currency),
            originalPrice: numeric(result.original_price),
            rating: numeric(result.rating),
            reviewCount: numeric(result.review_count),
            imageUrl: str(result.image_url),
            condition: str(result.condition),
            availability: str(result.availability),
          },
        ];
      });
    });
  }

  /** Places such as a brand's outlets, near one location. */
  async places(input: { query: string; location: string; mode?: keyof typeof PRICES.places; maxResults?: number; openNow?: boolean; batchId?: string }): Promise<PlaceResult[]> {
    const mode = input.mode ?? "fast";
    return this.paid("places", input.query, PRICES.places[mode], input.batchId, async () => {
      const reply = await this.send("places", "POST", "/v1/places/search", {
        query: input.query,
        location: input.location,
        mode,
        ...(input.openNow ? { open_now: true } : {}),
        ...(input.maxResults ? { advanced_settings: { max_results: input.maxResults } } : {}),
      });
      return list(reply.results).flatMap((result): PlaceResult[] => {
        const name = str(result.name);
        if (!name) return [];
        return [
          {
            name,
            url: str(result.url),
            address: str(result.address),
            phone: str(result.phone),
            latitude: num(result.latitude),
            longitude: num(result.longitude),
            rating: str(result.rating) ?? (num(result.rating)?.toString() ?? null),
            description: str(result.description),
            openNow: typeof result.open_now === "boolean" ? result.open_now : null,
          },
        ];
      });
    });
  }

  /** A ranked list of companies or people for an objective. Ranked, not checked: each one is a lead. */
  async entitySearch(input: { entityType: EntityType; objective: string; limit: number; batchId?: string }): Promise<Entity[]> {
    return this.paid("entity search", input.objective, PRICES.entitySearch, input.batchId, async () => {
      const reply = await this.send("entity search", "POST", "/v1beta/findall/entity-search", {
        entity_type: input.entityType,
        objective: input.objective,
        match_limit: input.limit,
      });
      return list(reply.entities).flatMap((entity): Entity[] => {
        const name = str(entity.name);
        return name ? [{ name, url: str(entity.url), description: str(entity.description) }] : [];
      });
    });
  }

  /** Turns an objective into the conditions of a FindAll run. Parallel lists no price for this step. */
  async findAllPlan(objective: string): Promise<FindAllPlan> {
    const reply = await this.send("FindAll plan", "POST", "/v1beta/findall/ingest", { objective });
    const conditions = list(reply.match_conditions).flatMap((condition) => {
      const name = str(condition.name);
      const description = str(condition.description);
      return name && description ? [{ name, description }] : [];
    });
    return { objective: str(reply.objective) ?? objective, entityType: str(reply.entity_type) ?? "companies", conditions, generator: str(reply.generator) };
  }

  /**
   * Starts a FindAll run. The ledger holds the run's price and the price of every match it may find,
   * because Parallel charges each match as it finds it and the studio sends no call at that time.
   */
  async findAllStart(input: {
    objective: string;
    entityType: string;
    conditions: { name: string; description: string }[];
    generator: FindAllGenerator;
    matchLimit: number;
    batchId?: string;
  }): Promise<FindAllRun> {
    return this.paid("findall", input.objective, findAllUsd(input.generator, input.matchLimit), input.batchId, async () => {
      const reply = await this.send("FindAll", "POST", "/v1beta/findall/runs", {
        objective: input.objective,
        entity_type: input.entityType,
        match_conditions: input.conditions,
        generator: input.generator,
        match_limit: input.matchLimit,
      });
      const run = this.findAllRun(reply);
      if (!run) throw new ProviderError("Parallel started no FindAll run. It stays counted in the ledger.");
      return run;
    });
  }

  private findAllRun(reply: Record<string, unknown>): FindAllRun | undefined {
    const findAllId = str(reply.findall_id);
    if (!findAllId) return undefined;
    const status = record(reply.status);
    const metrics = record(status.metrics);
    const ended = str(status.termination_reason);
    return {
      findAllId,
      status: str(status.status) ?? "unknown",
      active: status.is_active === true,
      generated: num(metrics.generated_candidates_count) ?? 0,
      matched: num(metrics.matched_candidates_count) ?? 0,
      ...(ended ? { ended } : {}),
    };
  }

  /** The state of a FindAll run with its candidates as they stand. `matchedOnly` leaves out the ones that did not match. */
  async findAllGet(findAllId: string, matchedOnly = true): Promise<FindAllRun> {
    const reply = await this.send("FindAll result", "GET", `/v1beta/findall/runs/${encodeURIComponent(findAllId)}/result`);
    const run = this.findAllRun(record(reply.run)) ?? { findAllId, status: "unknown", active: false, generated: 0, matched: 0 };
    const candidates = list(reply.candidates).flatMap((candidate) => {
      const name = str(candidate.name);
      const match = str(candidate.match_status) ?? "generated";
      if (!name || (matchedOnly && match !== "matched")) return [];
      return [{ name, url: str(candidate.url), description: str(candidate.description), match, output: candidate.output ?? null, basis: candidate.basis ?? null }];
    });
    return { ...run, candidates };
  }

  async findAllCancel(findAllId: string): Promise<void> {
    await this.send("FindAll cancel", "POST", `/v1beta/findall/runs/${encodeURIComponent(findAllId)}/cancel`, {});
  }

  /**
   * Starts a monitor that Parallel runs on its own schedule. The ledger holds every execution of its
   * life at the start, because the studio sends no call when one runs. No webhook: its events are read.
   */
  async monitorStart(input: { query: string; frequency: MonitorFrequency; processor: MonitorProcessor; days: number; watchId?: string }): Promise<Monitor> {
    const usd = Math.round(PRICES.monitor[input.processor] * monitorExecutions(input.frequency, input.days) * 1e6) / 1e6;
    return this.paid("monitor", input.query, usd, undefined, async () => {
      const reply = await this.send("monitor", "POST", "/v1/monitors", {
        type: "event_stream",
        frequency: input.frequency,
        processor: input.processor,
        settings: { query: input.query },
        // The studio's own name for the watch. With it the daily job finds a watch whose start had no answer.
        ...(input.watchId ? { metadata: { [WATCH_KEY]: input.watchId } } : {}),
      });
      const monitorId = str(reply.monitor_id);
      if (!monitorId) throw new ProviderError("Parallel started no monitor. It stays counted in the ledger.");
      return { monitorId, status: str(reply.status) ?? "active" };
    });
  }

  /** The monitors that run at Parallel under the studio's key, each with the studio's name for it when it has one. Free. */
  async monitorList(): Promise<{ monitorId: string; watchId?: string }[]> {
    const found: { monitorId: string; watchId?: string }[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const reply = await this.send("monitor list", "GET", `/v1/monitors?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      for (const monitor of list(reply.monitors)) {
        const monitorId = str(monitor.monitor_id);
        const watchId = str(record(monitor.metadata)[WATCH_KEY]);
        if (monitorId) found.push({ monitorId, ...(watchId ? { watchId } : {}) });
      }
      cursor = str(reply.next_cursor) ?? undefined;
      if (!cursor) break;
    }
    return found;
  }

  /** What a monitor found, newest first: each event with its text and the pages behind it. `next` reads the older ones. */
  async monitorEvents(monitorId: string, limit: number, cursor?: string): Promise<{ events: { id: string; date: string | null; content: unknown; basis: unknown }[]; next?: string }> {
    const reply = await this.send("monitor events", "GET", `/v1/monitors/${encodeURIComponent(monitorId)}/events?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    const events = list(reply.events).flatMap((event) => {
      const id = str(event.event_id);
      const output = record(event.output);
      return id ? [{ id, date: str(event.event_date), content: output.content ?? null, basis: output.basis ?? null }] : [];
    });
    const next = str(reply.next_cursor);
    return { events, ...(next ? { next } : {}) };
  }

  async monitorCancel(monitorId: string): Promise<void> {
    await this.send("monitor cancel", "POST", `/v1/monitors/${encodeURIComponent(monitorId)}/cancel`, {});
  }
}
