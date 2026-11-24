import { randomBytes } from "node:crypto";
import { log } from "../log.js";
import { Refusal } from "../mcp/registry.js";
import type { Item, Table } from "../store/table.js";
import { ProviderError, type MonitorFrequency, type MonitorProcessor, type ParallelClient } from "./client.js";

/** The studio keeps at most this many watches running, so that their cost stays small and known. */
export const WATCHES_MAX = 5;

/** A start that Parallel never showed is dropped after this time, and its place is free again. */
const UNCONFIRMED_MS = 2 * 24 * 60 * 60 * 1000;

export interface Watch {
  /** Parallel's id. A watch at "starting" has none yet: Parallel did not answer its start. */
  monitorId?: string;
  query: string;
  frequency: MonitorFrequency;
  processor: MonitorProcessor;
  startedAt: string;
  /** The studio cancels the watch after this moment. */
  endsAt: string;
  by: string;
  status: "starting" | "active" | "stopped";
}

const PK = "WATCH";
/** A running watch holds one of the places, so two starts at one moment cannot both take the last one. */
const place = (n: number): string => `PLACE#${n}`;
const done = (monitorId: string): string => `DONE#${monitorId}`;
type WatchItem = Item & Watch & { watchId: string };
/** A place is used again after a stop. A change to a place is made only while it still holds the watch that was read. */
const still = (item: WatchItem) => ({ ifEquals: { attribute: "watchId", value: item.watchId } });
const view = ({ monitorId, query, frequency, processor, startedAt, endsAt, by, status }: WatchItem): Watch => ({ ...(monitorId ? { monitorId } : {}), query, frequency, processor, startedAt, endsAt, by, status });

/**
 * The watches the studio has started at Parallel. A watch runs at Parallel on its own schedule and is
 * charged for each run, so each one has an end: its whole life is held in the ledger at its start, and
 * the daily job cancels it when that life is over.
 *
 * A watch is written with its end before Parallel is asked, and Parallel keeps the studio's name for it.
 * So a start whose answer was lost, or whose record could not be written, is still found and still ends.
 */
export class Watches {
  constructor(
    private readonly table: Table,
    private readonly parallel: ParallelClient,
    private readonly now: () => Date,
  ) {}

  private async items(): Promise<WatchItem[]> {
    const all = await this.table.query<WatchItem>(PK);
    const stopped = new Set(all.filter((item) => item.status === "stopped").map((item) => item.monitorId));
    // A stop writes the stopped record, then frees the place. Between the two, the stopped record is the true one.
    return all.filter((item) => item.status === "stopped" || !item.monitorId || !stopped.has(item.monitorId));
  }

  async list(): Promise<Watch[]> {
    return (await this.items()).map(view).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  }

  async start(input: { query: string; frequency: MonitorFrequency; processor: MonitorProcessor; days: number; by: string }): Promise<Watch> {
    const started = this.now();
    const item: WatchItem = {
      pk: PK,
      sk: "",
      watchId: randomBytes(12).toString("hex"),
      query: input.query,
      frequency: input.frequency,
      processor: input.processor,
      startedAt: started.toISOString(),
      endsAt: new Date(started.getTime() + input.days * 24 * 60 * 60 * 1000).toISOString(),
      by: input.by,
      status: "starting",
    };
    for (let n = 1; n <= WATCHES_MAX && !item.sk; n += 1) {
      if (await this.table.put({ ...item, sk: place(n) }, { ifNotExists: true })) item.sk = place(n);
    }
    if (!item.sk) throw new Refusal(`The studio runs ${WATCHES_MAX} watches already. Stop one with watch_stop first.`);
    let monitorId: string;
    try {
      ({ monitorId } = await this.parallel.monitorStart({ ...input, watchId: item.watchId }));
    } catch (error) {
      // Only an outcome that is not known keeps its place: Parallel may run the watch, and the daily job looks for it.
      if (!(error instanceof ProviderError)) await this.table.delete(PK, item.sk, still(item));
      throw error;
    }
    const active: WatchItem = { ...item, monitorId, status: "active" };
    if (!(await this.table.put(active, still(item)))) {
      // The place was freed before Parallel answered, and it may hold another watch now. That one stays. This one ends here, or at the next daily job.
      await this.parallel.monitorCancel(monitorId).catch(() => undefined);
      throw new Refusal("Parallel answered this start late, and the studio no longer keeps its place. The watch is cancelled. Start it again if you still want it.");
    }
    return view(active);
  }

