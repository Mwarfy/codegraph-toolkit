import { Show, createMemo, createResource } from 'solid-js'
import { api } from '../lib/api.js'
import { store } from '../store.js'

function fmtBytes(n: number): string {
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB'
  return n + ' B'
}

function fmtRelTime(epochSec: number): string {
  const diff = Date.now() / 1000 - epochSec
  if (diff < 60) return `${Math.floor(diff)}s`
  if (diff < 3600) return `${Math.floor(diff / 60)}m`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`
  return `${Math.floor(diff / 86400)}j`
}

/**
 * Modal overlay that shows the EXACT text injected into Claude's
 * context — either a hook payload (clicked from the live feed) or
 * the boot context (CLAUDE-CONTEXT.md / CLAUDE.md, opened from the
 * header). Closes on Esc or overlay click.
 *
 * This is the transparency core: byte counts and dedup ratios tell
 * you how much; this view tells you exactly what.
 */
export function PayloadViewer() {
  const state = () => store.viewer()
  const close = (): void => {
    store.setViewer({ kind: 'closed' })
  }

  const payloadHash = createMemo(() => {
    const s = state()
    return s.kind === 'payload' ? s.hash : null
  })

  const [payloadText] = createResource(payloadHash, async (hash) => {
    return hash ? api.hookPayload(hash) : null
  })

  const isBoot = createMemo(() => state().kind === 'boot')
  const [bootCtx] = createResource(isBoot, async (open) => {
    return open ? api.bootContext() : null
  })

  return (
    <Show when={state().kind !== 'closed'}>
      <div
        class="fixed inset-0 z-50 bg-zinc-950/85 backdrop-blur-sm flex items-center justify-center p-8"
        onClick={(e) => {
          if (e.target === e.currentTarget) close()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close()
        }}
      >
        <div class="bg-zinc-900 border border-zinc-800 rounded-lg shadow-2xl max-w-4xl w-full max-h-[85vh] flex flex-col">
          {/* Header */}
          <Show when={state().kind === 'payload' && state()}>
            {(s) => {
              const v = s() as Extract<ViewerState, { kind: 'payload' }>
              return (
                <div class="flex items-start justify-between border-b border-zinc-800 p-4">
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2 mb-1">
                      <span
                        class={`text-[10px] uppercase px-1.5 py-0.5 rounded ${
                          v.meta.event === 'PreToolUse'
                            ? 'bg-blue-500/20 text-blue-300'
                            : 'bg-emerald-500/20 text-emerald-300'
                        }`}
                      >
                        {v.meta.event}
                      </span>
                      <span class="text-zinc-400 text-xs">{v.meta.hook}</span>
                      <span class="text-zinc-600 text-xs">·</span>
                      <span class="text-zinc-500 text-xs">{fmtRelTime(v.meta.ts)}</span>
                    </div>
                    <div class="text-zinc-200 text-sm truncate" title={v.meta.file}>
                      {v.meta.file}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={close}
                    class="text-zinc-500 hover:text-zinc-200 text-2xl leading-none ml-4"
                  >
                    ×
                  </button>
                </div>
              )
            }}
          </Show>

          <Show when={state().kind === 'boot'}>
            <div class="flex items-start justify-between border-b border-zinc-800 p-4">
              <div class="min-w-0 flex-1">
                <div class="text-[10px] uppercase text-blue-400 mb-1">Boot context</div>
                <Show when={bootCtx()}>
                  {(b) => (
                    <>
                      <div class="text-zinc-200 text-sm">{b().file}</div>
                      <div class="text-zinc-600 text-[11px]">
                        {fmtBytes(b().bytes)} · ~{b().tokensApprox} tokens · chargé au démarrage de chaque session
                      </div>
                    </>
                  )}
                </Show>
              </div>
              <button
                type="button"
                onClick={close}
                class="text-zinc-500 hover:text-zinc-200 text-2xl leading-none ml-4"
              >
                ×
              </button>
            </div>
          </Show>

          {/* Body — the actual injected text */}
          <div class="flex-1 overflow-y-auto p-4">
            <Show when={state().kind === 'payload'}>
              <Show when={payloadText.loading}>
                <div class="text-zinc-500 text-xs">Chargement…</div>
              </Show>
              <Show when={payloadText.error}>
                <div class="text-red-400 text-xs">
                  Payload introuvable. Le fichier .codegraph/hook-payloads/&lt;hash&gt;.txt a peut-être été nettoyé.
                </div>
              </Show>
              <Show when={payloadText()}>
                {(t) => (
                  <pre class="text-[11px] text-zinc-300 whitespace-pre-wrap break-words font-mono leading-relaxed">
                    {t()}
                  </pre>
                )}
              </Show>
            </Show>

            <Show when={state().kind === 'boot'}>
              <Show when={bootCtx()}>
                {(b) => (
                  <pre class="text-[11px] text-zinc-300 whitespace-pre-wrap break-words font-mono leading-relaxed">
                    {b().content}
                  </pre>
                )}
              </Show>
            </Show>
          </div>

          <div class="border-t border-zinc-800 px-4 py-2 text-[10px] text-zinc-600 flex justify-between">
            <span>Esc pour fermer · clic sur le fond aussi</span>
            <span>Texte exact injecté dans le contexte de Claude</span>
          </div>
        </div>
      </div>
    </Show>
  )
}

type ViewerState = ReturnType<typeof store.viewer>
