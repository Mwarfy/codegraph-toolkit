// VIOLATION attendue : req.body → eval (direct source dans sink arg).
declare const req: any
declare function eval(s: string): any

export function vuln1(): void {
  eval(req.body)
}
