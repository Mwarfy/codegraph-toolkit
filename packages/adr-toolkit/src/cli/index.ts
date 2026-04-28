#!/usr/bin/env node
/**
 * @liby/adr-toolkit CLI
 *
 * Commands :
 *   init                           Scaffold un projet pour utiliser le toolkit
 *   regen [--check]                Régen `## Anchored in` depuis les marqueurs
 *   linker <file>                  Liste les ADRs qui couvrent ce fichier
 *   check-asserts [--json]         Asserts ts-morph (frontmatter YAML)
 *   brief                          Régénère le boot brief
 *   install-hooks                  Set core.hooksPath + chmod +x
 */

import { Command } from 'commander'
import { execSync } from 'node:child_process'
import { chmod, readdir } from 'node:fs/promises'
import * as path from 'node:path'
import chalk from 'chalk'
import { loadConfig } from '../config.js'
import { regenerateAnchors } from '../regenerate-anchors.js'
import { loadADRs, findAdrsForFile } from '../linker.js'
import { checkAsserts } from '../check-asserts.js'
import { generateBrief } from '../brief.js'
import { initProject } from '../init.js'

const program = new Command()
program
  .name('adr-toolkit')
  .description('ADR governance toolkit — anchors regen, linker, ts-morph asserts, brief')
  .version('0.1.0')

program
  .command('init')
  .description('Scaffold ADR toolkit dans le projet courant')
  .option('--with-claude-settings', 'Ajoute aussi .claude/settings.json avec le hook PreToolUse adr-hook', false)
  .action(async (opts) => {
    const result = await initProject(process.cwd(), {
      withClaudeSettings: !!opts.withClaudeSettings,
    })
    console.log(chalk.dim(`Layout détecté : ${result.layout}`))
    if (result.created.length > 0) {
      console.log(chalk.green('Created:'))
      for (const c of result.created) console.log(`  + ${c}`)
    }
    if (result.skipped.length > 0) {
      console.log(chalk.dim('Skipped (already present):'))
      for (const s of result.skipped) console.log(`  · ${s}`)
    }
    if (result.warnings.length > 0) {
      console.log(chalk.yellow('Warnings:'))
      for (const w of result.warnings) console.log(`  ⚠ ${w}`)
    }
    console.log('')
    console.log(chalk.bold('Next steps:'))
    console.log('  1. Crée ton premier ADR : copie docs/adr/_TEMPLATE.md → docs/adr/001-<slug>.md')
    console.log('  2. Pose // ADR-001 au top du fichier source ancré')
    console.log('  3. Run: npx adr-toolkit regen')
    console.log('  4. Run: npx codegraph analyze')
    console.log('  5. Run: npx adr-toolkit brief')
    console.log('  6. Commit — le pre-commit hook prendra le relais')
    if (!opts.withClaudeSettings) {
      console.log('')
      console.log(chalk.dim('💡 Pour activer le hook Claude Code (auto-injection ADR avant chaque Edit) :'))
      console.log(chalk.dim('   npx adr-toolkit init --with-claude-settings'))
    }
  })

program
  .command('regen')
  .description("Régénère ## Anchored in depuis les marqueurs // ADR-NNN du code")
  .option('--check', 'Fail si drift, ne réécrit pas (utilisé en CI)', false)
  .action(async (opts) => {
    const config = await loadConfig()
    const result = await regenerateAnchors({ config, checkOnly: !!opts.check })
    if (result.orphanAdrs.length > 0) {
      console.error(chalk.red(`✗ Marqueurs vers ADR(s) inexistant(s) : ${result.orphanAdrs.map(n => `ADR-${n}`).join(', ')}`))
      process.exit(1)
    }
    if (opts.check) {
      if (result.drift) {
        console.error(chalk.red(`✗ Drift détecté — run 'npx @liby/adr-toolkit regen' puis re-commit`))
        process.exit(1)
      }
      console.log(chalk.green(`✓ Anchors sync (${result.totalMarkers} marqueurs, ${result.adrsWithMarkers} ADRs)`))
      return
    }
    if (result.modified.length > 0) {
      console.log(chalk.green(`✓ ${result.modified.length} ADR(s) modifié(s) :`))
      for (const m of result.modified) console.log(`  · ${path.relative(config.rootDir, m)}`)
    } else {
      console.log(chalk.dim(`✓ Anchors déjà sync (${result.totalMarkers} marqueurs, ${result.adrsWithMarkers} ADRs)`))
    }
  })

program
  .command('linker')
  .description("Liste les ADRs qui couvrent un fichier")
  .argument('<file>', 'Path relatif à la racine du projet')
  .action(async (file: string) => {
    const config = await loadConfig()
    const adrs = await loadADRs(config)
    const hits = findAdrsForFile(file, adrs)
    if (hits.length === 0) {
      console.log(`No ADR mentions ${file} in its 'Anchored in' section.`)
      return
    }
    console.log(`# ADRs linked to ${file}\n`)
    for (const adr of hits) {
      console.log(`## ADR-${adr.num} — ${adr.title}`)
      console.log(`> ${adr.rule}`)
      console.log(`→ ${adr.file}\n`)
    }
  })

program
  .command('check-asserts')
  .description("Vérifie les asserts ts-morph (frontmatter YAML)")
  .option('--json', 'Output JSON', false)
  .action(async (opts) => {
    const config = await loadConfig()
    const result = await checkAsserts({ config })
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      console.log(`${result.passed}/${result.total} asserts ok`)
      for (const r of result.results.filter(r => !r.ok)) {
        console.error(chalk.red(`✗ ADR-${r.adr} ${r.symbol} : ${r.reason}`))
      }
      if (result.failed === 0 && result.total > 0) {
        console.log(chalk.green('✓ All ADR asserts hold.'))
      } else if (result.total === 0) {
        console.log(chalk.dim('No ADR has YAML frontmatter with asserts: skipping check.'))
      }
    }
    if (result.failed > 0) process.exit(1)
  })

program
  .command('brief')
  .description("Régénère le boot brief (CLAUDE-CONTEXT.md ou config.briefPath)")
  .action(async () => {
    const config = await loadConfig()
    const result = await generateBrief({
      config,
      customSections: config.briefCustomSections,
    })
    console.log(chalk.green(`✓ ${path.relative(config.rootDir, result.outputPath)} (${result.lineCount} lines, ${result.adrCount} ADRs, ${result.anchoredFileCount} anchored files, ${result.invariantTestCount} invariant tests)`))
  })

program
  .command('install-hooks')
  .description("Set git core.hooksPath + chmod +x sur scripts/git-hooks/*")
  .action(async () => {
    const cwd = process.cwd()
    const hooksDir = path.join(cwd, 'scripts/git-hooks')
    try {
      execSync('git config core.hooksPath scripts/git-hooks', { cwd, stdio: 'pipe' })
      console.log(chalk.green('✓ git config core.hooksPath = scripts/git-hooks'))
    } catch (err) {
      console.error(chalk.red(`✗ git config échoué : ${(err as Error).message}`))
      process.exit(1)
    }
    try {
      const entries = await readdir(hooksDir)
      for (const e of entries) {
        await chmod(path.join(hooksDir, e), 0o755)
      }
      console.log(chalk.green(`✓ chmod +x sur ${entries.length} hook(s)`))
    } catch (err) {
      console.error(chalk.yellow(`⚠ chmod échoué (hooksDir absent ?) : ${(err as Error).message}`))
    }
  })

program.parseAsync().catch((err) => {
  console.error(chalk.red(`adr-toolkit failed: ${err}`))
  process.exit(1)
})
