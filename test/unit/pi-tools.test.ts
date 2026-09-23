import test from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { toolResultToContent, toolResultToRawOutput, toolResultToText } from '../../src/acp/translate/pi-tools.js'

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
  const text = toolResultToText({
    content: [{ type: 'text', text: 'Successfully replaced 2 block(s) in a.txt.' }],
    details: { diff: '--- a\n+++ b\n' }
  })
  assert.equal(text, '--- a\n+++ b\n')
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

test('toolResultToContent: preserves inline images and associates their saved path', () => {
  const imagePath = resolve(tmpdir(), 'browser-shot.png')
  const content = toolResultToContent({
    content: [
      { type: 'text', text: 'Saved screenshot' },
      { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }
    ],
    details: { imagePath }
  })

  assert.deepEqual(content, [
    { type: 'content', content: { type: 'text', text: 'Saved screenshot' } },
    {
      type: 'content',
      content: {
        type: 'image',
        data: 'aW1hZ2U=',
        mimeType: 'image/png',
        uri: pathToFileURL(imagePath).href
      }
    }
  ])
})

test('toolResultToContent: associates multiple images with distinct saved paths', () => {
  const firstPath = resolve(tmpdir(), 'browser-shot-1.png')
  const secondPath = resolve(tmpdir(), 'browser-shot-2.png')
  const content = toolResultToContent({
    content: [
      { type: 'image', data: 'Zmlyc3Q=', mimeType: 'image/png' },
      { type: 'image', data: 'c2Vjb25k', mimeType: 'image/png' }
    ],
    details: {
      imagePath: firstPath,
      imagePaths: [firstPath, secondPath]
    }
  })

  assert.deepEqual(content, [
    {
      type: 'content',
      content: {
        type: 'image',
        data: 'Zmlyc3Q=',
        mimeType: 'image/png',
        uri: pathToFileURL(firstPath).href
      }
    },
    {
      type: 'content',
      content: {
        type: 'image',
        data: 'c2Vjb25k',
        mimeType: 'image/png',
        uri: pathToFileURL(secondPath).href
      }
    }
  ])
})

test('toolResultToContent: links only verified saved artifacts', () => {
  const reportPath = resolve(tmpdir(), 'report.pdf')
  const pendingPath = resolve(tmpdir(), 'pending.webm')
  const missingPath = resolve(tmpdir(), 'missing.txt')
  const content = toolResultToContent({
    content: [{ type: 'text', text: 'Download complete' }],
    details: {
      artifacts: [
        {
          absolutePath: reportPath,
          path: 'downloads/report.pdf',
          requestedPath: 'downloads/report.pdf',
          exists: true,
          status: 'saved',
          kind: 'download',
          mediaType: 'application/pdf',
          sizeBytes: 123
        },
        {
          absolutePath: pendingPath,
          path: pendingPath,
          exists: true,
          status: 'pending',
          kind: 'video'
        },
        {
          absolutePath: missingPath,
          path: missingPath,
          exists: false,
          status: 'missing',
          kind: 'download'
        }
      ]
    }
  })

  assert.deepEqual(content, [
    { type: 'content', content: { type: 'text', text: 'Download complete' } },
    {
      type: 'content',
      content: {
        type: 'resource_link',
        uri: pathToFileURL(reportPath).href,
        name: 'report.pdf',
        title: 'downloads/report.pdf',
        description: 'Saved download artifact',
        mimeType: 'application/pdf',
        size: 123
      }
    }
  ])
})

test('toolResultToText: does not stringify image payloads', () => {
  const text = toolResultToText({ content: [{ type: 'image', data: 'large-base64', mimeType: 'image/png' }] })
  assert.equal(text, '')
})

test('toolResultToRawOutput: replaces image data without mutating the Pi result', () => {
  const result = {
    content: [
      { type: 'text', text: 'Saved screenshot' },
      { type: 'image', data: 'large-base64', mimeType: 'image/png' }
    ],
    details: { imagePath: resolve(tmpdir(), 'browser-shot.png') }
  }

  assert.deepEqual(toolResultToRawOutput(result), {
    content: [
      { type: 'text', text: 'Saved screenshot' },
      {
        type: 'image',
        data: '[base64 image omitted; forwarded as ACP image content]',
        mimeType: 'image/png'
      }
    ],
    details: result.details
  })
  assert.equal(result.content[1]!.data, 'large-base64')
})

test('toolResultToRawOutput: preserves results without image data', () => {
  const result = { content: [{ type: 'text', text: 'done' }], details: { status: 'saved' } }
  assert.equal(toolResultToRawOutput(result), result)
})
