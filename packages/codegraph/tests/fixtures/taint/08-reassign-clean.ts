// PAS de violation : x est ré-assignée à une valeur propre avant le sink.
declare const req: any
declare function eval(s: string): any

export function safe8(): void {
  let x = req.body
  x = 'literal'
  eval(x)
}
