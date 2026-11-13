/**
 * The bounded export semaphore (tax-invoices-and-exports CR-3): at most ONE export per team and `maxConcurrent` exports in
 * this API process at a time. An export holds one pooled connection, one transaction and up to `INCOME_EXPORT_MAX_BYTES` of
 * output while it runs, so the bound keeps memory and the pool safe. A request that cannot get a slot is refused at once
 * (429 `export_busy`), never queued, so a slow export cannot pile up waiting requests.
 *
 * In-process by design (v1 runs one API process); a second process has its own bound, so the global bound is per process.
 */
export interface ExportSemaphore {
  /** A release function (idempotent) when a slot is free for this team, otherwise null. */
  tryAcquire(teamId: string): (() => void) | null;
  /** Exports currently holding a slot. */
  inFlight(): number;
}

export function createExportSemaphore(options: {
  readonly maxConcurrent: number;
}): ExportSemaphore {
  const busyTeams = new Set<string>();
  return {
    tryAcquire(teamId) {
      if (busyTeams.has(teamId) || busyTeams.size >= options.maxConcurrent) return null;
      busyTeams.add(teamId);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        busyTeams.delete(teamId);
      };
    },
    inFlight: () => busyTeams.size,
  };
}
