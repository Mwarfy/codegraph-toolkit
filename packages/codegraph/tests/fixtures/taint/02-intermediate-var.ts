// VIOLATION attendue : req.body → var x → eval (via alias).
declare const req: any
declare function eval(s: string): any

export function vuln2(): void {
  const x = req.body
  eval(x)
}
