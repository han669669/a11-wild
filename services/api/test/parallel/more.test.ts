import { beforeEach, describe, expect, it } from "vitest";
import { findAllUsd, monitorExecutions, ParallelClient } from "../../src/parallel/client.js";
import { Watches, WATCHES_MAX } from "../../src/parallel/watches.js";
import { GateError, SpendGate } from "../../src/spend/gate.js";
import { NotBilledError, SpendLedger } from "../../src/spend/ledger.js";
import { MemoryTable } from "../helpers/memory-table.js";
import { fakeParallel, TEST_KEY, testKeys, type ParallelCall } from "../helpers/parallel.js";

let table: MemoryTable;
let ledger: SpendLedger;
let clock: Date;
const now = () => clock;
beforeEach(() => {
  table = new MemoryTable();
  clock = new Date("2026-11-24T03:00:00Z");
  ledger = new SpendLedger(table, now);
});
const client = (answer: (call: ParallelCall) => { status?: number; json?: unknown } | Error) => {
  const parallel = fakeParallel(answer);
  return { parallel, client: new ParallelClient(testKeys, ledger, parallel.fetchFn, new SpendGate(table, now)) };
};
const spent = async () => (await ledger.summary()).monthUsd;

describe("Parallel client: the newer calls", () => {
  it("sends a search's filters and adds the price of each result over ten", async () => {
    const { parallel, client: c } = client(() => ({ json: { results: [] } }));
    await c.search({ objective: "kaya", queries: ["kaya"], maxResults: 15, afterDate: "2026-01-01", includeDomains: ["brand.example"] });
    expect(parallel.calls[0]?.body).toMatchObject({ mode: "fast", advanced_settings: { max_results: 15, source_policy: { include_domains: ["brand.example"], after_date: "2026-01-01" } } });
    expect(await spent()).toBe(0.006);
    await c.search({ objective: "kaya", queries: ["kaya"] });
    expect(parallel.calls[1]?.body).not.toHaveProperty("advanced_settings");
  });

  it("asks a research run for named fields as a closed object of strings", async () => {
    const { parallel, client: c } = client(() => ({ json: { run_id: "run_1", status: "queued" } }));
    await c.taskStart({ question: "How tall is the pack?", processor: "pro", fields: [{ name: "height_mm", description: "The height in mm." }] });
    expect(parallel.calls[0]?.body).toMatchObject({
      processor: "pro",
      task_spec: { output_schema: { type: "json", json_schema: { type: "object", properties: { height_mm: { type: "string" } }, required: ["height_mm"], additionalProperties: false } } },
    });
    expect(await spent()).toBe(0.1);
  });

  it("sends decisions by the question's name and returns the answers with their pages", async () => {
    const { parallel, client: c } = client(() => ({ json: { answers: { halal: { type: "noul", noul: 0.9 } }, citations: [{ url: "https://brand.example/", excerpts: ["Halal certified."] }, { title: "no address" }] } }));
    const result = await c.decide({ state: { brand: "Brand" }, questions: [{ name: "halal", type: "noul", instructions: "Is the brand halal certified?" }] });
    expect(parallel.calls[0]).toMatchObject({ url: "https://api.parallel.ai/v1/decisions", key: TEST_KEY, body: { state: { brand: "Brand" }, questions: { halal: { type: "noul" } } } });
    expect(result).toEqual({ answers: { halal: { type: "noul", noul: 0.9 } }, citations: [{ url: "https://brand.example/", title: null, excerpts: ["Halal certified."] }] });
    expect(await spent()).toBe(0.001);
  });

  it("reads shopping, places and entities, and leaves out a result with no address or name", async () => {
    const { parallel, client: c } = client((call) =>
      call.url.endsWith("/v1/shopping/search")
        ? { json: { results: [{ url: "https://shop.example/p", title: "Kaya 250 g", merchant: "Shop", price: 6.5, currency: "SGD", image_url: "https://shop.example/p.jpg" }, { title: "no address" }] } }
        : call.url.endsWith("/v1/places/search")
          ? { json: { results: [{ name: "Brand Outlet", address: "1 Test Road", phone: "+65 6000 0000", rating: "4.5" }, { address: "no name" }] } }
          : { json: { entities: [{ name: "Brand Pte Ltd", url: "https://brand.example", description: "Kaya maker" }, { url: "https://x.example" }] } },
    );
    const shop = await c.shopping({ queries: ["kaya"], market: "sg", maxPrice: 10, maxResults: 5 });
    expect(shop).toMatchObject([{ url: "https://shop.example/p", merchant: "Shop", price: 6.5, currency: "SGD", imageUrl: "https://shop.example/p.jpg", brand: null }]);
    expect(parallel.calls[0]?.body).toEqual({ search_queries: ["kaya"], max_price: 10, advanced_settings: { location: "sg", max_results: 5 } });
    const places = await c.places({ query: "Brand", location: "Singapore" });
    expect(places).toMatchObject([{ name: "Brand Outlet", address: "1 Test Road", rating: "4.5", url: null }]);
    expect(parallel.calls[1]?.body).toEqual({ query: "Brand", location: "Singapore", mode: "fast" });
    const entities = await c.entitySearch({ entityType: "companies", objective: "Kaya makers in Singapore", limit: 20 });
    expect(entities).toEqual([{ name: "Brand Pte Ltd", url: "https://brand.example", description: "Kaya maker" }]);
    expect(parallel.calls[2]).toMatchObject({ url: "https://api.parallel.ai/v1beta/findall/entity-search", body: { entity_type: "companies", match_limit: 20 } });
    expect(await spent()).toBe(0.011);
  });

  it("holds a FindAll run with every match it may find, and reads its matches", async () => {
    const run = { findall_id: "findall_1", status: { status: "completed", is_active: false, metrics: { generated_candidates_count: 8, matched_candidates_count: 1 }, termination_reason: "candidates_exhausted" } };
    const { parallel, client: c } = client((call) =>
      call.method === "GET"
        ? { json: { run, candidates: [{ name: "A", url: "https://a.example", match_status: "matched", output: { sells_kaya: { is_matched: true } }, basis: [] }, { name: "B", match_status: "unmatched" }] } }
        : { json: run },
    );
    expect(findAllUsd("base", 20)).toBe(0.85);
    const started = await c.findAllStart({ objective: "Kaya makers", entityType: "companies", conditions: [{ name: "sells_kaya", description: "Sells kaya." }], generator: "base", matchLimit: 20 });
    expect(started).toMatchObject({ findAllId: "findall_1", status: "completed", active: false, matched: 1, ended: "candidates_exhausted" });
    expect(parallel.calls[0]?.body).toMatchObject({ entity_type: "companies", generator: "base", match_limit: 20, match_conditions: [{ name: "sells_kaya" }] });
    expect(await spent()).toBe(0.85);
    expect((await c.findAllGet("findall_1")).candidates?.map((candidate) => candidate.name)).toEqual(["A"]);
    expect((await c.findAllGet("findall_1", false)).candidates?.map((candidate) => candidate.name)).toEqual(["A", "B"]);
    expect(parallel.calls[1]?.url).toBe("https://api.parallel.ai/v1beta/findall/runs/findall_1/result");
    expect(await spent()).toBe(0.85);
  });

  it("stops a FindAll run of US$1 or more for the owner's yes, before anything is sent", async () => {
    const { parallel, client: c } = client(() => ({ json: {} }));
    const error = await c.findAllStart({ objective: "Kaya makers", entityType: "companies", conditions: [{ name: "a", description: "Sells kaya." }], generator: "core", matchLimit: 5 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GateError);
    expect(parallel.calls).toEqual([]);
    expect(await spent()).toBe(0);
  });

  it("releases the hold when Parallel refuses a newer call, and never repeats the key", async () => {
    const { client: c } = client(() => ({ status: 422, text: `bad ${TEST_KEY}` }) as never);
    const error = await c.decide({ state: {}, questions: [{ name: "a", type: "noul", instructions: "Is it so?" }] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotBilledError);
    expect((error as Error).message).toBe("Parallel refused the decisions request (status 422). Nothing was charged.");
    expect(await spent()).toBe(0);
  });
});

describe("watches", () => {
  const monitors = () => {
    let n = 0;
    return client((call) => (call.url.endsWith("/v1/monitors") ? { json: { monitor_id: `monitor_${++n}`, status: "active" } } : call.url.includes("/events") ? { json: { events: [{ event_id: "e1", event_date: "2026-11-25", output: { content: "A launch.", basis: [] } }, { event_type: "completion" }] } } : { json: {} }));
  };

  it("counts every run of a watch's life, with one day more for the daily job", () => {
    expect(monitorExecutions("1d", 30)).toBe(32);
    expect(monitorExecutions("7d", 7)).toBe(3);
    expect(monitorExecutions("1h", 1)).toBe(49);
  });

  it("holds the whole life at the start, sends no webhook, and keeps the watch with its end", async () => {
    const { parallel, client: c } = monitors();
    const watches = new Watches(table, c, now);
    const watch = await watches.start({ query: "Brand launches a new product", frequency: "1d", processor: "lite", days: 30, by: "owner@example.com" });
    expect(parallel.calls[0]?.body).toEqual({ type: "event_stream", frequency: "1d", processor: "lite", settings: { query: "Brand launches a new product" } });
    expect(watch).toMatchObject({ monitorId: "monitor_1", status: "active", endsAt: "2026-12-24T03:00:00.000Z" });
    expect(await spent()).toBe(0.096);
    expect(await watches.events("monitor_1", 10)).toEqual([{ id: "e1", date: "2026-11-25", content: "A launch.", basis: [] }]);
    await expect(watches.events("monitor_other", 10)).rejects.toThrow(/started no watch/);
    expect(parallel.calls).toHaveLength(2);
  });

  it("refuses one more watch than the limit, before anything is sent or held", async () => {
    const { parallel, client: c } = monitors();
    const watches = new Watches(table, c, now);
    for (let i = 0; i < WATCHES_MAX; i += 1) await watches.start({ query: "Brand launches a new product", frequency: "7d", processor: "lite", days: 7, by: "owner@example.com" });
    const before = await spent();
    await expect(watches.start({ query: "One more", frequency: "7d", processor: "lite", days: 7, by: "owner@example.com" })).rejects.toThrow(/watch_stop/);
    expect(parallel.calls).toHaveLength(WATCHES_MAX);
    expect(await spent()).toBe(before);
  });

  it("cancels a watch at Parallel when its life is over, and leaves a younger one", async () => {
    const { parallel, client: c } = monitors();
    const watches = new Watches(table, c, now);
    await watches.start({ query: "Brand launches a new product", frequency: "1d", processor: "lite", days: 2, by: "owner@example.com" });
    await watches.start({ query: "Brand opens a new outlet", frequency: "1d", processor: "lite", days: 10, by: "owner@example.com" });
    clock = new Date("2026-11-25T03:00:00Z");
    expect(await watches.stopExpired()).toEqual([]);
    clock = new Date("2026-11-27T03:00:00Z");
    expect(await watches.stopExpired()).toEqual(["monitor_1"]);
    expect(parallel.calls.at(-1)).toMatchObject({ url: "https://api.parallel.ai/v1/monitors/monitor_1/cancel", method: "POST" });
    expect((await watches.list()).map((watch) => [watch.monitorId, watch.status]).sort()).toEqual([["monitor_1", "stopped"], ["monitor_2", "active"]]);
    expect(await watches.stopExpired()).toEqual([]);
  });

  it("keeps a watch active when Parallel does not take the cancel, for the next run", async () => {
    let fail = false;
    const parallel = fakeParallel((call) => (call.url.endsWith("/cancel") && fail ? { status: 500 } : { json: { monitor_id: "monitor_1" } }));
    const watches = new Watches(table, new ParallelClient(testKeys, ledger, parallel.fetchFn), now);
    await watches.start({ query: "Brand launches a new product", frequency: "1d", processor: "lite", days: 1, by: "owner@example.com" });
    clock = new Date("2026-11-26T03:00:00Z");
    fail = true;
    expect(await watches.stopExpired()).toEqual([]);
    expect((await watches.list())[0]?.status).toBe("active");
    fail = false;
    expect(await watches.stopExpired()).toEqual(["monitor_1"]);
  });
});
