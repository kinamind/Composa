export async function claimLifecycleMaintenance(
  db: D1Database,
  name: string,
  now = new Date(),
): Promise<boolean> {
  const timestamp = now.toISOString();
  const inserted = await db.prepare(`
    INSERT OR IGNORE INTO lifecycle_maintenance_runs (name, status, started_at)
    VALUES (?, 'running', ?)
  `).bind(name, timestamp).run();
  if ((inserted.meta.changes ?? 0) > 0) return true;

  const staleBefore = new Date(now.getTime() - 30 * 60_000).toISOString();
  const reclaimed = await db.prepare(`
    UPDATE lifecycle_maintenance_runs
    SET status = 'running', started_at = ?, completed_at = NULL, error = NULL
    WHERE name = ? AND (
      status = 'failed' OR (status = 'running' AND started_at <= ?)
    )
  `).bind(timestamp, name, staleBefore).run();
  return (reclaimed.meta.changes ?? 0) > 0;
}

export async function completeLifecycleMaintenance(
  db: D1Database,
  name: string,
  now = new Date(),
): Promise<void> {
  await db.prepare(`
    UPDATE lifecycle_maintenance_runs
    SET status = 'completed', completed_at = ?, error = NULL
    WHERE name = ?
  `).bind(now.toISOString(), name).run();
}

export async function failLifecycleMaintenance(
  db: D1Database,
  name: string,
  error: string,
): Promise<void> {
  await db.prepare(`
    UPDATE lifecycle_maintenance_runs
    SET status = 'failed', error = ?
    WHERE name = ?
  `).bind(error.slice(0, 1_000), name).run();
}
