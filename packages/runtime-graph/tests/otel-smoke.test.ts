/**
 * OTel smoke test : minimal repro to verify span creation pipeline works.
 * Uses BasicTracerProvider directly without the runtime-graph layer.
 */

import { describe, it, expect } from 'vitest'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'

describe('OTel smoke', () => {
  it('captures a manually-created span via BasicTracerProvider', async () => {
    const exporter = new InMemorySpanExporter()
    const processor = new SimpleSpanProcessor(exporter)
    const provider = new BasicTracerProvider({
      spanProcessors: [processor],
    })

    const tracer = provider.getTracer('smoke')
    await tracer.startActiveSpan('test-span', async (span) => {
      span.setAttribute('foo', 'bar')
      span.end()
    })

    await processor.forceFlush()
    const spans = exporter.getFinishedSpans()
    expect(spans.length).toBeGreaterThan(0)
    expect(spans[0].name).toBe('test-span')
  })
})
