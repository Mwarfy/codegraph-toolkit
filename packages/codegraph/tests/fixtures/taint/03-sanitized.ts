// PAS de violation : req.body → validateBody → eval.
// Le sanitizer lave le retour.
declare const req: any
declare function validateBody(v: any): any
declare function eval(s: string): any

export function safe3(): void {
  const clean = validateBody(req.body)
  eval(clean)
}