  private async get(monitorId: string): Promise<WatchItem> {
    const item = (await this.items()).find((entry) => entry.monitorId === monitorId);
    if (!item) throw new Refusal(`The studio started no watch ${monitorId}. watch_list gives its watches.`);
    return item;
  }

  /** Only a watch the studio started is read: an id from elsewhere is refused before any call. */
  async events(monitorId: string, limit: number, cursor?: string) {
    await this.get(monitorId);
    return this.parallel.monitorEvents(monitorId, limit, cursor);
  }

  async stop(monitorId: string): Promise<Watch> {
    const item = await this.get(monitorId);
    if (item.status === "stopped") return view(item);
    await this.parallel.monitorCancel(monitorId);
    const stopped: WatchItem = { ...item, sk: done(monitorId), status: "stopped" };
    await this.table.put(stopped);
    await this.table.delete(PK, item.sk, still(item));
    return view(stopped);
  }

  /**
   * Makes the studio's list and Parallel's agree. A start that Parallel shows becomes a watch with its end.
   * A monitor that carries the studio's name and that the studio does not keep is cancelled: nothing would end it.
   * A monitor with no name of the studio was made elsewhere and is left alone.
   */
  private async reconcile(): Promise<{ adopted: number; dropped: number; orphans: number }> {
    const counts = { adopted: 0, dropped: 0, orphans: 0 };
    // Parallel is asked on each run, also when the studio keeps no watch: a monitor with the studio's name and no record here would run with no end.
    const running = await this.parallel.monitorList();
    // Read after Parallel's list. A start writes its record before it asks Parallel, so each monitor of that list that the studio keeps is in this read.
    const all = await this.table.query<WatchItem>(PK);
    const at = this.now().getTime();
    // A place whose stopped record is written is only left over from a stop that was cut short.
    for (const item of all) {
      if (item.status !== "stopped" && item.monitorId && all.some((other) => other.status === "stopped" && other.monitorId === item.monitorId)) await this.table.delete(PK, item.sk, still(item));
    }
    for (const item of all.filter((entry) => entry.status === "starting")) {
      const found = running.find((monitor) => monitor.watchId === item.watchId);
      if (found) {
        if (await this.table.put({ ...item, monitorId: found.monitorId, status: "active" }, still(item))) counts.adopted += 1;
      } else if (at - Date.parse(item.startedAt) > UNCONFIRMED_MS) {
        if (await this.table.delete(PK, item.sk, still(item))) counts.dropped += 1;
      }
    }
    const kept = new Set(all.filter((item) => item.status !== "stopped").map((item) => item.watchId));
    for (const monitor of running) {
      if (!monitor.watchId || kept.has(monitor.watchId)) continue;
      try {
        await this.parallel.monitorCancel(monitor.monitorId);
        counts.orphans += 1;
      } catch {
        // The next run tries again.
      }
    }
    return counts;
  }

  /** Cancels each watch whose life is over. One that cannot be cancelled now stays active for the next run. */
  async stopExpired(): Promise<string[]> {
    let agreed = { adopted: 0, dropped: 0, orphans: 0 };
    let agreedOk = true;
    try {
      agreed = await this.reconcile();
    } catch {
      agreedOk = false;
    }
    const at = this.now().toISOString();
    const stopped: string[] = [];
    let failed = 0;
    for (const watch of await this.list()) {
      if (watch.status !== "active" || !watch.monitorId || watch.endsAt > at) continue;
      try {
        await this.stop(watch.monitorId);
        stopped.push(watch.monitorId);
      } catch {
        failed += 1;
      }
    }
    log.info("watches_stopped", { stopped: stopped.length, failed, agreedOk, ...agreed });
    return stopped;
  }
}
