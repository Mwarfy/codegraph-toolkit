/**
 * CLI command extraction template (P2a god-file split pattern).
 *
 * Pour extraire un command depuis cli/index.ts :
 *
 *   1. Créer cli/commands/<name>.ts qui exporte le handler :
 *
 *        export interface MyCommandOpts { foo?: string }
 *        export async function runMyCommand(opts: MyCommandOpts): Promise<void> {
 *          // logique action handler ici
 *        }
 *
 *   2. Dans cli/index.ts, garder UNIQUEMENT la registration :
 *
 *        program
 *          .command('my-command')
 *          .description('...')
 *          .option('--foo <s>', 'foo')
 *          .action(async (opts) => { await runMyCommand(opts) })
 *
 *   3. Ne pas oublier d'importer `runMyCommand` en haut.
 *
 * Test : pour les commands testables unitairement (pas d'I/O process.exit),
 * créer un test à côté : `cli/commands/<name>.test.ts`. Les commands avec
 * effets console.log sont testables via vi.spyOn(console, 'log').
 */
