import { listen, query } from './event-bus.js'

interface ApprovalPayload {
  id: string
  decision: 'approved' | 'rejected'
}

export async function auditApproval(payload: ApprovalPayload): Promise<void> {
  await query(`INSERT INTO decision_journal (ref_id, decision) VALUES ($1, $2)`, [payload.id, payload.decision])
}

// Listener nommé — doit créer un entry event-listener résolvable via BFS.
listen('approval.resolved', auditApproval as (p: unknown) => void)
