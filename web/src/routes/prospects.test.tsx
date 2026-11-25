import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { prospectRow } from "@/outreach-fixtures";
import { renderSignedIn, stubApi } from "@/test-helpers";
import { Prospects } from "./prospects";

const count = (all: number, tiers: [number, number, number], channels: [number, number]) => ({ all, byTier: { "20+": tiers[0], "5-19": tiers[1], "<5": tiers[2] }, byChannel: { whatsapp: channels[0], email: channels[1] } });
const page = (rows = [prospectRow(), prospectRow({ id: "00002", n: 2, brand: "Glow Lab", sector: "Beauty", stage: "contacted", next: { step: 1, due: "2026-11-26" }, sameContactAs: "Koi Tea" })]) => ({
  numbers: { prospects: 857, sent: count(12, [7, 4, 1], [9, 3]), replied: count(3, [2, 1, 0], [2, 1]), saidMore: count(1, [1, 0, 0], [1, 0]), optedOut: count(2, [0, 2, 0], [2, 0]), clients: count(0, [0, 0, 0], [0, 0]) },
  sectors: ["Beauty", "F&B"],
  rows,
});

describe("Prospects page", () => {
  it("shows the numbers by tier and by channel, and each brand without a number or an address", async () => {
    stubApi({ "GET /api/outreach/prospects": () => ({ body: page() }) });
    renderSignedIn(<Prospects />);
    await userEvent.click(await screen.findByRole("button", { name: /^Numbers of the campaign/ }));
    const sent = within((await screen.findByRole("rowheader", { name: "Sent" })).closest("tr")!);
    expect(sent.getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["12", "7", "4", "1", "9", "3"]);
    expect(screen.getByRole("link", { name: "Koi Tea" })).toHaveAttribute("href", "/outreach/prospects/00001");
    expect(screen.getByText(/Follow-up 1 is due Thu, 26 Nov 2026\. Same contact as Koi Tea\./)).toBeInTheDocument();
  });

  it("sends the search and each filter to the server", async () => {
    const calls = stubApi({
      "GET /api/outreach/prospects": () => ({ body: page() }),
      "GET /api/outreach/prospects?stage=lost": () => ({ body: page([]) }),
      "GET /api/outreach/prospects?stage=lost&sector=Beauty": () => ({ body: page([]) }),
    });
    renderSignedIn(<Prospects />);
    await userEvent.selectOptions(await screen.findByLabelText("Stage"), "Lost");
    expect(await screen.findByText("No brand fits the search and the filters.")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Sector"), "Beauty");
    await waitFor(() => expect(calls).toContain("GET /api/outreach/prospects?stage=lost&sector=Beauty"));
  });

  it("filters tired ads and shows the list flags in plain words", async () => {
    const marked = prospectRow({ staleDays: 42, flags: { duplicate: true, blocked: true, check: true } });
    const fresh = prospectRow({ id: "00002", n: 2, brand: "Fresh Bakery", staleDays: 5 });
    const calls = stubApi({
      "GET /api/outreach/prospects": () => ({ body: page([marked, fresh]) }),
      "GET /api/outreach/prospects?tired=true": () => ({ body: page([marked]) }),
    });
    renderSignedIn(<Prospects />);
    await userEvent.click(await screen.findByLabelText("Tired ads (30+ days)"));
    await waitFor(() => expect(calls).toContain("GET /api/outreach/prospects?tired=true"));
    expect(screen.queryByRole("link", { name: "Fresh Bakery" })).not.toBeInTheDocument();
    expect(screen.getByText("Possible duplicate")).toBeInTheDocument();
    expect(screen.getByText("Do not send")).toBeInTheDocument();
    expect(screen.getByText("Check how to reach it")).toBeInTheDocument();
    expect(screen.getByText("Tired ads")).toBeInTheDocument();
  });

  it("makes a test prospect with the contact he gives", async () => {
    let sent: unknown;
    stubApi({ "GET /api/outreach/prospects": () => ({ body: page() }), "POST /api/outreach/test-prospect": (body) => ((sent = body), { body: { id: "T1" } }) });
    renderSignedIn(<Prospects />);
    await userEvent.click(await screen.findByRole("button", { name: "Try the pages with a test prospect" }));
    await userEvent.type(await screen.findByLabelText(/Or your own address/), "me@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Make a test prospect" }));
    await waitFor(() => expect(sent).toEqual({ email: "me@example.com" }));
  });

  it("lists the brands that wait for him first, and draws a long list fifty at a time", async () => {
    const many = Array.from({ length: 120 }, (_, index) => prospectRow({ id: String(index + 1).padStart(5, "0"), n: index + 1, brand: `Brand ${index + 1}`, stage: index === 99 ? "pick_waits" : index === 70 ? "replied" : "new" }));
    stubApi({ "GET /api/outreach/prospects": () => ({ body: page(many) }) });
    renderSignedIn(<Prospects />);
    expect(await screen.findByText("Replies and the brands that wait for you are listed first")).toBeInTheDocument();
    const names = () => screen.getAllByRole("link", { name: /^Brand / }).map((link) => link.textContent);
    expect(names().slice(0, 4)).toEqual(["Brand 71", "Brand 100", "Brand 1", "Brand 2"]);
    expect(names()).toHaveLength(50);
    await userEvent.click(screen.getByRole("button", { name: "Show 50 more of 70" }));
    expect(names()).toHaveLength(100);
    await userEvent.click(screen.getByRole("button", { name: "Show 20 more of 20" }));
    expect(names()).toHaveLength(120);
    expect(screen.queryByRole("button", { name: /^Show/ })).not.toBeInTheDocument();
  });
});
