import { beforeEach, describe, expect, it } from "vitest";
import { approvedClient, callTool, createStudio, type Studio } from "../helpers/deps.js";
import type { ParallelCall } from "../helpers/parallel.js";

let studio: Studio;
let calls: ParallelCall[];
const run = { findall_id: "findall_1", status: { status: "queued", is_active: true, metrics: {} } };

beforeEach(async () => {
  calls = [];
  studio = await createStudio({
    parallel: (call) => {
      calls.push(call);
      if (call.url.endsWith("/v1/decisions")) return { json: { answers: { stocked: { type: "choice", choice: "yes" } }, citations: [{ url: "https://shop.example/", excerpts: ["In stock."] }] } };
      if (call.url.endsWith("/v1/shopping/search")) return { json: { results: [{ url: "https://shop.example/p", title: "Kaya", image_url: "https://shop.example/p.jpg" }, { url: "https://shop.example/q", image_url: "http://10.0.0.1/q.jpg" }] } };
      if (call.url.endsWith("/v1/places/search")) return { json: { results: [{ name: "Brand Outlet", address: "1 Test Road" }] } };
      if (call.url.endsWith("/entity-search")) return { json: { entities: [{ name: "Brand Pte Ltd", url: "https://brand.example" }] } };
      if (call.url.endsWith("/v1/monitors")) return { json: { monitor_id: "monitor_1", status: "active" } };
      return { json: run };
    },
  });
  await approvedClient(studio);
});

describe("the newer Parallel tools", () => {
  it("answers typed questions with their pages, and refuses a choice with fewer than two options", async () => {
    const question = { name: "stocked", type: "choice", instructions: "Does the shop stock the kaya?" };
    expect(await callTool(studio, "web_decide", { state: { brand: "Brand" }, questions: [question] })).toMatchObject({ ok: false, error: expect.stringMatching(/two or more/) });
    expect(calls).toEqual([]);
    const answer = await callTool(studio, "web_decide", { state: { brand: "Brand" }, questions: [{ ...question, criteria: { yes: "It is listed.", unknown: "No page says." } }] });
    expect(answer.value).toMatchObject({ untrusted: true, answers: { stocked: { choice: "yes" } }, citations: [{ url: "https://shop.example/" }] });
  });

  it("searches Singapore's stores and places when no market or location is given, and offers only safe pictures", async () => {
    const shop = (await callTool(studio, "shop_search", { queries: ["kaya 250 g"] })).value;
    expect(calls[0]?.body).toMatchObject({ advanced_settings: { location: "sg", max_results: 20 } });
    expect(shop).toMatchObject({ untrusted: true, searchId: expect.any(String) });
    expect(shop.results.map((result: { imageUrl: string | null }) => result.imageUrl)).toEqual(["https://shop.example/p.jpg", null]);
    expect(await callTool(studio, "shop_search", { queries: ["kaya"], minPrice: 9, maxPrice: 5 })).toMatchObject({ ok: false });
    const places = (await callTool(studio, "place_search", { query: "Brand" })).value;
    expect(calls.at(-1)?.body).toMatchObject({ location: "Singapore", mode: "fast" });
    expect(places).toMatchObject({ untrusted: true, results: [{ name: "Brand Outlet" }] });
  });

  it("gives the search for companies and people, FindAll and the watches to the owner's session only", async () => {
    const member = { sub: "sub-member" };
    for (const [name, args] of [
      ["entity_search", { entityType: "people", objective: "Founders of kaya brands in Singapore" }],
      ["findall_plan", { objective: "Kaya makers in Singapore" }],
      ["findall_start", { objective: "Kaya makers", entityType: "companies", conditions: [{ name: "sells_kaya", description: "Sells kaya." }] }],
      ["findall_get", { findAllId: "findall_1" }],
      ["findall_cancel", { findAllId: "findall_1" }],
      ["watch_start", { query: "Brand launches a new product" }],
      ["watch_list", {}],
      ["watch_events", { monitorId: "monitor_1" }],
      ["watch_stop", { monitorId: "monitor_1" }],
    ] as const) {
      expect(await callTool(studio, name, args, member), name).toMatchObject({ ok: false, error: expect.stringMatching(new RegExp(`^Only the owner.* can call ${name}`)) });
    }
    expect(calls).toEqual([]);
    expect((await callTool(studio, "entity_search", { entityType: "people", objective: "Founders of kaya brands in Singapore" })).value).toMatchObject({ untrusted: true, entities: [{ name: "Brand Pte Ltd" }] });
  });

  it("starts a FindAll run as a preview by default, and refuses a preview of more than ten", async () => {
    const args = { objective: "Kaya makers", entityType: "companies", conditions: [{ name: "sells_kaya", description: "Sells kaya." }] };
    expect(await callTool(studio, "findall_start", { ...args, matchLimit: 20 })).toMatchObject({ ok: false, error: expect.stringMatching(/10 or fewer/) });
    expect((await callTool(studio, "findall_start", args)).value).toMatchObject({ findAllId: "findall_1", active: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toMatchObject({ generator: "preview", match_limit: 10 });
    expect((await callTool(studio, "spend_get", {})).value.monthUsd).toBe(0.1);
  });

  it("starts a daily watch of 30 days, lists it, and stops it", async () => {
    const started = (await callTool(studio, "watch_start", { query: "Brand launches a new product" })).value;
    expect(started).toMatchObject({ monitorId: "monitor_1", frequency: "1d", processor: "lite", by: "owner@example.com", status: "active" });
    expect((await callTool(studio, "watch_list", {})).value.watches).toHaveLength(1);
    expect((await callTool(studio, "watch_stop", { monitorId: "monitor_1" })).value).toMatchObject({ status: "stopped" });
    expect(await callTool(studio, "watch_events", { monitorId: "monitor_9" })).toMatchObject({ ok: false });
  });
});
