import { SSMClient } from "@aws-sdk/client-ssm";
import { pruneClients } from "./jobs/prune-clients.js";
import { ParallelClient } from "./parallel/client.js";
import { Watches } from "./parallel/watches.js";
import { ParameterKeys } from "./secrets.js";
import { SpendLedger } from "./spend/ledger.js";
import { daily } from "./jobs/daily.js";
import { wireClients } from "./wire.js";

const ready = wireClients();

export const handler = async (): Promise<void> => {
  const { cognito, approvals, table } = await ready;
  await daily(
    () => pruneClients(cognito, approvals),
    async () => {
      // A watch runs at Parallel and is charged until it is cancelled, so its end is kept here and not in a session.
      const prefix = process.env.KEYS_PREFIX;
      if (!prefix) return;
      const now = () => new Date();
      const parallel = new ParallelClient(new ParameterKeys(new SSMClient({}), prefix), new SpendLedger(table, now));
      await new Watches(table, parallel, now).stopExpired();
    },
  );
};
