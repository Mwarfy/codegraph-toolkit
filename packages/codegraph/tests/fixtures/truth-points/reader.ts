// Lit la table et expose un getter public.
declare function query<T>(sql: string, params?: unknown[]): Promise<T[]>

interface TrustRow {
  block_type: string
  tool_name: string
  value: number
}

export async function getTrustScore(
  blockType: string,
  toolName: string,
): Promise<number | null> {
  const rows = await query<TrustRow>(
    `SELECT value FROM trust_scores WHERE block_type = $1 AND tool_name = $2`,
    [blockType, toolName],
  )
  return rows[0]?.value ?? null
}

export const listTrustScores = async (): Promise<TrustRow[]> => {
  return query<TrustRow>(`SELECT * FROM trust_scores`)
}
