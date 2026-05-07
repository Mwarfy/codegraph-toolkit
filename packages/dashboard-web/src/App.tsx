import { Show } from 'solid-js'
import { Header } from './components/Header.js'
import { GraphView } from './components/Graph.js'
import { TensionsPanel } from './components/Tensions.js'
import { TransparencyPanel } from './components/Transparency.js'
import { RuntimePanel } from './components/Runtime.js'
import { CommitsPanel } from './components/Commits.js'
import { TimeTravelBar } from './components/TimeTravel.js'
import { DiffPanel } from './components/Diff.js'
import { FocusPanel } from './components/Focus.js'
import { store } from './store.js'

function RightTopPanel() {
  // Priority: focus > diff > tensions
  if (store.focusedNode()) return <FocusPanel />
  if (store.pinnedFile()) return <DiffPanel />
  return <TensionsPanel />
}

export function App() {
  return (
    <div class="h-screen flex flex-col">
      <Header />
      <div class="flex-1 grid grid-cols-12 grid-rows-12 gap-px bg-zinc-800 overflow-hidden">
        <section class="col-span-8 row-span-12 bg-zinc-950">
          <GraphView />
        </section>
        <section class="col-span-4 row-span-5 bg-zinc-950 overflow-hidden">
          <RightTopPanel />
        </section>
        <section class="col-span-4 row-span-4 bg-zinc-950 overflow-hidden">
          <TransparencyPanel />
        </section>
        <section class="col-span-2 row-span-3 bg-zinc-950 overflow-hidden">
          <RuntimePanel />
        </section>
        <section class="col-span-2 row-span-3 bg-zinc-950 overflow-hidden">
          <CommitsPanel />
        </section>
      </div>
      <TimeTravelBar />
    </div>
  )
}
