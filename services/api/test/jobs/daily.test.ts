import { describe, expect, it } from "vitest";
import { daily } from "../../src/jobs/daily.js";

describe("the parts of the daily job", () => {
  it("runs a later part when an earlier one fails, and still reports the failure", async () => {
    const ran: string[] = [];
    const run = daily(
      async () => {
        ran.push("clients");
        throw new Error("Cognito did not answer.");
      },
      async () => {
        ran.push("watches");
      },
    );
    await expect(run).rejects.toThrow("Cognito did not answer.");
    expect(ran).toEqual(["clients", "watches"]);
  });

  it("ends with no error when each part ends", async () => {
    await expect(daily(async () => 1, async () => 2)).resolves.toBeUndefined();
  });
});
