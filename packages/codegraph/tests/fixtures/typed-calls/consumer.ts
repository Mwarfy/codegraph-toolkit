import { add, multiply, square } from './math.js'
import { Greeter, type GreetOptions } from './greeter.js'
import * as math from './math.js'

export function run(): string {
  const sum = add(1, 2)
  const product = multiply(sum, 3)
  const squared = square(product)
  const fromNs = math.add(10, 20)

  const greeter = new Greeter('Hello')
  const opts: GreetOptions = { name: 'World', enthusiastic: true }
  return greeter.greet(opts) + ` (score=${squared + fromNs})`
}

export const runOnce = (): number => add(100, 200)
