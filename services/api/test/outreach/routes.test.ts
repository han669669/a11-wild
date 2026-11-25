import { beforeEach, describe, expect, it } from "vitest";
import { loadRows, type LoadRow } from "../../src/outreach/load.js";
import { routeOf } from "../../src/outreach/routes.js";
import { OutreachStore } from "../../src/outreach/store.js";
import { MemoryTable } from "../helpers/memory-table.js";
import { row } from "./helpers.js";

let store: OutreachStore;
const now = () => new Date("2026-11-23T02:00:00.000Z");
const listed = (n: number, extra: Partial<LoadRow> = {}) => row(n, { email: `brand${n}@example.com`, ...extra });

beforeEach(() => {
  store = new OutreachStore(new MemoryTable(), now);
});

describe("the list's ways to reach a brand", () => {
  it.each([
    ["WhatsApp +65 9123 4567; +65 8123 4567", { channel: "whatsapp", to: "6591234567", direct: false }],
    ["DM phone +65 9123 4567", { channel: "whatsapp", to: "6591234567", direct: true }],
    ["DM phone +65 6123 4567", { channel: "call", to: "6561234567", direct: true }],
    ["Phone +65 9123 4567", { channel: "whatsapp", to: "6591234567", direct: false }],
    ["Phone +65 6123 4567", { channel: "call", to: "6561234567", direct: false }],
    ["Email (valid) Person@Example.com", { channel: "email", to: "person@example.com", direct: false }],
    ["DM email (valid) Person@Example.com", { channel: "email", to: "person@example.com", direct: true }],
    ["Instagram DM @madeup.handle", { channel: "instagram", to: "@madeup.handle", direct: false }],
    ["Facebook message Made-up Bakery", { channel: "facebook", to: "Made-up Bakery", direct: false }],
  ])("parses %s", (text, target) => {
    expect(routeOf(text)).toEqual({ ...target, label: text });
  });

  it.each(["", "unknown", "source_url", "<UNKNOWN>", "Phone 12", "Email (risky) person@example.com", "Email (invalid) person@example.com", "Email (catch-all) person@example.com", "DM email (valid) not an address"])(
    "does not make a target from %s",
    (text) => expect(routeOf(text)).toBeUndefined(),
  );
});

