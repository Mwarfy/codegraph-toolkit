// Concept TaskPhase : writes via object literal + property assignment.
// Route HTTP pour `queued` → trigger 'route:POST /api/tasks'.
// Init direct pour `running` (constructor).
// Inline property assignment pour `done`.

interface Task {
  id: string
  phase: string
}

interface Req { body: unknown }
interface Res { json: (s: number, d: unknown) => void }

export async function handleTaskRoutes(req: Req, res: Res, path: string, method: string): Promise<boolean> {
  if (path === '/api/tasks' && method === 'POST') {
    const task: Task = { id: '1', phase: 'queued' }
    res.json(200, task)
    return true
  }
  return false
}

export class TaskRunner {
  private task: Task

  constructor(id: string) {
    this.task = { id, phase: 'running' }
  }

  finish(): void {
    this.task.phase = 'done'
  }
}
