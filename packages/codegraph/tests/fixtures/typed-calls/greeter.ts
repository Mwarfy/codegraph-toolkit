export interface GreetOptions {
  name: string
  enthusiastic?: boolean
}

export class Greeter {
  private prefix: string

  constructor(prefix: string) {
    this.prefix = prefix
  }

  greet(opts: GreetOptions): string {
    const suffix = opts.enthusiastic ? '!' : '.'
    return `${this.prefix} ${opts.name}${suffix}`
  }
}
