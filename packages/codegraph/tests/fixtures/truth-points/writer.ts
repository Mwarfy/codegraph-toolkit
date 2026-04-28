// Écrit dans la table `trust_scores` et miroir Redis `trust:*`.
declare const redis: {
  set: (key: string, value: string, flag?: string, ttl?: number) => Promise<string>
  setex: (key: string, ttl: number, value: string) => Promise<string>
}
declare function query(sql: string, params?: unknown[]): Promise<unknown>

export async function persistTrustScore(
  blockType: string,
  toolName: string,
  value: number,
): Promise<void> {
  await query(
    `INSERT INTO trust_scores (block_type, tool_name, value) VALUES ($1, $2, $3)
     ON CONFLICT DO UPDATE SET value = $3`,
    [blockType, toolName, value],
  )
  await redis.set(`trust:${blockType}:${toolName}`, String(value), 'EX', 30)
}

export async function resetTrust(blockType: string, toolName: string): Promise<void> {
  await query(`DELETE FROM trust_scores WHERE block_type = $1 AND tool_name = $2`, [blockType, toolName])
}
