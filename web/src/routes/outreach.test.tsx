import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { adView, firstLine, prospectPage, prospectRow, todayPage } from "@/outreach-fixtures";
import { MEMBER, renderSignedIn, stubApi } from "@/test-helpers";
import { Outreach } from "./outreach";

const section = (name: string) => within(screen.getByRole("heading", { name: new RegExp(`^${name}`) }).closest("section")!);

describe("Today page", () => {
  it("says that nothing waits and what brings a brand here, with no empty group", async () => {
    stubApi({ "GET /api/outreach/today": () => ({ body: todayPage() }) });
    renderSignedIn(<Outreach />);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Nothing is asked of you3 of 5 first messages sent todayNothing waits for you today, Mon, 23 Nov 2026. A brand shows here when its drafts are ready for your pick, when a message is due, or when a reply is logged.",
    );
    expect(screen.queryAllByRole("heading", { level: 2 })).toEqual([]);
    expect(screen.queryByText(/Nothing else today/)).not.toBeInTheDocument();
  });

  it("shows only the groups that hold something, in order, and names the empty ones in one line", async () => {
    const owed = { prospect: prospectRow({ stage: "replied" }), reply: { text: "Show me another.", at: "2026-11-20T03:00:00.000Z" } };
    const first = firstLine({ prospect: prospectRow({ id: "00002", n: 2, brand: "Glow Lab", stage: "ready" }) });
    stubApi({ "GET /api/outreach/today": () => ({ body: todayPage({ owed: [owed], firsts: [first] }) }) });
    renderSignedIn(<Outreach />);
    expect(await screen.findByRole("status")).toHaveTextContent("Asked of you3 of 5 first messages sent today2 things wait for you today, Mon, 23 Nov 2026.");
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(["Replies that are owed an answer1", "New first messages1"]);
    expect(screen.getByText("Nothing else today: no follow-up is due, no brand waits for your pick and no ad waits for your yes or no.")).toBeInTheDocument();
  });

  it("says that a Saturday is not a planned day, names the next one, and still offers the messages to send", async () => {
    const owed = { prospect: prospectRow({ stage: "replied" }), reply: { text: "Show me another.", at: "2026-11-20T03:00:00.000Z" } };
    stubApi({ "GET /api/outreach/today": () => ({ body: todayPage({ day: "2026-11-21", sendingDay: false, nextSendingDay: "2026-11-23", firstsSent: 5, owed: [owed], followUps: [firstLine({ step: 1 })] }) }) });
    renderSignedIn(<Outreach />);
    expect(await screen.findByRole("status")).toHaveTextContent("5 of 5 first messages sent today2 things wait for you today, Sat, 21 Nov 2026. Not a planned sending day: the next one is Mon, 23 Nov 2026. You can still send today.");
    expect(section("Replies").getByText("Show me another.")).toBeInTheDocument();
    expect(section("Follow-ups").getByRole("button", { name: "Mark as sent" })).toBeInTheDocument();
    expect(screen.getByText(/Nothing else today: today's first messages are all sent, no brand waits/)).toBeInTheDocument();
  });

  it("gives a first message its ad, both titles and the four actions, and marks it as sent with the title he chose", async () => {
    let sent: unknown;
    stubApi({
      // After the mark the day holds one more, and the line is gone.
      "GET /api/outreach/today": () => ({ body: sent ? todayPage({ firstsSent: 4 }) : todayPage({ firsts: [firstLine()] }) }),
      "POST /api/outreach/prospects/00001/sent": (body) => ((sent = body), { body: prospectPage() }),
    });
    renderSignedIn(<Outreach />);
    const line = within((await screen.findByRole("link", { name: "Koi Tea" })).closest("li")!);
    expect(line.getByRole("img", { name: "Ad 1 for Koi Tea" })).toBeInTheDocument();
    expect(line.getByRole("button", { name: "Copy the text" })).toBeInTheDocument();
    expect(line.getByRole("link", { name: "Open WhatsApp" })).toHaveAttribute("href", "https://wa.me/6580000001?text=one");
    expect(line.getByRole("link", { name: "Save the picture" })).toHaveAttribute("href", "https://pictures.example/1.png?download=1");
    await userEvent.click(line.getByRole("radio", { name: "Koi Tea, I made this for you" }));
    expect(line.getByRole("link", { name: "Open WhatsApp" })).toHaveAttribute("href", "https://wa.me/6580000001?text=two");
    await userEvent.click(line.getByRole("button", { name: "Mark as sent" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("4 of 5"));
    expect(sent).toEqual({ step: 0, title: 1 });
    expect(screen.queryByRole("link", { name: "Koi Tea" })).not.toBeInTheDocument();
  });

  it("leaves the line and shows the reason when the save fails", async () => {
    stubApi({
      "GET /api/outreach/today": () => ({ body: todayPage({ firsts: [firstLine()] }) }),
      "POST /api/outreach/prospects/00001/sent": () => ({ status: 400, body: { error: "refused", message: "Today's 5 first messages are sent. More can go tomorrow, or raise the daily number." } }),
    });
    renderSignedIn(<Outreach />);
    await userEvent.click(await screen.findByRole("button", { name: "Mark as sent" }));
    expect(await screen.findByText(/Today's 5 first messages are sent/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Koi Tea" })).toBeInTheDocument();
  });

  it("shows the current contact for confirmation and disables sending until confirmed", async () => {
    let resolved = false;
    let routeBody: unknown;
    const current = { channel: "email" as const, to: "owner@example.com", direct: true, label: "DM email (valid) owner@example.com", person: "Amelia Lee", title: "Founder" };
    const line = firstLine({
      prospect: prospectRow({ flags: { duplicate: true, blocked: true, check: true } }),
      sendTo: current,
      routeCheck: true,
      flags: [
        { kind: "duplicate", text: "DUP-CHECK: possibly listed twice" },
        { kind: "blocked", text: "AUDIT-FLAG: owner@example.com do not send" },
      ],
    });
    const calls = stubApi({
      "GET /api/outreach/today": () => ({ body: resolved ? todayPage() : todayPage({ firsts: [line] }) }),
      "POST /api/outreach/prospects/00001/route": (body) => ((routeBody = body), (resolved = true), { body: prospectPage() }),
    });
    renderSignedIn(<Outreach />);
    expect(await screen.findByText("Might be the same business as another brand. Look before you send.")).toBeInTheDocument();
    expect(screen.getByText("Do not use: owner@example.com do not send")).toBeInTheDocument();
    expect(screen.queryByText(/AUDIT-FLAG:|DUP-CHECK:/)).not.toBeInTheDocument();
    expect(screen.getByText("To Amelia Lee, Founder, on Email")).toBeInTheDocument();
    expect(screen.getByText("The best contact changed. Now: Email to Amelia Lee, Founder (owner@example.com).")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark as sent" })).toBeDisabled();
    expect(screen.queryByRole("link", { name: "Open WhatsApp" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Use it" }));
    await waitFor(() => expect(routeBody).toEqual({}));
    expect(calls).toContain("POST /api/outreach/prospects/00001/route");
    await waitFor(() => expect(screen.queryByRole("link", { name: "Koi Tea" })).not.toBeInTheDocument());
  });

  it("shows a contact check on Today while an ad waits for its yes or no", async () => {
    const line = firstLine({
      prospect: prospectRow({ flags: { duplicate: false, blocked: false, check: true }, stage: "ad_waits" }),
      sendTo: { channel: "email", to: "amelia@example.com", direct: true, person: "Amelia Lee", title: "Founder" },
      routeCheckTo: { channel: "email", to: "amelia@example.com", direct: true, person: "Amelia Lee", title: "Founder" },
      routeCheck: true,
    });
    delete line.step;
    delete line.messages;
    stubApi({ "GET /api/outreach/today": () => ({ body: todayPage({ firsts: [], adsWaiting: [line] }) }) });
    renderSignedIn(<Outreach />);
    expect(await screen.findByText("The best contact changed. Now: Email to Amelia Lee, Founder (amelia@example.com).")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use it" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark as sent" })).not.toBeInTheDocument();
  });

  it("keeps a follow-up enabled at its saved destination while a contact check is pending", async () => {
    const line = firstLine({
      prospect: prospectRow({ stage: "contacted", channel: "email", flags: { duplicate: false, blocked: false, check: true } }),
      step: 1,
      sendTo: { channel: "whatsapp", to: "6580000001", direct: false },
      routeCheckTo: { channel: "email", to: "amelia@example.com", direct: true, person: "Amelia Lee", title: "Founder" },
      routeCheck: true,
      messages: [
        { title: "Re: New ad for Koi Tea", text: "Hi again.", href: "https://wa.me/6580000001?text=follow-up" },
        { title: "Koi Tea, still yours", text: "Hi again.", href: "https://wa.me/6580000001?text=follow-up" },
      ],
    });
    stubApi({ "GET /api/outreach/today": () => ({ body: todayPage({ firsts: [], followUps: [line] }) }) });
    renderSignedIn(<Outreach />);
    expect(await screen.findByText("The best contact changed. Now: Email to Amelia Lee, Founder (amelia@example.com).")).toBeInTheDocument();
    expect(screen.getByText("To the brand on WhatsApp")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open WhatsApp" })).toHaveAttribute("href", "https://wa.me/6580000001?text=follow-up");
    expect(screen.getByRole("button", { name: "Mark as sent" })).toBeEnabled();
  });

  it("formats direct recipients with and without a title", async () => {
    const direct = { channel: "whatsapp" as const, to: "6580000001", direct: true, label: "DM phone +65 8000 0001", person: "Amelia Lee", title: "Founder" };
    stubApi({ "GET /api/outreach/today": () => ({ body: todayPage({ firsts: [firstLine({ sendTo: direct })] }) }) });
    const first = renderSignedIn(<Outreach />);
    expect(await screen.findByText("To Amelia Lee, Founder, on WhatsApp")).toBeInTheDocument();
    first.unmount();
    stubApi({ "GET /api/outreach/today": () => ({ body: todayPage({ firsts: [{ ...firstLine(), sendTo: { channel: direct.channel, to: direct.to, direct: true, person: "Amelia Lee" } }] }) }) });
    renderSignedIn(<Outreach />);
    expect(await screen.findByText("To Amelia Lee on WhatsApp")).toBeInTheDocument();
  });

  it("takes a yes to an ad that waits, and a no only with his words", async () => {
    const sent: unknown[] = [];
    stubApi({
      "GET /api/outreach/today": () => ({ body: todayPage({ adsWaiting: [{ prospect: prospectRow({ stage: "ad_waits", adWaits: true }), ad: adView() }] }) }),
      "POST /api/outreach/prospects/00001/ad": (body) => (sent.push(body), { body: prospectPage() }),
    });
    renderSignedIn(<Outreach />);
    await userEvent.click(await screen.findByRole("button", { name: "No" }));
    await userEvent.click(screen.getByRole("button", { name: "Save the no" }));
    expect(sent).toEqual([]);
    await userEvent.type(screen.getByLabelText(/What is wrong with it/), "The cup is too small.");
    await userEvent.click(screen.getByRole("button", { name: "Save the no" }));
    await waitFor(() => expect(sent).toEqual([{ ad: 1, yes: false, ownerSaid: "The cup is too small." }]));
  });

  it("lists a brand whose drafts wait for his pick with one link to its page, and no section when none waits", async () => {
    stubApi({ "GET /api/outreach/today": () => ({ body: todayPage({ picks: [{ prospect: prospectRow({ stage: "pick_waits" }), drafts: 8 }] }) }) });
    const first = renderSignedIn(<Outreach />);
    expect(await screen.findByText(/8 drafts to choose from/)).toBeInTheDocument();
    const picks = section("Brands that wait for your pick");
    expect(picks.getByRole("link", { name: "Pick the ad" })).toHaveAttribute("href", "/outreach/prospects/00001");
    expect(picks.queryByRole("button")).not.toBeInTheDocument();
    first.unmount();
    stubApi({ "GET /api/outreach/today": () => ({ body: todayPage() }) });
    renderSignedIn(<Outreach />);
    await screen.findByRole("status");
    expect(screen.queryByRole("heading", { name: /Brands that wait for your pick/ })).not.toBeInTheDocument();
  });

  it("shows a brand name with markup as text", async () => {
    stubApi({ "GET /api/outreach/today": () => ({ body: todayPage({ firsts: [firstLine({ prospect: prospectRow({ brand: '<img src=x onerror="alert(1)">' }) })] }) }) });
    renderSignedIn(<Outreach />);
    expect(await screen.findByRole("link", { name: '<img src=x onerror="alert(1)">' })).toBeInTheDocument();
    expect(document.querySelector("img[src='x']")).toBeNull();
  });

  it("shows a member the refusal", async () => {
    stubApi({ "GET /api/outreach/today": () => ({ status: 403, body: { error: "owner_only" } }) });
    renderSignedIn(<Outreach />, MEMBER);
    expect(await screen.findByText("Only the owner can do that.")).toBeInTheDocument();
  });
});
