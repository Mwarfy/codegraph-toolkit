// VIOLATION truth-point : un fichier qui write/read une "table" via
// pg-style API. Le détecteur cherche les patterns INSERT/UPDATE/SELECT
// avec une table de référence.

interface Db { query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> }

export async function recordEvent(db: Db, eventType: string, payload: object): Promise<void> {
  // Writer : INSERT INTO events
  await db.query('INSERT INTO events (type, payload, created_at) VALUES ($1, $2, NOW())',
    [eventType, JSON.stringify(payload)])
}

export async function fetchRecentEvents(db: Db, limit: number): Promise<unknown[]> {
  // Reader : SELECT FROM events
  const r = await db.query('SELECT type, payload, created_at FROM events ORDER BY created_at DESC LIMIT $1',
    [limit])
  return r.rows
}