describe("loading the additional list fields", () => {
  it("computes the tier from ads running and keeps the later saved ad date", async () => {
    await loadRows(store, [listed(1, { liveAds: 3, tier: "20+", newestAd: "2026-11-10" })], now);
    await loadRows(store, [listed(1, { liveAds: 6, tier: "<5", newestAd: "2026-11-01" })], now);
    expect((await store.get("00001")).tier).toBe("5-19");
    expect((await store.get("00001")).newestAd).toBe("2026-11-10");
  });

  it("drops junk names and keeps raw notes while extracting flags", async () => {
    const notes = "DUP-CHECK: maybe the same | QA-FLAG: checked | AUDIT-FLAG: owner@example.com do not send | MERGED-INTO: 8 | MERGED: old text; DUP-CHECK: another match";
    await loadRows(store, [listed(1, { decisionMaker: "source_url", dmTitle: "<UNKNOWN>", sells: "hybrid", notes })], now);
    const profile = await store.get("00001");
    expect(profile).toMatchObject({
      sells: "hybrid",
      notes,
      flags: [
        { kind: "duplicate", text: "DUP-CHECK: maybe the same" },
        { kind: "fixed", text: "QA-FLAG: checked" },
        { kind: "blocked", text: "AUDIT-FLAG: owner@example.com do not send" },
        { kind: "duplicate", text: "DUP-CHECK: another match" },
      ],
    });
    expect(profile.decisionMaker).toBeUndefined();
    expect(profile.dmTitle).toBeUndefined();
  });

  it("removes every blocked email and number from the saved contact fields", async () => {
    const notes = "AUDIT-FLAG: owner@example.com +65 9123 4567 SMTP valid; do not send pending source check";
    const result = await loadRows(store, [
      listed(1, {
        whatsapp: "+65 9123 4567; +65 8123 4567",
        email: "owner@example.com",
        phone: "+65 9123 4567",
        dmEmail: "owner@example.com",
        dmPhone: "+65 9123 4567",
        bestRoute: "DM email (valid) owner@example.com",
        secondRoute: "WhatsApp +65 9123 4567",
        notes,
      }),
    ], now);
    const profile = await store.get("00001");
    expect(result.blocked).toBe(1);
    expect(profile).toMatchObject({ whatsapp: ["6581234567"], notes, flags: [{ kind: "blocked" }] });
    expect(profile.email).toBeUndefined();
    expect(profile.dmEmail).toBeUndefined();
    expect(profile.phone).toBeUndefined();
    expect(profile.dmPhone).toBeUndefined();
    expect(profile.route).toBeUndefined();
    expect(profile.second).toBeUndefined();
    expect(profile.bestRoute).toBe("DM email (valid)");
    expect(profile.secondRoute).toBe("WhatsApp");
  });

  it("extracts and strips blocked email addresses with ampersands", async () => {
    await loadRows(store, [
      listed(8, {
        email: "a&b@example.com",
        bestRoute: "Email (valid) a&b@example.com",
        notes: "AUDIT-FLAG: a&b@example.com do not use",
      }),
    ], now);
    const profile = await store.get("00008");
    expect(profile.email).toBeUndefined();
    expect(profile.route).toBeUndefined();
    expect(profile.bestRoute).toBe("Email (valid)");
  });

  it("extracts and strips both slash-separated blocked email addresses", async () => {
    await loadRows(store, [
      listed(9, {
        email: "a@example.com",
        dmEmail: "b@example.com",
        bestRoute: "Email (valid) a@example.com",
        secondRoute: "Email (valid) b@example.com",
        notes: "AUDIT-FLAG: a@example.com/b@example.com do not use",
      }),
    ], now);
    const profile = await store.get("00009");
    expect(profile.email).toBeUndefined();
    expect(profile.dmEmail).toBeUndefined();
    expect(profile.route).toBeUndefined();
    expect(profile.second).toBeUndefined();
    expect(profile.bestRoute).toBe("Email (valid)");
    expect(profile.secondRoute).toBe("Email (valid)");
  });

  it("blocks a slash-local-part email without blocking its suffix as another address", async () => {
    await loadRows(store, [
      listed(10, {
        email: "a/b@example.com",
        dmEmail: "b@example.com",
        bestRoute: "Email (valid) a/b@example.com",
        secondRoute: "Email (valid) b@example.com",
        notes: "AUDIT-FLAG: a/b@example.com do not use",
      }),
    ], now);
    const profile = await store.get("00010");
    expect(profile.email).toBeUndefined();
    expect(profile.dmEmail).toBe("b@example.com");
    expect(profile.route).toBeUndefined();
    expect(profile.second).toMatchObject({ channel: "email", to: "b@example.com" });
    expect(profile.bestRoute).toBe("Email (valid)");
    expect(profile.secondRoute).toBe("Email (valid) b@example.com");
  });

  it("applies the row limits and accepts 500 characters of raw notes", async () => {
    const notes = "n".repeat(500);
    const result = await loadRows(store, [
      listed(1, { bestRoute: "x".repeat(65) }),
      listed(2, { dmTitle: "x".repeat(190) }),
      listed(3, { notes: "n".repeat(501) }),
      listed(4, { notes }),
    ], now);
    expect(result.refused.map(({ row: n, field }) => [n, field])).toEqual([[1, "bestRoute"], [2, "dmTitle"], [3, "notes"]]);
    expect((await store.get("00004")).notes).toBe(notes);
  });
});

describe("merged rows", () => {
  it("loads the survivor first, hides the donor, and lets loading inspect both", async () => {
    const result = await loadRows(store, [listed(21, { mergedInto: 20 }), listed(20)], now);
    expect(result).toMatchObject({ added: 2, merged: 1, refused: [] });
    expect((await store.all()).map((file) => file.profile.id)).toEqual(["00020"]);
    expect((await store.all({ includeMerged: true })).map((file) => file.profile.mergedInto ?? null)).toEqual([null, "00020"]);
    await expect(store.get("00021")).rejects.toThrow("This brand is merged into Brand 20.");
  });

  it("refuses a donor with history and a missing or merged survivor", async () => {
    await loadRows(store, [listed(1), listed(2), listed(3)], now);
    await store.addAd("00002", { batchId: "b", imageId: "i", kind: "v1", key: "outreach/example.png", why: "The cup." });
    const history = await loadRows(store, [listed(2, { mergedInto: 1 })], now);
    expect(history.refused).toEqual([{ row: 2, field: "mergedInto", why: "the merged row has its own history: the owner decides" }]);
    expect((await store.get("00002")).mergedInto).toBeUndefined();

    const missing = await loadRows(store, [listed(1, { mergedInto: 99 })], now);
    expect(missing.refused).toMatchObject([{ field: "mergedInto" }]);
    await loadRows(store, [listed(3, { mergedInto: 1 })], now);
    const mergedSurvivor = await loadRows(store, [listed(2, { mergedInto: 3 })], now);
    expect(mergedSurvivor.refused).toMatchObject([{ field: "mergedInto" }]);
  });
});

