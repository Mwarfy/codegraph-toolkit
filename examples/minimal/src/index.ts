import { formatGreeting } from './greeting.js'

const name = process.argv[2] ?? ''
console.log(formatGreeting(name))
