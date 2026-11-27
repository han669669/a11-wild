import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadRows, makeTestProspect } from "../../src/outreach/load.js";
import { linkedFirstSends, nextStep, OutreachSequence, sameContact, sameContactPeers } from "../../src/outreach/sequence.js";
import { routeCheckUnresolved, sendTarget, stageOf } from "../../src/outreach/stage.js";
import { OutreachStore } from "../../src/outreach/store.js";
import { inCampaign } from "../../src/outreach/desk.js";
import { MemoryTable } from "../helpers/memory-table.js";
import { ad, event, file, profile, row } from "./helpers.js";

const STEPS = [
  { titles: ["New ad for {Brand}", "{Brand}, I made this for you"], body: "Hi, I made this ad for {Brand}." },
  { titles: ["Re: New ad for {Brand}", "{Brand}, still yours"], body: "Hi, Han again." },
  { titles: ["Last one, {Brand}", "{Brand}, one more before I go"], body: "Hi, last note from me." },
] as [{ titles: [string, string]; body: string }, { titles: [string, string]; body: string }, { titles: [string, string]; body: string }];

let store: OutreachStore;
let sequence: OutreachSequence;
// Monday 23 November 2026, 10:00 in Singapore.
const clock = { now: new Date("2026-11-23T02:00:00Z") };
const now = () => clock.now;
const at = (singaporeTime: string) => {
  clock.now = new Date(`${singaporeTime}+08:00`);
};

const adOf = { batchId: "b", imageId: "i", kind: "v1" as const, key: "k", why: "w" };
/** A prospect whose ad has the owner's yes. */
async function ready(id: string) {
  const ad = await store.addAd(id, adOf);
  await sequence.verdict(id, { ad: ad.n, yes: true });
}
const stage = async (id: string) => stageOf((await store.all()).find((file) => file.profile.id === id)!, await store.optOuts());

