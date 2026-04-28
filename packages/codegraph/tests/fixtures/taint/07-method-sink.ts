// VIOLATION attendue : sink par méthode `.query(...)` avec arg tainted.
declare const req: any
declare const db: { query(s: string): any }

export function vuln7(): void {
  const id = req.params
  db.query(`SELECT * FROM users WHERE id='${id}'`)
}
