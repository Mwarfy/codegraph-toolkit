// VIOLATION attendue : req.body → derive() → eval.
// derive() n'est pas un sanitizer déclaré → taint propagé (conservatif).
declare const req: any
declare function eval(s: string): any
declare function derive(x: any): any

export function vuln5(): void {
  const x = req.body
  const y = derive(x)
  eval(y)
}
