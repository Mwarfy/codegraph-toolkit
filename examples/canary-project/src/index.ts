// Entry point — imports good code only. Should NOT be flagged orphan
// (it's the convention root). Imports the hub so it shows up.
import { hub } from './bad/hub.js'
import { greet } from './good/greet.js'
import { compute } from './bad/cycle-a.js'
import { veryLongFunction } from './bad/long-function.js'

export function main(): string {
  return [greet('world'), hub(), compute(3), String(veryLongFunction(2))].join(' / ')
}
