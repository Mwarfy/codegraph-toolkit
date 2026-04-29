#!/usr/bin/env node

/**
 * `datalog` CLI.
 *
 * Commands :
 *   datalog run <rules-dir> --facts <facts-dir>     Run all .dl + .facts
 *                                                    Print outputs (deterministic)
 *   datalog run <rules-dir> --facts <facts-dir> --proofs <Rel>
 *                                                    Also print proof trees
 *   datalog parse <file.dl>                          Parse + dump AST stats
 */

import { Command } from 'commander'
import chalk from 'chalk'
import * as fs from 'node:fs/promises'
import { runFromDirs, formatRunResult } from './runner.js'
import { parse } from './parser.js'
import { DatalogError } from './types.js'

const program = new Command()

program
  .name('datalog')
  .description('Pure-TS Datalog interpreter for codegraph invariants')
  .version('0.1.0')

program
  .command('run')
  .description('Evaluate .dl rules against .facts inputs and print outputs')
  .argument('<rules-dir>', 'Directory containing .dl files (lex-sorted, merged)')
  .requiredOption('-f, --facts <dir>', 'Directory containing .facts (TSV)')
  .option('-p, --proofs <rel...>', 'Relations to record proofs for (e.g. -p Violation)')
  .option('--json', 'Output as JSON instead of canonical text')
  .option('--exit-on-output', 'Exit with code 1 if any .output relation has tuples')
  .action(async (rulesDir: string, opts) => {
    const proofs: string[] = opts.proofs ?? []
    try {
      const opt: Parameters<typeof runFromDirs>[0] = {
        rulesDir, factsDir: opts.facts,
      }
      if (proofs.length > 0) opt.recordProofsFor = proofs
      const { result } = await runFromDirs(opt)

      if (opts.json) {
        const out: Record<string, unknown> = {
          outputs: Object.fromEntries(
            [...result.outputs].map(([k, v]) => [k, v]),
          ),
          stats: result.stats,
        }
        if (result.proofs) {
          out.proofs = Object.fromEntries(
            [...result.proofs].map(([k, m]) => [k, [...m.values()]]),
          )
        }
        console.log(JSON.stringify(out, null, 2))
      } else {
        const fmtOpts: { withProofsFor?: string[] } = {}
        if (proofs.length > 0) fmtOpts.withProofsFor = proofs
        process.stdout.write(formatRunResult(result, fmtOpts))
      }

      if (opts.exitOnOutput) {
        const total = [...result.outputs.values()].reduce((s, t) => s + t.length, 0)
        process.exit(total > 0 ? 1 : 0)
      }
    } catch (e) {
      handleError(e)
    }
  })

program
  .command('parse')
  .description('Parse a .dl file and print AST stats')
  .argument('<file>', 'Path to .dl file')
  .action(async (file: string) => {
    try {
      const src = await fs.readFile(file, 'utf-8')
      const prog = parse(src, { source: file })
      console.log(chalk.bold(`\n  ${file}`))
      console.log(`  ${prog.decls.size} decl(s), ${prog.rules.length} rule(s), ${prog.inlineFacts.length} inline fact(s)`)
      const inputs = [...prog.decls.values()].filter((d) => d.isInput).map((d) => d.name)
      const outputs = [...prog.decls.values()].filter((d) => d.isOutput).map((d) => d.name)
      console.log(`  inputs:  ${inputs.sort().join(', ') || '<none>'}`)
      console.log(`  outputs: ${outputs.sort().join(', ') || '<none>'}\n`)
    } catch (e) {
      handleError(e)
    }
  })

function handleError(e: unknown): never {
  if (e instanceof DatalogError) {
    console.error(chalk.red(e.format()))
  } else {
    console.error(chalk.red(String(e)))
  }
  process.exit(2)
}

program.parse()