describe("a held contact", () => {
  it("holds the old target through a changed contact until the owner resolves it", async () => {
    await loadRows(store, [listed(1, { bestRoute: "WhatsApp +65 8000 0001" })], now);
    const attached = await store.addAd("00001", { batchId: "b", imageId: "i", kind: "v1", key: "outreach/ad.png", why: "The cup." });
    await store.addEvent("00001", { type: "ad_yes", ad: attached.n }, "owner");
    const incoming = listed(1, { bestRoute: "Email (valid) new@example.com" });
    expect(await loadRows(store, [incoming], now)).toMatchObject({ held: 1 });
    expect((await store.get("00001")).routeHeld).toMatchObject({ channel: "whatsapp", to: "6580000001", direct: false, label: "WhatsApp +65 8000 0001" });

    await store.addEvent("00001", { type: "route", choice: "kept" }, "owner");
    await loadRows(store, [incoming], now);
    expect((await store.get("00001")).routeHeld).toBeUndefined();
    expect(await loadRows(store, [incoming], now)).toMatchObject({ held: 0 });
    expect((await store.get("00001")).route).toMatchObject({ channel: "whatsapp", to: "6580000001" });
  });

  it("does not add the new person's name to an already-held direct route", async () => {
    await loadRows(store, [listed(1, { bestRoute: "DM phone +65 8000 0001" })], now);
    const attached = await store.addAd("00001", { batchId: "b", imageId: "i", kind: "v1", key: "outreach/ad.png", why: "The cup." });
    await store.addEvent("00001", { type: "ad_yes", ad: attached.n }, "owner");
    const incoming = listed(1, {
      bestRoute: "DM email (valid) evelyn@example.com",
      decisionMaker: "Evelyn Tan",
      dmTitle: "Director",
    });
    await loadRows(store, [incoming], now);
    expect((await store.get("00001")).routeHeld).toMatchObject({ channel: "whatsapp", to: "6580000001", direct: true });
    expect((await store.get("00001")).routeHeld).not.toHaveProperty("person");
    expect((await store.get("00001")).routeHeld).not.toHaveProperty("title");

    await loadRows(store, [incoming], now);
    expect((await store.get("00001")).routeHeld).not.toHaveProperty("person");
    expect((await store.get("00001")).routeHeld).not.toHaveProperty("title");
    await store.addEvent("00001", { type: "route", choice: "kept" }, "owner");
    await loadRows(store, [incoming], now);
    expect((await store.get("00001")).routeHeld).toBeUndefined();
    expect((await store.get("00001")).route).toMatchObject({ channel: "whatsapp", to: "6580000001", direct: true });
    expect((await store.get("00001")).route).not.toHaveProperty("person");
    expect((await store.get("00001")).route).not.toHaveProperty("title");
  });

  it("drops a hold when the new default is the held target or no send target remains", async () => {
    await loadRows(store, [listed(1, { bestRoute: "WhatsApp +65 8000 0001" })], now);
    const attached = await store.addAd("00001", { batchId: "b", imageId: "i", kind: "v1", key: "outreach/ad.png", why: "The cup." });
    await store.addEvent("00001", { type: "ad_yes", ad: attached.n }, "owner");
    await loadRows(store, [listed(1, { bestRoute: "Email (valid) new@example.com" })], now);

    await loadRows(store, [listed(1, { bestRoute: "WhatsApp +65 8000 0001" })], now);
    expect((await store.get("00001")).routeHeld).toBeUndefined();

    await loadRows(store, [listed(1, { bestRoute: undefined, whatsapp: undefined, email: undefined })], now);
    expect((await store.get("00001")).routeHeld).toBeUndefined();
  });
});
