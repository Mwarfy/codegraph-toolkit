import { listen, query } from './event-bus.js'

// Handler d'event → trigger 'event:approval.submit' pour la transition "pending".
async function onSubmit(): Promise<void> {
  await query(`INSERT INTO approvals (id, status) VALUES ($1, 'pending')`, [1])
}

// Handler d'event → trigger 'event:approval.decide' pour approved/rejected.
async function onDecide(payload: { decision: 'approved' | 'rejected' }): Promise<void> {
  if (payload.decision === 'approved') {
    await query(`UPDATE approvals SET status = 'approved' WHERE id = $1`, [1])
  } else {
    await query(`UPDATE approvals SET status = 'rejected' WHERE id = $1`, [1])
  }
}

listen('approval.submit', onSubmit as (p: unknown) => void)
listen('approval.decide', onDecide as (p: unknown) => void)
