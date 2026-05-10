/**
 * Inline test cases pour les rules Datalog — pattern Glean.
 *
 * Chaque entrée du tableau TESTS porte :
 *   - un nom descriptif (lisible comme spec)
 *   - la rule TS string (importée depuis rules/index.ts — source canonique)
 *   - les input facts (Map relName → tuples)
 *   - les expected outputs (Map outputRelName → tuples)
 *
 * Le test compose `SCHEMA_DL + rule`, applique les facts, compare les outputs.
 * Permet d'ajouter une assertion comportementale à n'importe quelle rule en
 * 6 lignes, sans setup ts-morph (différent des tests d'extracteur AST qui
 * couvrent un autre axe : visitor → facts).
 *
 * Pattern inspiré de Glean (Meta) : tests colocalisés à la définition de
 * la rule, runnables en isolation. cf. ADR-026 (Datalog rules) + ADR-027
 * (vues dérivées, références Glean).
 */

import { describe, expect, it } from 'vitest'
import { runFromString } from '@liby-tools/datalog'
import {
  SCHEMA_DL,
  MAGIC_NUMBERS_DL,
  DEAD_CODE_IDENTICAL_DL,
} from '../src/datalog-detectors/rules/index.js'

interface RuleTest {
  name: string
  rule: string
  facts: Record<string, Array<Array<string | number>>>
  expect: Record<string, Array<Array<string | number>>>
}

