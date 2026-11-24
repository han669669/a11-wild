/**
 * Runs each part of the daily job, also when an earlier part failed: a client clean-up that fails must not
 * keep a watch from its end. The first failure is thrown after the last part, so the run still shows as failed.
 */
export async function daily(...parts: (() => Promise<unknown>)[]): Promise<void> {
  const failures: unknown[] = [];
  for (const part of parts) {
    try {
      await part();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw failures[0];
}
