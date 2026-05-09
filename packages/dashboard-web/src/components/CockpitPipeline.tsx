import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import { store } from '../store.js'
import type { TelemetryRecord, TelemetrySummary } from '../lib/api.js'

export interface StagePin {
  x: number
  y: number
}

export type StagePins = Record<string, StagePin>

interface StageDef {
  id: string
  num: string
  label: string
  color: string
  hookKey: string
}

const STAGES: StageDef[] = [
  { id: 'pre', num: '01', label: 'PreToolUse', color: 'var(--cyan)', hookKey: 'PreToolUse' },
  { id: 'post', num: '02', label: 'PostToolUse', color: 'var(--green)', hookKey: 'PostToolUse' },
  { id: 'ctx', num: '03', label: 'ContextInjection', color: 'var(--yellow)', hookKey: 'UserPromptSubmit' },
  { id: 'stop', num: '04', label: 'Stop', color: 'var(--pink)', hookKey: 'Stop' },
]

function fmtBytes(n: number): string {
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB'
  return n + ' B'
}

function recentByHook(records: TelemetryRecord[]): Map<string, TelemetryRecord> {
  const out = new Map<string, TelemetryRecord>()
  for (const r of records) {
    if (!out.has(r.hook)) out.set(r.hook, r)
  }
  return out
}

function summaryForHook(summary: TelemetrySummary | undefined, hookKey: string): { count: number; tokens: number } | undefined {
  return summary?.byHook[hookKey]
}

interface StageCardProps {
  stage: StageDef
  rec: TelemetryRecord | undefined
  summary: { count: number; tokens: number } | undefined
  pinsHostRect: () => DOMRect | null
  registerPin: (id: string, pin: StagePin | null) => void
  onEnter: () => void
  onLeave: () => void
}

function StageCard(props: StageCardProps) {
  let ref: HTMLDivElement | undefined

  function update(): void {
    if (!ref) return
    const host = props.pinsHostRect()
    if (!host) {
      props.registerPin(props.stage.id, null)
      return
    }
    const r = ref.getBoundingClientRect()
    props.registerPin(props.stage.id, { x: r.left - host.left, y: r.top + r.height / 2 - host.top })
  }

  onMount(() => {
    update()
    const obs = new ResizeObserver(update)
    if (ref) obs.observe(ref)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    const id = window.setInterval(update, 250)
    onCleanup(() => {
      obs.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      clearInterval(id)
    })
  })

  return (
    <div
      ref={ref}
      onMouseEnter={props.onEnter}
      onMouseLeave={props.onLeave}
      class="relative cursor-crosshair"
      style={{
        padding: '8px 10px',
        border: '1px solid var(--bg-line)',
        'border-left': `3px solid ${props.stage.color}`,
        'border-radius': '3px',
        background: 'var(--bg-0)',
      }}
    >
      <div
        class="absolute"
        style={{
          left: '-4px',
          top: '50%',
          transform: 'translateY(-50%)',
          width: '8px',
          height: '8px',
          'border-radius': '50%',
          background: props.stage.color,
          'box-shadow': `0 0 8px ${props.stage.color}`,
        }}
      />
      <div class="flex items-baseline gap-1.5 mb-1">
        <span class="mono" style={{ 'font-size': '9.5px', color: 'var(--fg-3)', 'font-weight': 600 }}>
          {props.stage.num}
        </span>
        <span
          class="mono"
          style={{
            'font-size': '10.5px',
            color: props.stage.color,
            'font-weight': 600,
            'letter-spacing': '0.04em',
          }}
        >
          {props.stage.label}
        </span>
        <span class="flex-1" />
        <Show when={props.rec}>
          {(r) => (
            <span class="mono tnum" style={{ 'font-size': '9.5px', color: 'var(--fg-2)' }}>
              {fmtBytes(r().bytes)}
            </span>
          )}
        </Show>
      </div>
      <div class="mono" style={{ 'font-size': '10px', color: 'var(--fg-2)', 'line-height': 1.4 }}>
        <Show when={props.rec} fallback={<span>en attente…</span>}>
          {(r) => (
            <>
              <span style={{ color: 'var(--fg-3)' }}>{r().event}</span> · {r().file.split('/').slice(-2).join('/')}
            </>
          )}
        </Show>
      </div>
      <Show when={props.summary}>
        {(s) => (
          <div
            class="mono tnum mt-1 flex gap-2"
            style={{ 'font-size': '9px', color: 'var(--fg-3)' }}
          >
            <span>{s().count} runs</span>
            <span>{s().tokens.toLocaleString()} tok</span>
          </div>
        )}
      </Show>
    </div>
  )
}

interface CockpitPipelineProps {
  hostRect: () => DOMRect | null
  setPins: (pins: StagePins) => void
  setHoveredStage: (id: string | null) => void
  activeFile: string | null
  impactedFiles: string[]
}

