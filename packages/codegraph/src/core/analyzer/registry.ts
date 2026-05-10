// ADR-008
/**
 * Detector registry builder — extrait du god-file `core/analyzer.ts`
 * (split P3a). Centralise les ~17 imports de detector classes qui étaient
 * la principale source de couplage de analyzer.ts (106 imports).
 *
 * L'ordre d'enregistrement détermine l'ordre d'exécution dans le pipeline.
 * Cf. `analyzer.ts:runDeterministicDetectors` pour le run.
 */

import { DetectorRegistry } from '../detector-registry.js'
import { OauthScopeLiteralsDetector } from '../detectors/oauth-scope-literals-detector.js'
import { EventEmitSitesDetector } from '../detectors/event-emit-sites-detector.js'
import { EnvUsageDetector } from '../detectors/env-usage-detector.js'
import { PackageDepsDetector } from '../detectors/package-deps-detector.js'
import { BinShebangsDetector } from '../detectors/bin-shebangs-detector.js'
import { BarrelsDetector } from '../detectors/barrels-detector.js'
import { UnusedExportsDetector } from '../detectors/unused-exports-detector.js'
import { ComplexityDetector } from '../detectors/complexity-detector.js'
import { SymbolRefsDetector } from '../detectors/symbol-refs-detector.js'
import { TypedCallsDetector } from '../detectors/typed-calls-detector.js'
import { CyclesDetector } from '../detectors/cycles-detector.js'
import { TruthPointsDetector } from '../detectors/truth-points-detector.js'
import { DataFlowsDetector } from '../detectors/data-flows-detector.js'
import { StateMachinesDetector } from '../detectors/state-machines-detector.js'
import { TaintDetector } from '../detectors/taint-detector.js'
import { SqlSchemaDetector } from '../detectors/sql-schema-detector.js'
import { DrizzleSchemaDetector } from '../detectors/drizzle-schema-detector.js'

export function buildDetectorRegistry(): DetectorRegistry {
  return new DetectorRegistry()
    .register(new UnusedExportsDetector())
    .register(new ComplexityDetector())
    .register(new SymbolRefsDetector())
    .register(new TypedCallsDetector())
    .register(new CyclesDetector())
    .register(new TruthPointsDetector())
    .register(new DataFlowsDetector())
    .register(new StateMachinesDetector())
    .register(new EnvUsageDetector())
    .register(new PackageDepsDetector())
    .register(new BinShebangsDetector())
    .register(new BarrelsDetector())
    .register(new EventEmitSitesDetector())
    .register(new OauthScopeLiteralsDetector())
    .register(new TaintDetector())
    .register(new SqlSchemaDetector())
    .register(new DrizzleSchemaDetector())
}
