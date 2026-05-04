// VIOLATION #8 — taint flow : req.body → eval() (sink critique sans sanitize).
//
// Détection attendue :
//   - TaintSink ≥ 1 (eval call)
//   - TaintedArgCall ≥ 1 (req.body atteint le sink)
//   - EvalCall ≥ 1

interface Req { body: { code: string } }

export function dangerouslyExec(req: Req): unknown {
  const userInput = req.body.code
  // taint source = req.body, sink = eval(), no sanitizer between → vulnérabilité
  return eval(userInput)
}
