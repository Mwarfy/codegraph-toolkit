// PAS de violation : la var n'a jamais été tainted.
declare function eval(s: string): any

export function clean4(): void {
  const literal = 'const x = 1'
  eval(literal)
}
