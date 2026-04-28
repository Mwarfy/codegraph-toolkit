// VIOLATION attendue : accès à une sous-prop de tainted → tainted.
declare const req: any
declare function execSync(s: string): any

export function vuln6(): void {
  const body = req.body
  execSync(body.cmd)
}
