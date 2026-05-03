/**
 * Path resolver for the rules dir (consumed by datalog runners).
 * Phase α : 5 rules ship with the package under packages/runtime-graph/rules/
 *
 * Usage :
 *   import { rulesDir } from '@liby-tools/runtime-graph/rules'
 *   import { runFromDirs } from '@liby-tools/datalog'
 *   await runFromDirs({ rulesDir, factsDir: '/path/to/facts-runtime' })
 */

import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/**
 * Absolute path to the bundled rules directory.
 * In dev: <repo>/packages/runtime-graph/rules
 * In published package: <node_modules>/@liby-tools/runtime-graph/rules
 */
export const rulesDir = path.resolve(__dirname, '../../rules')
