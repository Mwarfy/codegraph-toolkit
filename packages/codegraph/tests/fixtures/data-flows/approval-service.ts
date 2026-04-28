import { emit, query } from './event-bus.js'

export interface ResolveRequest {
  id: string
  decision: 'approved' | 'rejected'
}

export async function resolveApproval(req: ResolveRequest): Promise<void> {
  await query(`UPDATE approvals SET status = $1 WHERE id = $2`, [req.decision, req.id])
  emit('approval.resolved', { id: req.id, decision: req.decision })
}
