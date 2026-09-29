/**
 * Vitest globalSetup for the integration project (AC-VERIFY-17).
 *
 * Phase 1 skeleton: the template-database isolation (migrate `sgm_tpl_<runId>` once per run and clone
 * one database per worker) arrives with the migrations in Phase 3. Until then this is a no-op that
 * never touches a database, so `test:integration` passes with no integration tests present.
 */
export default function setup(): void {
  if (!process.env.DATABASE_URL) {
    return;
  }
  // TODO(Phase 3): create the template DB under an advisory lock and export its name to workers.
}
