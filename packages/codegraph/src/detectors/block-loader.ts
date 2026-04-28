/**
 * Block Loader Detector — PROJECT-SPECIFIC (Sentinel)
 *
 * Détecte le pattern de dynamic loading utilisé par Sentinel :
 *   const BLOCK_CONSTRUCTORS: Record<string, ...> = {
 *     'web-scraper': WebScraperBlock,
 *     'browser': BrowserBlock,
 *     ...
 *   }
 *
 * Crée des edges `dynamic-load` depuis le fichier de registry vers chaque
 * implémentation. La résolution se fait par clé string au runtime.
 *
 * ⚠ NON inclus dans le default detector set (cf. detectors/index.ts).
 * Pour l'activer, l'ajouter explicitement dans `codegraph.config.json` :
 *   "detectors": ["ts-imports", "block-loader", ...]
 *
 * Hors Sentinel, ce détecteur ne matchera probablement rien — fail silencieux.
 */

import type { Detector, DetectorContext, DetectedLink } from '../core/types.js'

export class BlockLoaderDetector implements Detector {
  name = 'block-loader'
  edgeType = 'dynamic-load' as const
  description = 'Dynamic block constructor map lookups'

  async detect(ctx: DetectorContext): Promise<DetectedLink[]> {
    const links: DetectedLink[] = []

    // Find the block-runtime file (or any file with a constructor map pattern)
    const constructorMapPattern = /(?:const|let)\s+(\w+)\s*:\s*Record<string,\s*(?:new\s*\([^)]*\)\s*=>\s*\w+|typeof\s+\w+)>\s*=\s*\{([^}]+)\}/gs
    const entryPattern = /['"]([^'"]+)['"]\s*:\s*(\w+)/g

    for (const file of ctx.files) {
      if (!file.endsWith('.ts')) continue

      const content = await ctx.readFile(file)
      let mapMatch: RegExpExecArray | null

      constructorMapPattern.lastIndex = 0
      while ((mapMatch = constructorMapPattern.exec(content)) !== null) {
        const mapName = mapMatch[1]
        const mapBody = mapMatch[2]
        const mapLine = this.getLineNumber(content, mapMatch.index)

        // Extract each entry in the constructor map
        entryPattern.lastIndex = 0
        let entryMatch: RegExpExecArray | null
        while ((entryMatch = entryPattern.exec(mapBody)) !== null) {
          const blockType = entryMatch[1]
          const className = entryMatch[2]

          // Find which file this class is imported from
          const importFile = this.findImportSource(content, className, file, ctx)

          if (importFile) {
            links.push({
              from: file,
              to: importFile,
              type: 'dynamic-load',
              label: `${mapName}['${blockType}'] → ${className}`,
              resolved: true,
              line: mapLine,
              meta: {
                mapName,
                blockType,
                className,
              },
            })
          }
        }
      }
    }

    // Also detect dynamic import() patterns with variable paths
    const dynamicImportPattern = /import\(\s*`([^`]*\$\{[^}]+\}[^`]*)`\s*\)/g

    for (const file of ctx.files) {
      if (!file.endsWith('.ts')) continue

      const content = await ctx.readFile(file)
      let match: RegExpExecArray | null

      dynamicImportPattern.lastIndex = 0
      while ((match = dynamicImportPattern.exec(content)) !== null) {
        const template = match[1]
        const line = this.getLineNumber(content, match.index)

        // Try to resolve the template against known files
        const possibleTargets = this.resolveTemplate(template, ctx.files)

        for (const target of possibleTargets) {
          links.push({
            from: file,
            to: target,
            type: 'dynamic-load',
            label: `dynamic import: ${template}`,
            resolved: false, // template-based = uncertain
            line,
            meta: { template },
          })
        }
      }
    }

    return links
  }

  private findImportSource(
    fileContent: string,
    className: string,
    currentFile: string,
    ctx: DetectorContext
  ): string | null {
    // Look for: import { ClassName } from './path'
    const importPattern = new RegExp(
      `import\\s*\\{[^}]*\\b${className}\\b[^}]*\\}\\s*from\\s*['"]([^'"]+)['"]`
    )
    const match = importPattern.exec(fileContent)
    if (!match) return null

    const importPath = match[1]

    // Resolve relative import to actual file
    return this.resolveImportPath(importPath, currentFile, ctx.files)
  }

  private resolveImportPath(
    importSpec: string,
    fromFile: string,
    allFiles: string[]
  ): string | null {
    if (!importSpec.startsWith('.')) return null

    // Get directory of the importing file
    const fromDir = fromFile.split('/').slice(0, -1).join('/')
    const segments = importSpec.split('/')

    let resolved = fromDir
    for (const seg of segments) {
      if (seg === '.') continue
      if (seg === '..') {
        resolved = resolved.split('/').slice(0, -1).join('/')
      } else {
        resolved = resolved ? `${resolved}/${seg}` : seg
      }
    }

    // Try with common extensions
    const extensions = ['.ts', '.tsx', '.js', '/index.ts', '/index.js']
    for (const ext of extensions) {
      const candidate = resolved + ext
      if (allFiles.includes(candidate)) return candidate
    }

    // Try without .js extension (TS files imported as .js in ESM)
    const withoutJs = resolved.replace(/\.js$/, '.ts')
    if (allFiles.includes(withoutJs)) return withoutJs

    return null
  }

  private resolveTemplate(template: string, allFiles: string[]): string[] {
    // Convert template like './blocks/${blockType}' to a glob-ish pattern
    const pattern = template.replace(/\$\{[^}]+\}/g, '*')
    const prefix = pattern.split('*')[0]

    return allFiles.filter(f => {
      // Very basic matching: check if the file is in the right directory
      const normalized = f.toLowerCase()
      const prefixNormalized = prefix.replace(/^\.\//, '').toLowerCase()
      return normalized.includes(prefixNormalized)
    })
  }

  private getLineNumber(content: string, offset: number): number {
    return content.substring(0, offset).split('\n').length
  }
}
