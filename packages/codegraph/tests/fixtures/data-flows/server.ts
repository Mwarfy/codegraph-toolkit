import { resolveApproval, type ResolveRequest } from './approval-service.js'

interface Req { body: ResolveRequest; path: string; method: string }
interface Res { json: (status: number, data: unknown) => void }

// Handler qui route selon path/method — pattern Sentinel.
export async function handleApprovalRoutes(
  req: Req,
  res: Res,
  path: string,
  method: string,
): Promise<boolean> {
  if (path === '/api/approvals/resolve' && method === 'POST') {
    await resolveApproval(req.body)
    res.json(200, { ok: true })
    return true
  }
  return false
}
