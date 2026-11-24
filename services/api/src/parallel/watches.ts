import { log } from "../log.js";
import { Refusal } from "../mcp/registry.js";
import type { Item, Table } from "../store/table.js";
import type { MonitorFrequency, MonitorProcessor, ParallelClient } from "./client.js";

/** The studio keeps at most this many watches running, so that their cost stays small and known. */
export const WATCHES_MAX = 5;

export interface Watch {
  monitorId: string;
  query: string;
  frequency: MonitorFrequency;
  processor: MonitorProcessor;
  startedAt: string;
  /** The studio cancels the watch after this moment. */
  endsAt: string;
  by: string;
  status: "active" | "stopped";
}

const PK = "WATCH";
type WatchItem = Item & Watch;
const view = ({ monitorId, query, frequency, processor, startedAt, endsAt, by, status }: WatchItem): Watch => ({ monitorId, query, frequency, processor, startedAt, endsAt, by, status });

/**
 * The watches the studio has started at Parallel. A watch runs at Parallel on its own schedule and is
 * charged for each run, so each one has an end: its whole life is held in the ledger at its start, and
 * the daily job cancels it when that life is over.
 */
export class Watches {
  constructor(
    private readonly table: Table,
    private readonly parallel: ParallelClient,
    private readonly now: () => Date,
  ) {}

  async list(): Promise<Watch[]> {
    return (await this.table.query<WatchItem>(PK)).map(view).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  }

  async start(input: { query: string; frequency: MonitorFrequency; processor: MonitorProcessor; days: number; by: string }): Promise<Watch> {
    const live = (await this.list()).filter((watch) => watch.status === "active").length;
    if (live >= WATCHES_MAX) throw new Refusal(`The studio runs ${WATCHES_MAX} watches already. Stop one with watch_stop first.`);
    const { monitorId } = await this.parallel.monitorStart(input);
    const started = this.now();
    const watch: Watch = {
      monitorId,
      query: input.query,
      frequency: input.frequency,
      processor: input.processor,
      startedAt: started.toISOString(),
      endsAt: new Date(started.getTime() + input.days * 24 * 60 * 60 * 1000).toISOString(),
      by: input.by,
      status: "active",
    };
    await this.table.put({ pk: PK, sk: monitorId, ...watch });
    return watch;
  }

  private async get(monitorId: string): Promise<WatchItem> {
    const item = await this.table.get<WatchItem>(PK, monitorId);
    if (!item) throw new Refusal(`The studio started no watch ${monitorId}. watch_list gives its watches.`);
    return item;
  }

  /** Only a watch the studio started is read: an id from elsewhere is refused before any call. */
  async events(monitorId: string, limit: number) {
    await this.get(monitorId);
    return this.parallel.monitorEvents(monitorId, limit);
  }

  async stop(monitorId: string): Promise<Watch> {
    const item = await this.get(monitorId);
    if (item.status === "stopped") return view(item);
    await this.parallel.monitorCancel(monitorId);
    const stopped = { ...item, status: "stopped" as const };
    await this.table.put(stopped);
    return view(stopped);
  }

  /** Cancels each watch whose life is over. One that cannot be cancelled now stays active for the next run. */
  async stopExpired(): Promise<string[]> {
    const at = this.now().toISOString();
    const stopped: string[] = [];
    let failed = 0;
    for (const watch of await this.list()) {
      if (watch.status !== "active" || watch.endsAt > at) continue;
      try {
        await this.stop(watch.monitorId);
        stopped.push(watch.monitorId);
      } catch {
        failed += 1;
      }
    }
    log.info("watches_stopped", { stopped: stopped.length, failed });
    return stopped;
  }
}