// Tuple shape NumericLiteralAst (cf. _schema.dl) :
//   [file, line, valueText, valueAbs, parentKind, parentName, parentArgIdx,
//    isScreamingSnake, isRatio, isTrivial]
const TESTS: RuleTest[] = [
  // ─── MAGIC_NUMBERS_DL ────────────────────────────────────────────────
  {
    name: 'MAGIC_NUMBERS / Rule 1: setInterval(fn, 30000) → timeout',
    rule: MAGIC_NUMBERS_DL,
    facts: {
      NumericLiteralAst: [
        ['a.ts', 1, '30000', 30000, 'CallExpression', 'setInterval', 1, 0, 0, 0],
      ],
      TimeoutFnName: [['setInterval']],
    },
    expect: {
      MagicNumber: [['a.ts', 1, '30000', 'setInterval', 'timeout']],
    },
  },
  {
    name: 'MAGIC_NUMBERS / FileTag=test → skip',
    rule: MAGIC_NUMBERS_DL,
    facts: {
      NumericLiteralAst: [
        ['c.test.ts', 1, '30000', 30000, 'CallExpression', 'setInterval', 1, 0, 0, 0],
      ],
      TimeoutFnName: [['setInterval']],
      FileTag: [['c.test.ts', 'test']],
    },
    expect: { MagicNumber: [] },
  },
  {
    name: 'MAGIC_NUMBERS / Rule 2: large-int dans call non-timeout',
    rule: MAGIC_NUMBERS_DL,
    facts: {
      NumericLiteralAst: [
        ['d.ts', 2, '5000', 5000, 'CallExpression', 'customFn', 1, 0, 0, 0],
      ],
      TimeoutFnName: [['setInterval']],
    },
    expect: {
      MagicNumber: [['d.ts', 2, '5000', 'customFn', 'large-int']],
    },
  },
  {
    name: 'MAGIC_NUMBERS / Rule 3: PropertyAssignment timeout',
    rule: MAGIC_NUMBERS_DL,
    facts: {
      NumericLiteralAst: [
        ['e.ts', 3, '5000', 5000, 'PropertyAssignment', 'timeout', 0, 0, 0, 0],
      ],
      TimeoutPropertyName: [['timeout'], ['delay']],
    },
    expect: {
      MagicNumber: [['e.ts', 3, '5000', 'timeout', 'timeout']],
    },
  },
  {
    name: 'MAGIC_NUMBERS / Rule 4: PropertyAssignment threshold',
    rule: MAGIC_NUMBERS_DL,
    facts: {
      NumericLiteralAst: [
        ['f.ts', 4, '100', 100, 'PropertyAssignment', 'threshold', 0, 0, 0, 0],
      ],
      ThresholdPropertyName: [['threshold'], ['limit']],
    },
    expect: {
      MagicNumber: [['f.ts', 4, '100', 'threshold', 'threshold']],
    },
  },
  {
    name: 'MAGIC_NUMBERS / Rule 5: ratio (isRatio=1) en PropertyAssignment',
    rule: MAGIC_NUMBERS_DL,
    facts: {
      NumericLiteralAst: [
        ['g.ts', 5, '0.5', 1, 'PropertyAssignment', 'rate', 0, 0, 1, 0],
      ],
    },
    expect: {
      MagicNumber: [['g.ts', 5, '0.5', 'rate', 'ratio']],
    },
  },
  {
    name: 'MAGIC_NUMBERS / Rule 7: VariableDeclaration SCREAMING_SNAKE skipped',
    rule: MAGIC_NUMBERS_DL,
    facts: {
      NumericLiteralAst: [
        ['h.ts', 6, '5000', 5000, 'VariableDeclaration', 'MAX_TIMEOUT', 0, 1, 0, 0],
      ],
    },
    expect: { MagicNumber: [] },
  },
  {
    name: 'MAGIC_NUMBERS / Rule 7: VariableDeclaration lowercase → large-int',
    rule: MAGIC_NUMBERS_DL,
    facts: {
      NumericLiteralAst: [
        ['i.ts', 7, '5000', 5000, 'VariableDeclaration', 'timeout', 0, 0, 0, 0],
      ],
    },
    expect: {
      MagicNumber: [['i.ts', 7, '5000', 'timeout', 'large-int']],
    },
  },
  {
    name: 'MAGIC_NUMBERS / isTrivial=1 sur tous types → skip',
    rule: MAGIC_NUMBERS_DL,
    facts: {
      NumericLiteralAst: [
        ['j.ts', 8, '0', 0, 'CallExpression', 'setInterval', 1, 0, 0, 1],
        ['j.ts', 9, '5000', 5000, 'VariableDeclaration', 'timeout', 0, 0, 0, 1],
      ],
      TimeoutFnName: [['setInterval']],
    },
    expect: { MagicNumber: [] },
  },

  // ─── DEAD_CODE_IDENTICAL_DL ──────────────────────────────────────────
  // Tuple BinaryExpressionAst : [file, line, op, leftText, rightText, leftIsShortLiteral]
  {
    name: 'DEAD_CODE / x == x → identical-subexpressions',
    rule: DEAD_CODE_IDENTICAL_DL,
    facts: {
      BinaryExpressionAst: [['a.ts', 1, '==', 'x', 'x', 0]],
      SuspectBinaryOp: [['=='], ['===']],
    },
    expect: {
      DeadCode: [
        ['a.ts', 1, 'identical-subexpressions',
          'expression avec les 2 cotes identiques — bug ou redondance', '==', 'x'],
      ],
    },
  },
  {
    name: 'DEAD_CODE / x == y (côtés différents) → pas de violation',
    rule: DEAD_CODE_IDENTICAL_DL,
    facts: {
      BinaryExpressionAst: [['a.ts', 1, '==', 'x', 'y', 0]],
      SuspectBinaryOp: [['==']],
    },
    expect: { DeadCode: [] },
  },
  {
    name: 'DEAD_CODE / FileTag=test + x == x → skip',
    rule: DEAD_CODE_IDENTICAL_DL,
    facts: {
      BinaryExpressionAst: [['a.test.ts', 1, '==', 'x', 'x', 0]],
      SuspectBinaryOp: [['==']],
      FileTag: [['a.test.ts', 'test']],
    },
    expect: { DeadCode: [] },
  },
  {
    name: 'DEAD_CODE / op non-suspect → skip',
    rule: DEAD_CODE_IDENTICAL_DL,
    facts: {
      BinaryExpressionAst: [['a.ts', 1, '+', 'x', 'x', 0]],
      SuspectBinaryOp: [['==']],
    },
    expect: { DeadCode: [] },
  },
  {
    name: 'DEAD_CODE / ExemptionLine matche → skip',
    rule: DEAD_CODE_IDENTICAL_DL,
    facts: {
      BinaryExpressionAst: [['a.ts', 42, '==', 'x', 'x', 0]],
      SuspectBinaryOp: [['==']],
      ExemptionLine: [['a.ts', 42, 'dead-code-ok']],
    },
    expect: { DeadCode: [] },
  },
]

describe('Datalog rules — inline test cases (pattern Glean)', () => {
  for (const t of TESTS) {
    it(t.name, () => {
      const program = SCHEMA_DL + '\n' + t.rule
      const facts = new Map(Object.entries(t.facts))
      const { result } = runFromString({ rules: program, facts })

      for (const [relName, expected] of Object.entries(t.expect)) {
        const actual = result.outputs.get(relName) ?? []
        const actualSorted = [...actual].map((row) => JSON.stringify(row)).sort()
        const expectedSorted = expected.map((row) => JSON.stringify(row)).sort()
        expect(actualSorted).toEqual(expectedSorted)
      }
    })
  }
})
