// Concept 3 : WorkerStatus extrait via method-call writes (`this.updateX('Y')`).
// Vérifie que l'extracteur voit les writes qui passent par méthode d'instance
// et pas seulement par SQL/object literal.
export type WorkerStatus = 'idle' | 'busy' | 'error' | 'shutdown'

type Saver = { (status: string): Promise<void> }

export class Worker {
  private status: WorkerStatus = 'idle'

  constructor(private readonly save: Saver) {}

  // Written via method call — doit être détecté.
  async start(): Promise<void> {
    await this.updateStatus('busy')
  }

  async fail(): Promise<void> {
    await this.updateStatus('error')
  }

  async stop(): Promise<void> {
    // Shorter naming variant — must also match.
    await this.setStatus('shutdown')
  }

  // shouldn't match — two args, first is not string.
  async noise(x: number): Promise<void> {
    await this.save('idle')  // ← call sur `this.save`, pas sur updateX/setX
    void x
  }

  private async updateStatus(status: WorkerStatus): Promise<void> {
    this.status = status
    await this.save(status)
  }

  private async setStatus(status: WorkerStatus): Promise<void> {
    this.status = status
  }
}
