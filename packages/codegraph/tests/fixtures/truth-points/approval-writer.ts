// Concept parallèle : `approvals` — permet de vérifier qu'on isole bien deux concepts.
declare function query(sql: string, params?: unknown[]): Promise<unknown>

export async function createApproval(id: string): Promise<void> {
  await query(`INSERT INTO approvals (id, status) VALUES ($1, 'pending')`, [id])
}

export async function getApproval(id: string): Promise<unknown> {
  return query(`SELECT * FROM approvals WHERE id = $1`, [id])
}