export function CockpitPipeline(props: CockpitPipelineProps) {
  const pinsRef: StagePins = {}
  function registerPin(id: string, pin: StagePin | null): void {
    if (pin === null) {
      delete pinsRef[id]
    } else {
      pinsRef[id] = pin
    }
    props.setPins({ ...pinsRef })
  }

  const recent = createMemo(() => recentByHook(store.liveTelemetry()))
  const summary = () => store.telemetrySummary()
  const totalTokens = createMemo(() => summary()?.totalTokensApprox ?? 0)
  const totalEvents = createMemo(() => summary()?.totalEvents ?? 0)
  const dedupSaved = createMemo(() => summary()?.dedupSavedTokens ?? 0)

  return (
    <div
      class="flex flex-col gap-1.5 h-full min-h-0 overflow-auto"
      style={{
        padding: '12px',
        background: 'var(--bg-1)',
        'border-left': '1px solid var(--bg-line)',
      }}
    >
      <div class="flex items-baseline gap-2 mb-1">
        <span
          class="mono uppercase"
          style={{
            'font-size': '10.5px',
            color: 'var(--fg-1)',
            'font-weight': 600,
            'letter-spacing': '0.08em',
          }}
        >
          Hook pipeline
        </span>
        <span class="flex-1" />
        <span class="mono tnum" style={{ 'font-size': '9.5px', color: 'var(--fg-3)' }}>
          {totalEvents()} runs
        </span>
      </div>
      <div class="mono mb-1.5" style={{ 'font-size': '9.5px', color: 'var(--fg-3)', 'line-height': 1.4 }}>
        <Show when={props.activeFile} fallback={<span>en attente d'un edit Claude…</span>}>
          {(f) => (
            <>
              <span>edit · {f().split('/').slice(-3).join('/')}</span>
              <br />
              <span style={{ color: 'var(--yellow)' }}>▸ hover un stage → arcs vers les fichiers impactés</span>
            </>
          )}
        </Show>
      </div>

      <For each={STAGES}>
        {(s) => (
          <StageCard
            stage={s}
            rec={recent().get(s.hookKey)}
            summary={summaryForHook(summary(), s.hookKey)}
            pinsHostRect={props.hostRect}
            registerPin={registerPin}
            onEnter={() => props.setHoveredStage(s.id)}
            onLeave={() => props.setHoveredStage(null)}
          />
        )}
      </For>

      <div class="flex-1" />

      <div
        class="mono mt-2 px-2.5 py-2"
        style={{
          border: '1px solid var(--bg-line)',
          'border-radius': '3px',
          background: 'var(--bg-0)',
        }}
      >
        <div
          class="uppercase"
          style={{
            'font-size': '9.5px',
            color: 'var(--fg-3)',
            'letter-spacing': '0.08em',
            'margin-bottom': '6px',
          }}
        >
          Turn cost
        </div>
        <div class="grid grid-cols-2 gap-1.5" style={{ 'font-size': '10.5px' }}>
          <div>
            <div style={{ color: 'var(--fg-3)', 'font-size': '9px' }}>tokens cumul</div>
            <div class="tnum" style={{ color: 'var(--fg-0)', 'font-weight': 600 }}>
              {totalTokens().toLocaleString()}
            </div>
          </div>
          <div>
            <div style={{ color: 'var(--fg-3)', 'font-size': '9px' }}>dedup saved</div>
            <div class="tnum" style={{ color: 'var(--fg-0)', 'font-weight': 600 }}>
              {dedupSaved().toLocaleString()}
            </div>
          </div>
          <div>
            <div style={{ color: 'var(--fg-3)', 'font-size': '9px' }}>events</div>
            <div class="tnum" style={{ color: 'var(--fg-0)', 'font-weight': 600 }}>
              {totalEvents()}
            </div>
          </div>
          <div>
            <div style={{ color: 'var(--fg-3)', 'font-size': '9px' }}>impacted</div>
            <div class="tnum" style={{ color: 'var(--fg-0)', 'font-weight': 600 }}>
              {props.impactedFiles.length}
            </div>
          </div>
        </div>
      </div>

      <div
        class="mono px-2.5 py-2"
        style={{
          border: '1px solid var(--bg-line)',
          'border-radius': '3px',
          background: 'var(--bg-0)',
          'font-size': '10px',
          color: 'var(--fg-2)',
          'line-height': 1.5,
        }}
      >
        <div
          class="uppercase mb-1"
          style={{
            color: 'var(--fg-1)',
            'font-weight': 600,
            'font-size': '10.5px',
            'letter-spacing': '0.06em',
          }}
        >
          Claude focus
        </div>
        <Show
          when={props.activeFile}
          fallback={<div style={{ color: 'var(--fg-3)' }}>aucun fichier actif récent</div>}
        >
          {(f) => (
            <>
              <div>
                {f().split('/').pop()} <span style={{ color: 'var(--yellow)' }}>● actif</span>
              </div>
              <div style={{ color: 'var(--fg-3)' }}>
                1-hop:{' '}
                <span style={{ color: 'var(--yellow)' }}>{props.impactedFiles.length} impacted</span>
              </div>
            </>
          )}
        </Show>
      </div>
    </div>
  )
}
