// ADR-001: singleton state service

export class StateService {
  private static instance: StateService | null = null
  private state: Record<string, unknown> = {}

  private constructor() {}

  static getInstance(): StateService {
    if (!StateService.instance) {
      StateService.instance = new StateService()
    }
    return StateService.instance
  }

  get(key: string): unknown {
    return this.state[key]
  }

  set(key: string, value: unknown): void {
    this.state[key] = value
  }
}

export function getInstance(): StateService {
  return StateService.getInstance()
}
