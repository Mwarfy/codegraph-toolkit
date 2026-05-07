import { For, Show, createResource } from 'solid-js'
import { api } from '../lib/api.js'
import { store } from '../store.js'

function Section(props: { title: string; count: number; children: import('solid-js').JSX.Element }) {
  return (
    <Show when={props.count > 0}>
      <div class="border-t border-zinc-900">
        <div class="px-3 py-1.5 text-[10px] uppercase text-zinc-500 sticky top-0 bg-zinc-950/90">
          {props.title} ({props.count})
        </div>
        {props.children}
      </div>
    </Show>
  )
}

export function FocusPanel() {
  const focused = () => store.focusedNode()
  const [details] = createResource(focused, async (id) => (id ? api.node(id) : null))

  return (
    <div class="h-full flex flex-col">
      <div class="px-3 py-2 border-b border-zinc-800 flex items-center justify-between">
        <span class="text-xs uppercase tracking-wider text-blue-400">Focus</span>
        <button
          type="button"
          onClick={() => store.setFocusedNode(null)}
          class="text-zinc-500 hover:text-zinc-200 text-xs"
        >
          ×
        </button>
      </div>

      <Show when={focused()}>
        {(id) => (
          <div class="px-3 py-2 border-b border-zinc-800">
            <div class="text-[11px] text-zinc-300 break-all" title={id()}>
              {id()}
            </div>
          </div>
        )}
      </Show>

      <Show when={details()} fallback={<div class="p-3 text-xs text-zinc-600">Chargement…</div>}>
        {(d) => (
          <div class="flex-1 overflow-y-auto">
            <Show when={d().truthPoint}>
              {(tp) => (
                <div class="px-3 py-2 border-t border-zinc-900 bg-amber-500/5">
                  <div class="text-[10px] uppercase text-amber-400">Truth point</div>
                  <Show when={tp().reason}>
                    <div class="text-[11px] text-amber-200/80 mt-0.5">{tp().reason}</div>
                  </Show>
                </div>
              )}
            </Show>

            <Section title="Importers" count={d().importers.length}>
              <ul class="bg-zinc-900/30 max-h-48 overflow-y-auto">
                <For each={d().importers.slice(0, 50)}>
                  {(imp) => (
                    <li
                      class="px-3 py-1 text-[11px] text-zinc-300 truncate hover:bg-zinc-800/50 cursor-pointer"
                      title={imp.from}
                      onClick={() => store.setFocusedNode(imp.from)}
                    >
                      ← {imp.from}
                    </li>
                  )}
                </For>
              </ul>
            </Section>

            <Section title="Imports" count={d().imports.length}>
              <ul class="bg-zinc-900/30 max-h-48 overflow-y-auto">
                <For each={d().imports.slice(0, 50)}>
                  {(imp) => (
                    <li
                      class="px-3 py-1 text-[11px] text-zinc-300 truncate hover:bg-zinc-800/50 cursor-pointer"
                      title={imp.to}
                      onClick={() => store.setFocusedNode(imp.to)}
                    >
                      → {imp.to}
                    </li>
                  )}
                </For>
              </ul>
            </Section>

            <Section title="Co-change" count={d().coChange.length}>
              <ul class="bg-zinc-900/30">
                <For each={d().coChange}>
                  {(cc) => (
                    <li
                      class="px-3 py-1 text-[11px] flex items-center gap-2 hover:bg-zinc-800/50 cursor-pointer"
                      onClick={() => store.setFocusedNode(cc.partner)}
                    >
                      <span class="text-zinc-500 w-12 shrink-0 tabular-nums">
                        {(cc.rate * 100).toFixed(0)}%
                      </span>
                      <span class="text-zinc-300 truncate flex-1" title={cc.partner}>
                        {cc.partner}
                      </span>
                      <span class="text-zinc-600 shrink-0">{cc.sharedCommits}c</span>
                    </li>
                  )}
                </For>
              </ul>
            </Section>

            <Section title="Long fns" count={d().longFunctions.length}>
              <ul class="bg-zinc-900/30">
                <For each={d().longFunctions}>
                  {(lf) => (
                    <li class="px-3 py-1 text-[11px] flex justify-between">
                      <span class="text-zinc-300">{lf.name}</span>
                      <span class="text-amber-400">{lf.lines} lignes</span>
                    </li>
                  )}
                </For>
              </ul>
            </Section>

            <Section title="TODO" count={d().todos.length}>
              <ul class="bg-zinc-900/30 max-h-32 overflow-y-auto">
                <For each={d().todos}>
                  {(t) => (
                    <li class="px-3 py-1 text-[11px]">
                      <span class="text-zinc-500">L{t.line}</span>
                      <span class="text-zinc-300 ml-2">{t.text}</span>
                    </li>
                  )}
                </For>
              </ul>
            </Section>

            <Section title="Env vars" count={d().envVars.length}>
              <div class="bg-zinc-900/30 px-3 py-1 flex flex-wrap gap-1">
                <For each={d().envVars}>
                  {(v) => <code class="text-[10px] text-blue-300 bg-blue-500/10 px-1 rounded">{v}</code>}
                </For>
              </div>
            </Section>

            <Section title="Drift" count={d().driftSignals.length}>
              <ul class="bg-zinc-900/30">
                <For each={d().driftSignals}>
                  {(ds) => (
                    <li class="px-3 py-1 text-[11px]">
                      <span class="text-amber-400">[{ds.kind}]</span>
                      <span class="text-zinc-400 ml-2">{ds.detail}</span>
                    </li>
                  )}
                </For>
              </ul>
            </Section>
          </div>
        )}
      </Show>
    </div>
  )
}