beforeEach(async () => {
  at("2026-11-23T10:00:00");
  store = new OutreachStore(new MemoryTable(), now);
  sequence = new OutreachSequence(store, now);
  await loadRows(store, [1, 2, 3, 4, 5, 6, 7].map((n) => row(n)), now);
  await sequence.saveTemplates(STEPS);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("marking a message as sent", () => {
  it("saves the day, the channel and the exact text with the chosen title", async () => {
    await ready("00001");
    const { send, already } = await sequence.send("00001", { step: 0, title: 1 });
    expect(already).toBe(false);
    expect(send).toMatchObject({ step: 0, day: "2026-11-23", channel: "whatsapp", title: "Brand 1, I made this for you", text: "Hi, I made this ad for Brand 1." });
    expect(await stage("00001")).toBe("contacted");
  });

  it("checks a changed contact before sending, then allows it after confirmation", async () => {
    await ready("00001");
    await loadRows(store, [row(1, { bestRoute: "Email (valid) new@example.com" })], now);
    await expect(sequence.send("00001", { step: 0, title: 0 })).rejects.toThrow(
      "The best contact for this brand changed. Check it, then send.",
    );
    expect((await store.get("00001")).routeCheck).toMatchObject({ channel: "whatsapp", direct: false });
    await sequence.confirmRoute("00001");
    const sent = await sequence.send("00001", { step: 0, title: 0 });
    expect(sent.send).toMatchObject({ channel: "email", to: "new@example.com" });
  });

  it("does not reopen a confirmed check on an identical re-import", async () => {
    await ready("00001");
    const changed = row(1, { bestRoute: "Email (valid) new@example.com" });
    await loadRows(store, [changed], now);
    await sequence.confirmRoute("00001");
    await loadRows(store, [changed], now);
    const file = (await store.all()).find((entry) => entry.profile.id === "00001")!;
    expect(file.profile.routeCheck).toMatchObject({ channel: "whatsapp", direct: false });
    expect(routeCheckUnresolved(file)).toBe(false);
  });

  it("refreshes route names and titles without creating a check for an unchanged contact", async () => {
    await loadRows(store, [row(1, { bestRoute: "DM phone +65 8000 0001", decisionMaker: "Amelia Lee", dmTitle: "Founder" })], now);
    await ready("00001");
    await loadRows(store, [row(1, { bestRoute: "DM phone +65 8000 0001", decisionMaker: "Amelia Li", dmTitle: "Managing Director" })], now);

    const saved = (await store.all()).find((file) => file.profile.id === "00001")!;
    expect(saved.profile.route).toMatchObject({ channel: "whatsapp", to: "6580000001", person: "Amelia Li", title: "Managing Director" });
    expect(saved.profile.routeCheck).toBeUndefined();
    expect(sendTarget(saved)).toMatchObject({ channel: "whatsapp", to: "6580000001", person: "Amelia Li", title: "Managing Director" });
  });

  it("checks an email change selected by the owner's email preference", async () => {
    await ready("00001");
    await sequence.setChannel("00001", "email");
    const incoming = row(1, { bestRoute: "WhatsApp +65 8000 0001", email: "replacement@example.com" });
    await loadRows(store, [incoming], now);

    expect((await store.get("00001")).routeCheck).toMatchObject({ channel: "email", direct: false });
    expect((await store.get("00001")).routeCheck?.since).toBe((await store.get("00001")).loadedAt);
  });

  it("records confirmation without storing a contact", async () => {
    await ready("00001");
    const changed = row(1, { bestRoute: "Email (valid) new@example.com", email: "new@example.com" });
    await loadRows(store, [changed], now);
    const event = await sequence.confirmRoute("00001");
    expect(event).toMatchObject({ type: "route", choice: "confirmed" });
    expect(event).not.toHaveProperty("target");
    expect(event).not.toHaveProperty("to");
    expect(event).not.toHaveProperty("person");
  });

  it("keeps a check pending until a current contact is available to confirm", async () => {
    await ready("00001");
    await loadRows(store, [row(1, { bestRoute: "Email (valid) changed@example.com" })], now);
    const pending = (await store.get("00001")).routeCheck;
    expect(pending).toBeDefined();

    await loadRows(store, [row(1, { bestRoute: undefined, secondRoute: undefined, whatsapp: "", email: "", phone: "", dmEmail: "", dmPhone: "" })], now);
    expect(sendTarget((await store.all()).find((entry) => entry.profile.id === "00001")!)).toBeUndefined();
    await expect(sequence.confirmRoute("00001")).rejects.toThrow("There is no contact to confirm yet.");

    await loadRows(store, [row(1, { bestRoute: "Email (valid) replacement@example.com", whatsapp: "", email: "" })], now);
    const file = (await store.all()).find((entry) => entry.profile.id === "00001")!;
    expect(file.profile.routeCheck).toEqual(pending);
    expect(routeCheckUnresolved(file)).toBe(true);
  });

  it("uses the current contact for a follow-up after an import without confirmation", async () => {
    await ready("00001");
    await sequence.send("00001", { step: 0, title: 0 });
    at("2026-11-26T10:00:00");
    await loadRows(store, [row(1, { bestRoute: "Email (valid) replacement@example.com" })], now);

    const imported = (await store.all()).find((entry) => entry.profile.id === "00001")!;
    expect(imported.profile.routeCheck).toBeUndefined();
    expect(routeCheckUnresolved(imported)).toBe(false);
    const followUp = await sequence.send("00001", { step: 1, title: 0 });
    expect(followUp.send).toMatchObject({ channel: "email", to: "replacement@example.com" });
  });

  it("records a follow-up at an earlier destination sent by this brand", async () => {
    await ready("00001");
    const first = await sequence.send("00001", { step: 0, title: 0 });
    at("2026-11-26T10:00:00");
    await loadRows(store, [row(1, { bestRoute: "Email (valid) replacement@example.com", whatsapp: "", email: "" })], now);

    const followUp = await sequence.send("00001", { step: 1, title: 0, channel: first.send.channel, to: first.send.to });
    expect(followUp.send).toMatchObject({ channel: first.send.channel, to: first.send.to });
  });

  it("refuses a follow-up to a destination never sent by this brand", async () => {
    await ready("00001");
    await sequence.send("00001", { step: 0, title: 0 });
    at("2026-11-26T10:00:00");
    await loadRows(store, [row(1, { bestRoute: "Email (valid) replacement@example.com", whatsapp: "", email: "" })], now);

    await expect(sequence.send("00001", { step: 1, title: 0, channel: "email", to: "never-sent@example.com" })).rejects.toThrow(
      "The contact for this brand changed. Reload the page and check it before marking.",
    );
  });

  it("returns an existing mark before checking its supplied destination", async () => {
    await ready("00001");
    const first = await sequence.send("00001", { step: 0, title: 0 });
    at("2026-11-26T10:00:00");
    await loadRows(store, [row(1, { bestRoute: "Email (valid) replacement@example.com" })], now);

    const repeated = await sequence.send("00001", { step: 0, title: 1, channel: first.send.channel, to: first.send.to });
    expect(repeated).toEqual({ send: first.send, already: true });
    expect((await store.all()).find((entry) => entry.profile.id === "00001")?.sends).toHaveLength(1);
  });

  it("refuses a channel-only mismatch with the current contact", async () => {
    await ready("00001");

    await expect(sequence.send("00001", { step: 0, title: 0, channel: "email" })).rejects.toThrow(
      "The contact for this brand changed. Reload the page and check it before marking.",
    );
    expect((await store.all()).find((entry) => entry.profile.id === "00001")?.sends).toEqual([]);
  });

  it("keeps an unresolved check when an identical import finds the brand parked", async () => {
    await loadRows(store, [row(1, { bestRoute: "WhatsApp +65 8000 0001" })], now);
    await ready("00001");
    const changed = row(1, { bestRoute: "Email (valid) new@example.com" });
    await loadRows(store, [changed], now);
    await sequence.setStage("00001", "parked");
    await loadRows(store, [changed], now);
    const file = (await store.all()).find((entry) => entry.profile.id === "00001")!;
    expect(file.profile.routeCheck).toMatchObject({ channel: "whatsapp", direct: false });
    expect(routeCheckUnresolved(file)).toBe(true);
  });

  it("checks the next current contact when the preferred contact is quarantined", async () => {
    const initial = row(1, {
      bestRoute: "DM email (valid) first@example.com",
      secondRoute: "DM email (valid) second@example.com",
      decisionMaker: "Amelia Lee",
      dmTitle: "Founder",
    });
    await loadRows(store, [initial], now);
    await ready("00001");
    const changed = row(1, {
      bestRoute: "DM email (valid) first@example.com",
      secondRoute: "DM email (valid) second@example.com",
      decisionMaker: "Amelia Lee",
      dmTitle: "Founder",
      notes: "AUDIT-FLAG: first@example.com do not use",
    });
    await loadRows(store, [changed], now);
    const file = (await store.all()).find((entry) => entry.profile.id === "00001")!;
    expect(file.profile.routeCheck).toMatchObject({ channel: "email", direct: true });
    expect(sendTarget(file)).toMatchObject({ channel: "email", to: "second@example.com", person: "Amelia Lee", title: "Founder" });
  });

  it("counts a send at 23:30 on Monday in Singapore on Monday", async () => {
    await ready("00001");
    at("2026-11-23T23:30:00");
    expect((await sequence.send("00001", { step: 0, title: 0 })).send.day).toBe("2026-11-23");
  });

  it("keeps the saved text when the template changes later", async () => {
    await ready("00001");
    await sequence.send("00001", { step: 0, title: 0 });
    await sequence.saveTemplates([{ titles: ["a", "b"], body: "New words for {Brand}." }, STEPS[1], STEPS[2]]);
    expect((await store.all())[0]!.sends[0]).toMatchObject({ title: "New ad for Brand 1", text: "Hi, I made this ad for Brand 1." });
  });

  it("does nothing on a second mark of the same step", async () => {
    await ready("00001");
    const first = await sequence.send("00001", { step: 0, title: 0 });
    at("2026-11-23T11:00:00");
    const second = await sequence.send("00001", { step: 0, title: 1 });
    expect(second).toEqual({ send: first.send, already: true });
    expect(await store.placesTaken("2026-11-23")).toBe(1);
  });

  it("saves one send and counts one when two marks come at once", async () => {
    await ready("00001");
    const both = await Promise.all([sequence.send("00001", { step: 0, title: 0 }), sequence.send("00001", { step: 0, title: 0 })]);
    expect(both.filter((entry) => !entry.already)).toHaveLength(1);
    expect(await store.placesTaken("2026-11-23")).toBe(1);
    expect((await store.all())[0]!.sends).toHaveLength(1);
  });

  it("refuses a sixth first message on one day, and not a follow-up", async () => {
    for (const id of ["00001", "00002", "00003", "00004", "00005", "00006"]) await ready(id);
    await sequence.send("00001", { step: 0, title: 0 });
    at("2026-11-26T10:00:00");
    for (const id of ["00002", "00003", "00004", "00005", "00006"]) await sequence.send(id, { step: 0, title: 0 });
    await ready("00007");
    await expect(sequence.send("00007", { step: 0, title: 0 })).rejects.toThrow(/Today's 5 first messages are sent\. More can go tomorrow, or raise the daily number\./);
    expect((await sequence.send("00001", { step: 1, title: 0 })).send).toMatchObject({ step: 1, day: "2026-11-26" });
  });

  it("follows the owner's daily number", async () => {
    await sequence.setDaily(1);
    await ready("00001");
    await ready("00002");
    await sequence.send("00001", { step: 0, title: 0 });
    await expect(sequence.send("00002", { step: 0, title: 0 })).rejects.toThrow(/Today's 1 first messages are sent/);
    await expect(sequence.setDaily(0)).rejects.toThrow(/from 1 to 20/);
    await expect(sequence.setDaily(21)).rejects.toThrow(/from 1 to 20/);
  });

  it("refuses a first message to a brand whose ad has no yes", async () => {
    await expect(sequence.send("00001", { step: 0, title: 0 })).rejects.toThrow(/only to a brand whose ad you said yes to.*"new"/);
    await store.addAd("00001", adOf);
    await expect(sequence.send("00001", { step: 0, title: 0 })).rejects.toThrow(/"ad_waits"/);
  });

  it("records a send on a Saturday and on a public holiday: the weekdays are the plan, and the owner sends when he chooses", async () => {
    for (const id of ["00001", "00002"]) await ready(id);
    at("2026-11-28T10:00:00");
    expect((await sequence.send("00001", { step: 0, title: 0 })).send).toMatchObject({ step: 0, day: "2026-11-28" });
    // The follow-up of a Saturday send is still due on a weekday: three days later is Tuesday.
    expect(nextStep((await store.all()).find((file) => file.profile.id === "00001")!)).toEqual({ step: 1, due: "2026-12-01" });
    at("2026-12-25T10:00:00");
    expect((await sequence.send("00002", { step: 0, title: 0 })).send).toMatchObject({ step: 0, day: "2026-12-25" });
  });

  it("refuses a follow-up before its day, follow-up 2 without follow-up 1, and a fourth message", async () => {
    await ready("00001");
    await sequence.send("00001", { step: 0, title: 0 });
    at("2026-11-25T10:00:00");
    await expect(sequence.send("00001", { step: 1, title: 0 })).rejects.toThrow(/follow-up 1 of this brand is due on 2026-11-26/);
    at("2026-11-26T10:00:00");
    await expect(sequence.send("00001", { step: 2, title: 0 })).rejects.toThrow(/The next message of this brand is follow-up 1/);
    await sequence.send("00001", { step: 1, title: 0 });
    at("2026-11-30T10:00:00");
    await sequence.send("00001", { step: 2, title: 0 });
    expect((await store.all())[0]!.sends.map((send) => send.step)).toEqual([0, 1, 2]);
    await expect(sequence.send("00001", { step: 3 as never, title: 0 })).rejects.toThrow();
  });

  it("refuses a follow-up after a reply", async () => {
    await ready("00001");
    await sequence.send("00001", { step: 0, title: 0 });
    await sequence.reply("00001", { reply: "other", text: "Who is this?" });
    at("2026-11-26T10:00:00");
    await expect(sequence.send("00001", { step: 1, title: 0 })).rejects.toThrow(/has not replied.*"replied"/);
  });

  it("refuses a send to an opted-out contact, also when the opt-out came from another brand with the same contact", async () => {
    await loadRows(store, [row(2, { whatsapp: "+65 8000 0001" })], now);
    await ready("00001");
    await ready("00002");
    await sequence.choose("00002");
    await sequence.optOut("00001");
    await expect(sequence.send("00001", { step: 0, title: 0 })).rejects.toThrow(/opted out/);
    await expect(sequence.send("00002", { step: 0, title: 0 })).rejects.toThrow(/opted out/);
    expect(await store.placesTaken("2026-11-23")).toBe(0);
  });

  it("offers only the first of two brands with the same number, until the owner chooses the second", async () => {
    await loadRows(store, [row(2, { whatsapp: "+65 8000 0001" })], now);
    await ready("00001");
    await ready("00002");
    await expect(sequence.send("00002", { step: 0, title: 0 })).rejects.toThrow(/same contact as Brand 1/);
    await sequence.choose("00002");
    expect((await sequence.send("00002", { step: 0, title: 0 })).already).toBe(false);
    // Derived bidirectional send-state linkage: one authoritative send in storage covers Brand 1 too, using 1 daily slot.
    const all = await store.all();
    const linked = linkedFirstSends(all);
    expect(linked.get("00001")).toMatchObject({ step: 0, linkedFrom: "00002", linkedBrand: "Brand 2" });
    expect(stageOf(all.find((entry) => entry.profile.id === "00001")!, new Set(), linked.get("00001"))).toBe("contacted");
    expect(all.find((entry) => entry.profile.id === "00001")!.sends).toHaveLength(0);
    expect(await store.placesTaken("2026-11-23")).toBe(1);
    await expect(sequence.send("00001", { step: 0, title: 0 })).rejects.toThrow(/already messaged via Brand 2/);
    await expect(sequence.takeBack("00001", 0)).rejects.toThrow(/sent via Brand 2/);
    await sequence.takeBack("00002", 0);
    expect(linkedFirstSends(await store.all()).size).toBe(0);
    expect(await stage("00001")).toBe("ready");
    expect(await stage("00002")).toBe("ready");
    expect(await store.placesTaken("2026-11-23")).toBe(0);
  });

  it("derives linked send state only for the destination used and stops origin follow-ups after a sibling reply", async () => {
    await loadRows(
      store,
      [
        row(1, { whatsapp: "+65 8000 0001", email: "brand1@example.com" }),
        row(2, { whatsapp: "+65 8000 0001", email: "brand2@example.com" }),
      ],
      now,
    );
    await ready("00001");
    await ready("00002");
    await sequence.choose("00002");
    const peers = sameContactPeers(await store.all());
    expect(peers.get("00001")?.map((p) => p.profile.id)).toEqual(["00002"]);
    expect(peers.get("00002")?.map((p) => p.profile.id)).toEqual(["00001"]);

    // Sending to Brand 1's own unique email does NOT mark Brand 2 contacted (even though they share a backup phone).
    await sequence.setChannel("00001", "email");
    await sequence.send("00001", { step: 0, title: 0 });
    expect(linkedFirstSends(await store.all()).get("00002")).toBeUndefined();
    await sequence.takeBack("00001", 0);

    // Sending to the shared WhatsApp number DOES cover Brand 2 (and newly imported siblings), and a reply on Brand 2 stops Brand 1's follow-ups.
    await sequence.setChannel("00001", "whatsapp");
    await sequence.send("00001", { step: 0, title: 0 });
    await loadRows(store, [row(3, { whatsapp: "+65 8000 0001" })], now);
    const all = await store.all();
    expect(linkedFirstSends(all).get("00002")).toMatchObject({ linkedFrom: "00001", linkedBrand: "Brand 1" });
    expect(linkedFirstSends(all).get("00003")).toMatchObject({ linkedFrom: "00001", linkedBrand: "Brand 1" });
    expect(nextStep(all.find((e) => e.profile.id === "00001")!, all)).toMatchObject({ step: 1 });
    await sequence.reply("00002", { reply: "more", text: "tell me more" });
    const afterReply = await store.all();
    expect(nextStep(afterReply.find((e) => e.profile.id === "00001")!, afterReply)).toBeUndefined();
  });

  it("refuses a send before the message text is loaded", async () => {
    const empty = new OutreachStore(new MemoryTable(), now);
    const fresh = new OutreachSequence(empty, now);
    await loadRows(empty, [row(1)], now);
    const ad = await empty.addAd("00001", adOf);
    await fresh.verdict("00001", { ad: ad.n, yes: true });
    await expect(fresh.send("00001", { step: 0, title: 0 })).rejects.toThrow(/message text is not loaded/);
    expect(await empty.placesTaken("2026-11-23")).toBe(0);
  });

  it("leaves a test prospect out of the day's count and out of the register", async () => {
    const test = await makeTestProspect(store, { brand: "TEST prospect", whatsapp: "+65 8000 0001" }, now);
    await ready(test.id);
    await sequence.send(test.id, { step: 0, title: 0 });
    expect(await store.placesTaken("2026-11-23")).toBe(0);
    await sequence.reply(test.id, { reply: "no" });
    expect(await stage(test.id)).toBe("opted_out");
    expect((await store.optOuts()).size).toBe(0);
    expect(await stage("00001")).toBe("new");
  });
});

describe("new contact and campaign membership rules", () => {
  it("finds a shared decision-maker email or number", async () => {
    await loadRows(store, [
      row(1, { email: "brand1@example.com", dmEmail: "person@example.com", dmPhone: "+65 9123 4567" }),
      row(2, { email: "brand2@example.com", dmEmail: "PERSON@example.com", dmPhone: "91234567" }),
    ], now);
    expect(sameContact(await store.all()).get("00002")?.profile.id).toBe("00001");
  });

  it("keeps started work in the campaign when the saved tier drops", () => {
    expect(inCampaign(file({ profile: profile(1, { email: "person@example.com", tier: "<5" }) }))).toBe(false);
    expect(inCampaign(file({ profile: profile(1, { email: "person@example.com", tier: "<5" }), ads: [ad(1)] }))).toBe(true);
    expect(inCampaign(file({ profile: profile(1, { email: "person@example.com", tier: "<5" }), events: [event({ type: "candidates", batchId: "b", drafts: 2 }, "agent")] }))).toBe(true);
    expect(inCampaign(file({ profile: profile(1, { email: "person@example.com", tier: "<5" }) }), "open-batch")).toBe(true);
    expect(inCampaign(file({ profile: profile(1, { email: "person@example.com", tier: "20+" }) }))).toBe(true);
    expect(inCampaign(file({ profile: profile(1, { email: "person@example.com", tier: "20+", test: true }), ads: [ad(1)] }))).toBe(false);
  });
});

describe("a write that fails half way", () => {
  const down = new Error("the table is down");

  it("gives the day's place back when the mark is not saved", async () => {
    await ready("00001");
    vi.spyOn(store, "putSend").mockRejectedValueOnce(down);
    await expect(sequence.send("00001", { step: 0, title: 0 })).rejects.toBe(down);
    expect(await store.placesTaken("2026-11-23")).toBe(0);
    expect((await sequence.send("00001", { step: 0, title: 0 })).already).toBe(false);
    expect(await store.placesTaken("2026-11-23")).toBe(1);
  });

  it("gives the day's place back when the note of a take-back is not saved", async () => {
    await ready("00001");
    await sequence.send("00001", { step: 0, title: 0 });
    vi.spyOn(store, "addEvent").mockRejectedValueOnce(down);
    await expect(sequence.takeBack("00001", 0)).rejects.toBe(down);
    expect(await store.placesTaken("2026-11-23")).toBe(0);
    expect(await stage("00001")).toBe("ready");
  });

  it("has the contact off every list when the opt-out's own note is not saved", async () => {
    await loadRows(store, [row(8, { whatsapp: "+65 8000 0001", email: undefined })], now);
    vi.spyOn(store, "addEvent").mockRejectedValueOnce(down);
    await expect(sequence.optOut("00001")).rejects.toBe(down);
    expect(await stage("00001")).toBe("opted_out");
    expect(await stage("00008")).toBe("opted_out");
  });
});

describe("taking a mark back", () => {
  it("removes the send on the same day and gives the place back", async () => {
    await ready("00001");
    await sequence.send("00001", { step: 0, title: 0 });
    await sequence.takeBack("00001", 0);
    expect(await stage("00001")).toBe("ready");
    expect(await store.placesTaken("2026-11-23")).toBe(0);
    expect((await store.all())[0]!.events.at(-1)).toMatchObject({ type: "unsent", step: 0 });
    expect((await sequence.send("00001", { step: 0, title: 1 })).already).toBe(false);
  });

  it("requires confirmation after taking back a first message sent to an outdated contact", async () => {
    await ready("00001");
    await loadRows(store, [row(1, { bestRoute: "Email (valid) original@example.com" })], now);
    await sequence.confirmRoute("00001");
    await sequence.send("00001", { step: 0, title: 0 });
    const priorCheck = (await store.get("00001")).routeCheck;
    at("2026-11-23T10:01:00");
    await loadRows(store, [row(1, { bestRoute: "Email (valid) replacement@example.com" })], now);
    const imported = (await store.all()).find((entry) => entry.profile.id === "00001")!;
    expect(routeCheckUnresolved(imported)).toBe(false);

    const saveProfile = vi.spyOn(store, "saveProfile");
    await sequence.takeBack("00001", 0);
    const file = (await store.all()).find((entry) => entry.profile.id === "00001")!;
    expect(await stage("00001")).toBe("ready");
    expect(saveProfile).not.toHaveBeenCalled();
    expect(file.profile.routeCheck).toEqual(priorCheck);
    expect(file.events.at(-1)).toMatchObject({ type: "unsent", step: 0, recheck: true });
    expect(file.events.at(-1)).not.toHaveProperty("to");
    expect(file.events.at(-1)).not.toHaveProperty("person");
    expect(routeCheckUnresolved(file)).toBe(true);
    await expect(sequence.send("00001", { step: 0, title: 0 })).rejects.toThrow("The best contact for this brand changed. Check it, then send.");

    at("2026-11-23T10:02:00");
    await sequence.confirmRoute("00001");
    const confirmed = (await store.all()).find((entry) => entry.profile.id === "00001")!;
    expect(routeCheckUnresolved(confirmed)).toBe(false);
    expect((await sequence.send("00001", { step: 0, title: 0 })).send).toMatchObject({ channel: "email", to: "replacement@example.com" });
  });

  it("is refused on the next day, and for a step that is not the newest", async () => {
    await ready("00001");
    await sequence.send("00001", { step: 0, title: 0 });
    at("2026-11-24T10:00:00");
    await expect(sequence.takeBack("00001", 0)).rejects.toThrow(/on its own day only\. This one is of 2026-11-23/);
    at("2026-11-26T10:00:00");
    await sequence.send("00001", { step: 1, title: 0 });
    await expect(sequence.takeBack("00001", 0)).rejects.toThrow(/later message/);
    await expect(sequence.takeBack("00001", 2)).rejects.toThrow(/not marked as sent/);
  });
});

describe("a reply and the owner's choices", () => {
  it("registers every sent contact when the brand opts out", async () => {
    await ready("00001");
    const first = await sequence.send("00001", { step: 0, title: 0 });
    expect(first.send).toMatchObject({ channel: "whatsapp", to: "6580000001" });
    at("2026-11-26T10:00:00");
    await loadRows(
      store,
      [
        row(1, { bestRoute: "Email (valid) replacement@example.com", whatsapp: "", email: "" }),
        row(2, { bestRoute: "Email (valid) replacement@example.com", whatsapp: "", email: "" }),
        row(3, { whatsapp: "+65 8000 0001" }),
      ],
      now,
    );
    await ready("00002");
    await ready("00003");

    const followUp = await sequence.send("00001", { step: 1, title: 0, channel: "email", to: "replacement@example.com" });
    expect(followUp.send).toMatchObject({ channel: "email", to: "replacement@example.com" });

    await sequence.optOut("00001");

    expect(await store.optOuts()).toContain("E#replacement@example.com");
    expect(await store.optOuts()).toContain("W#6580000001");
    await expect(sequence.send("00002", { step: 0, title: 0 })).rejects.toThrow(/opted out/);
    await expect(sequence.send("00003", { step: 0, title: 0 })).rejects.toThrow(/opted out/);
  });

  it("registers a sent contact that the workbook later dropped when the brand opts out", async () => {
    await ready("00001");
    const first = await sequence.send("00001", { step: 0, title: 0 });
    expect(first.send).toMatchObject({ channel: "whatsapp", to: "6580000001" });
    at("2026-11-26T10:00:00");
    await loadRows(
      store,
      [
        row(1, { bestRoute: "Email (valid) replacement@example.com", whatsapp: "", email: "" }),
        row(2, { whatsapp: "+65 8000 0001" }),
      ],
      now,
    );
    await ready("00002");

    await sequence.optOut("00001");

    expect(await store.optOuts()).toContain("W#6580000001");
    await expect(sequence.send("00001", { step: 1, title: 0, channel: first.send.channel, to: first.send.to })).rejects.toThrow(
      "The contact for this brand changed. Reload the page and check it before marking.",
    );
    await expect(sequence.send("00002", { step: 0, title: 0 })).rejects.toThrow(/opted out/);
  });

  it("makes a no an opt-out for the contact", async () => {
    await ready("00001");
    await sequence.send("00001", { step: 0, title: 0 });
    await sequence.reply("00001", { reply: "no" });
    expect(await stage("00001")).toBe("opted_out");
    expect(await store.optOuts()).toEqual(new Set(["W#6580000001", "E#brand1@example.com"]));
  });

  it("refuses a reply for a brand that got no message", async () => {
    await expect(sequence.reply("00001", { reply: "more" })).rejects.toThrow(/got the first message/);
  });

  it("takes one yes or no for the newest ad, and asks for his words with a no", async () => {
    const ad = await store.addAd("00001", adOf);
    await expect(sequence.verdict("00001", { ad: ad.n, yes: false })).rejects.toThrow(/needs your words/);
    await sequence.verdict("00001", { ad: ad.n, yes: false, ownerSaid: "the pack is too small" });
    await expect(sequence.verdict("00001", { ad: ad.n, yes: true })).rejects.toThrow(/has its yes or no already/);
    await expect(sequence.verdict("00001", { ad: 9, yes: true })).rejects.toThrow(/no ad 9/);
    const second = await store.addAd("00001", adOf);
    await expect(sequence.verdict("00001", { ad: ad.n, yes: true })).rejects.toThrow(/Only the newest ad/);
    await sequence.verdict("00001", { ad: second.n, yes: true });
    expect(await stage("00001")).toBe("ready");
  });

  it("refuses a channel the brand does not have", async () => {
    await loadRows(store, [row(2, { whatsapp: undefined })], now);
    await expect(sequence.setChannel("00002", "whatsapp")).rejects.toThrow(/no WhatsApp number/);
    await sequence.setChannel("00001", "email");
    await ready("00001");
    expect((await sequence.send("00001", { step: 0, title: 0 })).send.channel).toBe("email");
  });

  it("loads the message text once, and lets the owner change it after", async () => {
    expect(await sequence.saveTemplates([{ titles: ["x", "y"], body: "z" }, STEPS[1], STEPS[2]], { onlyFirst: true })).toBeUndefined();
    expect((await sequence.templates())!.steps[0].body).toBe("Hi, I made this ad for {Brand}.");
    await expect(sequence.saveTemplates([{ titles: ["x", "y"], body: "Hi {Name}" }, STEPS[1], STEPS[2]])).rejects.toThrow(/first message holds "\{Name\}"/);
  });
});
