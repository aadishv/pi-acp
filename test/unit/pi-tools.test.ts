import test from 'node:test'
import assert from 'node:assert/strict'
import { toolResultToRawOutput, toolResultToText } from '../../src/acp/translate/pi-tools.js'

test('toolResultToText: extracts text from content blocks', () => {
  const text = toolResultToText({
    content: [
      { type: 'text', text: 'hello' },
      { type: 'text', text: ' world' }
    ]
  })
  assert.equal(text, 'hello world')
})

test('toolResultToText: prefers details.diff when present', () => {
  const text = toolResultToText({ details: { diff: '--- a\n+++ b\n' } })
  assert.equal(text, '--- a\n+++ b\n')
})

test('toolResultToText: returns empty string for empty content-only updates', () => {
  const text = toolResultToText({ content: [] })
  assert.equal(text, '')
})

test('toolResultToText: falls back to JSON', () => {
  const text = toolResultToText({ a: 1 })
  assert.match(text, /"a": 1/)
})

test('toolResultToText: extracts bash stdout/stderr from details', () => {
  const text = toolResultToText({
    details: {
      stdout: 'ok\n',
      stderr: 'warn\n',
      exitCode: 0
    }
  })
  assert.match(text, /ok/)
  assert.match(text, /stderr:/)
  assert.match(text, /warn/)
  assert.match(text, /exit code: 0/)
})

test('toolResultToRawOutput: flattens structured tool results to readable text', () => {
  const rawOutput = toolResultToRawOutput({
    content: [{ type: 'text', text: 'hello from read' }]
  })

  assert.equal(rawOutput, 'hello from read')
})

test('toolResultToRawOutput: omits empty structured updates', () => {
  const rawOutput = toolResultToRawOutput({ content: [] })
  assert.equal(rawOutput, undefined)
})
