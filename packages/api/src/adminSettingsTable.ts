/**
 * Canonical DDL for admin_settings — used by index.js and adminExtras.js.
 */
export async function ensureAdminSettingsTable(db: any) {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS admin_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
  ).run()
}
