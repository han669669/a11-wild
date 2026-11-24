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

  it("takes a cancel's empty answer (status 204) as a yes", async () => {
    const parallel = fakeParallel(() => ({ status: 204, text: "" }));
    const c = new ParallelClient(testKeys, ledger, parallel.fetchFn);
    await expect(c.findAllCancel("findall_1")).resolves.toBeUndefined();
    await expect(c.monitorCancel("monitor_1")).resolves.toBeUndefined();
    expect(parallel.calls.map((call) => call.url)).toEqual(["https://api.parallel.ai/v1beta/findall/runs/findall_1/cancel", "https://api.parallel.ai/v1/monitors/monitor_1/cancel"]);
  });

  it("does not read an answer with no body as an empty result: the charge stays counted", async () => {
    const parallel = fakeParallel(() => ({ status: 200, text: "" }));
    const c = new ParallelClient(testKeys, ledger, parallel.fetchFn);
    await expect(c.shopping({ queries: ["kaya jar"], market: "sg", maxResults: 5 })).rejects.toThrow(/could not be read/);
    expect(await spent()).toBeGreaterThan(0);
  });

  it("starts a FindAll run of US$10 or less with no yes from the owner, and other research still waits at its own US$1", async () => {
    const reply = { findall_id: "findall_1", status: { status: "queued", is_active: true, metrics: {} }, run_id: "run_1" };
    const { parallel, client: c } = client(() => ({ json: reply }));
    await c.findAllStart({ objective: "Kaya makers", entityType: "companies", conditions: [{ name: "a", description: "Sells kaya." }], generator: "core", matchLimit: 10 });
    expect(await spent()).toBe(findAllUsd("core", 10));
    // The run is not in the total that the US$1 gate reads: nine research runs of US$0.10 go on, and the tenth waits.
    for (let n = 0; n < 9; n += 1) await c.taskStart({ question: "How tall is the pack?", processor: "pro" });
    const error = await c.taskStart({ question: "How tall is the pack?", processor: "pro" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GateError);
    expect(parallel.calls).toHaveLength(10);
  });

  it("still stops a FindAll run at the month's cap and at a batch's cap", async () => {
    const { parallel, client: c } = client(() => ({ json: { findall_id: "findall_1", status: { status: "queued", is_active: true, metrics: {} } } }));
    const start = (batchId?: string) =>
      c.findAllStart({ objective: "Kaya makers", entityType: "companies", conditions: [{ name: "a", description: "Sells kaya." }], generator: "core", matchLimit: 50, ...(batchId ? { batchId } : {}) });
    await expect(start("batch-1")).rejects.toThrow(/batch's spend cap/);
    await start();
    await start();
    await expect(start()).rejects.toThrow(/month's spend cap/);
    expect(parallel.calls).toHaveLength(2);
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
  /** A stand-in that keeps the monitors it made, with the studio's name for each, as Parallel does. */
  const monitors = (lose: { reply?: boolean } = {}) => {
    let n = 0;
    const made: { monitor_id: string; status: string; metadata: unknown }[] = [];
    const answer = (call: ParallelCall) => {
      if (call.method === "POST" && call.url.endsWith("/v1/monitors")) {
        made.push({ monitor_id: `monitor_${++n}`, status: "active", metadata: call.body?.metadata });
        return lose.reply ? new Error("The connection was cut.") : { json: made.at(-1) };
      }
      if (call.url.includes("/v1/monitors?")) return { json: { monitors: made.filter((monitor) => monitor.status === "active") } };
      if (call.url.includes("/events")) return { json: { events: [{ event_id: "e1", event_date: "2026-11-25", output: { content: "A launch.", basis: [] } }, { event_type: "completion" }], ...(call.url.includes("cursor=") ? {} : { next_cursor: "older 1" }) } };
      const cancelled = made.find((monitor) => call.url.endsWith(`/${monitor.monitor_id}/cancel`));
      if (cancelled) cancelled.status = "cancelled";
      return { status: 204 };
    };
    return { ...client(answer), made, lose };
  };
  const WATCH = { query: "Brand launches a new product", frequency: "1d", processor: "lite", days: 2, by: "owner@example.com" } as const;

  it("counts every run of a watch's life, with one day more for the daily job", () => {
    expect(monitorExecutions("1d", 30)).toBe(32);
    expect(monitorExecutions("7d", 7)).toBe(3);
    expect(monitorExecutions("1h", 1)).toBe(49);
  });

  it("holds the whole life at the start, sends no webhook, and keeps the watch with its end", async () => {
    const { parallel, client: c } = monitors();
    const watches = new Watches(table, c, now);
    const watch = await watches.start({ query: "Brand launches a new product", frequency: "1d", processor: "lite", days: 30, by: "owner@example.com" });
    expect(parallel.calls[0]?.body).toEqual({ type: "event_stream", frequency: "1d", processor: "lite", settings: { query: "Brand launches a new product" }, metadata: { studio_watch: expect.stringMatching(/^[0-9a-f]{24}$/) } });
    expect(watch).toMatchObject({ monitorId: "monitor_1", status: "active", endsAt: "2026-12-24T03:00:00.000Z" });
    expect(await spent()).toBe(0.096);
    const event = { id: "e1", date: "2026-11-25", content: "A launch.", basis: [] };
    expect(await watches.events("monitor_1", 10)).toEqual({ events: [event], next: "older 1" });
    // The older events are read with the answer's next, and the last page has none.
    expect(await watches.events("monitor_1", 10, "older 1")).toEqual({ events: [event] });
    expect(parallel.calls.at(-1)?.url).toBe("https://api.parallel.ai/v1/monitors/monitor_1/events?limit=10&cursor=older%201");
    await expect(watches.events("monitor_other", 10)).rejects.toThrow(/started no watch/);
    expect(parallel.calls).toHaveLength(3);
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

  it("gives the last place to one of two starts at the same moment", async () => {
    const { parallel, client: c, made } = monitors();
    const watches = new Watches(table, c, now);
    for (let i = 0; i < WATCHES_MAX - 1; i += 1) await watches.start(WATCH);
    const both = await Promise.allSettled([watches.start(WATCH), watches.start(WATCH)]);
    expect(both.map((one) => one.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(made).toHaveLength(WATCHES_MAX);
    expect(parallel.calls.filter((call) => call.method === "POST")).toHaveLength(WATCHES_MAX);
    // A stopped watch gives its place back.
    await watches.stop("monitor_1");
    await expect(watches.start(WATCH)).resolves.toMatchObject({ status: "active" });
  });

  it("gives the place back when Parallel refuses the start, and nothing is charged", async () => {
    const parallel = fakeParallel(() => ({ status: 422 }));
    const watches = new Watches(table, new ParallelClient(testKeys, ledger, parallel.fetchFn), now);
    await expect(watches.start(WATCH)).rejects.toBeInstanceOf(NotBilledError);
    expect(await watches.list()).toEqual([]);
    expect(await spent()).toBe(0);
  });

  it("still ends a watch whose start had no answer: the daily job finds it at Parallel by the studio's name", async () => {
    const { client: c, made, lose } = monitors({ reply: true });
    const watches = new Watches(table, c, now);
    await expect(watches.start(WATCH)).rejects.toThrow(/not known/);
    // Parallel runs it. The studio keeps it with its end, and with no id of Parallel yet.
    expect(made).toHaveLength(1);
    expect(await watches.list()).toEqual([expect.objectContaining({ status: "starting", endsAt: "2026-11-26T03:00:00.000Z" })]);
    expect((await watches.list())[0]).not.toHaveProperty("monitorId");
    lose.reply = false;
    clock = new Date("2026-11-25T03:00:00Z");
    expect(await watches.stopExpired()).toEqual([]);
    expect(await watches.list()).toEqual([expect.objectContaining({ monitorId: "monitor_1", status: "active", endsAt: "2026-11-26T03:00:00.000Z" })]);
    clock = new Date("2026-11-26T04:00:00Z");
    expect(await watches.stopExpired()).toEqual(["monitor_1"]);
    expect(made[0]?.status).toBe("cancelled");
  });

  it("still ends a watch whose record could not be written after Parallel took it", async () => {
    const { client: c, made } = monitors();
    const watches = new Watches(table, c, now);
    const put = table.put.bind(table);
    let puts = 0;
    table.put = async (item, options) => {
      if (item.pk === "WATCH" && ++puts === 2) throw new Error("The table did not answer.");
      return put(item, options);
    };
    await expect(watches.start(WATCH)).rejects.toThrow(/did not answer/);
    table.put = put;
    expect(made).toHaveLength(1);
    expect((await watches.list())[0]?.status).toBe("starting");
    clock = new Date("2026-11-26T04:00:00Z");
    expect(await watches.stopExpired()).toEqual(["monitor_1"]);
    expect(made[0]?.status).toBe("cancelled");
  });

  it("drops a start that Parallel never shows after two days, and cancels a monitor of the studio that it does not keep", async () => {
    const parallel = fakeParallel((call) => (call.method === "POST" && call.url.endsWith("/v1/monitors") ? new Error("The connection was cut.") : { json: { monitors: [] } }));
    const watches = new Watches(table, new ParallelClient(testKeys, ledger, parallel.fetchFn), now);
    await expect(watches.start(WATCH)).rejects.toThrow(/not known/);
    clock = new Date("2026-11-25T03:00:00Z");
    await watches.stopExpired();
    expect(await watches.list()).toHaveLength(1);
    clock = new Date("2026-11-26T04:00:00Z");
    await watches.stopExpired();
    expect(await watches.list()).toEqual([]);

    const { parallel: other, client: c, made } = monitors();
    const kept = new Watches(table, c, now);
    await kept.start(WATCH);
    made.push({ monitor_id: "monitor_lost", status: "active", metadata: { studio_watch: "0123456789abcdef01234567" } }, { monitor_id: "monitor_elsewhere", status: "active", metadata: null });
    expect(await kept.stopExpired()).toEqual([]);
    // The studio's own lost monitor is cancelled. One made elsewhere under the same key is not touched.
    expect(made.map((monitor) => [monitor.monitor_id, monitor.status])).toEqual([["monitor_1", "active"], ["monitor_lost", "cancelled"], ["monitor_elsewhere", "active"]]);
    expect(other.calls.filter((call) => call.url.endsWith("/cancel")).map((call) => call.url)).toEqual(["https://api.parallel.ai/v1/monitors/monitor_lost/cancel"]);
  });

  /** A second client on the same stand-in that does something first, one time, right before the request that `when` picks. */
  const paused = (fetchFn: typeof fetch, when: (url: string) => boolean) => {
    const hold: { first?: () => Promise<unknown> } = {};
    const slow = (async (input: string | URL | Request, init?: RequestInit) => {
      const first = when(String(input)) ? hold.first : undefined;
      if (first) {
        delete hold.first;
        await first();
      }
      return fetchFn(input, init);
    }) as typeof fetch;
    return { hold, client: new ParallelClient(testKeys, ledger, slow) };
  };

  it("leaves a new watch in its place when a slower stop of the watch before it ends", async () => {
    const { parallel, client: c, made } = monitors();
    const owner = new Watches(table, c, now);
    await owner.start(WATCH);
    const slow = paused(parallel.fetchFn, (url) => url.endsWith("/cancel"));
    // The daily job has read the watch and asks Parallel to cancel it. Before the answer, the owner stops it and starts another, which takes its place.
    slow.hold.first = async () => {
      await owner.stop("monitor_1");
      await owner.start({ ...WATCH, query: "A second watch" });
    };
    await new Watches(table, slow.client, now).stop("monitor_1");
    expect(await owner.list()).toEqual([expect.objectContaining({ monitorId: "monitor_2", query: "A second watch", status: "active" }), expect.objectContaining({ monitorId: "monitor_1", status: "stopped" })]);
    expect(made.map((monitor) => monitor.status)).toEqual(["cancelled", "active"]);
    // The second watch still ends.
    clock = new Date("2026-11-26T04:00:00Z");
    expect(await owner.stopExpired()).toEqual(["monitor_2"]);
  });

  it("does not cancel a watch that starts while the daily job reads Parallel's list", async () => {
    const { parallel, client: c, made } = monitors();
    const owner = new Watches(table, c, now);
    await owner.start(WATCH);
    const slow = paused(parallel.fetchFn, (url) => url.includes("/v1/monitors?"));
    slow.hold.first = () => owner.start({ ...WATCH, query: "A second watch" });
    expect(await new Watches(table, slow.client, now).stopExpired()).toEqual([]);
    expect(made.map((monitor) => monitor.status)).toEqual(["active", "active"]);
    expect((await owner.list()).map((watch) => watch.status)).toEqual(["active", "active"]);
    expect(parallel.calls.filter((call) => call.url.endsWith("/cancel"))).toEqual([]);
  });

  it("cancels a monitor that carries the studio's name when the studio keeps no watch at all", async () => {
    const { client: c, made } = monitors();
    made.push({ monitor_id: "monitor_lost", status: "active", metadata: { studio_watch: "0123456789abcdef01234567" } }, { monitor_id: "monitor_elsewhere", status: "active", metadata: null });
    expect(await new Watches(table, c, now).stopExpired()).toEqual([]);
    expect(made.map((monitor) => [monitor.monitor_id, monitor.status])).toEqual([["monitor_lost", "cancelled"], ["monitor_elsewhere", "active"]]);
  });

  it("leaves a new watch in its place when the answer to an older start comes late, and ends the older one", async () => {
    const { parallel, client: c, made } = monitors();
    const owner = new Watches(table, c, now);
    const slow = paused(parallel.fetchFn, (url) => url.endsWith("/v1/monitors"));
    // The slow start holds the first place. Before Parallel answers it, that place is freed and a second watch takes it.
    slow.hold.first = async () => {
      await table.delete("WATCH", "PLACE#1");
      await owner.start({ ...WATCH, query: "A second watch" });
    };
    await expect(new Watches(table, slow.client, now).start(WATCH)).rejects.toThrow(/Start it again/);
    expect(await owner.list()).toEqual([expect.objectContaining({ monitorId: "monitor_1", query: "A second watch", status: "active" })]);
    expect(made.map((monitor) => [monitor.monitor_id, monitor.status])).toEqual([["monitor_1", "active"], ["monitor_2", "cancelled"]]);
  });

  it("keeps a watch active when Parallel does not take the cancel, for the next run", async () => {
    let fail = false;
    const parallel = fakeParallel((call) => (call.url.endsWith("/cancel") && fail ? { status: 500 } : call.url.includes("?") ? { json: { monitors: [{ monitor_id: "monitor_1", metadata: call.body }] } } : { json: { monitor_id: "monitor_1" } }));
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
