import type { ContentBlock, ToolCallContent } from '@agentclientprotocol/sdk'
import { isAbsolute, basename } from 'node:path'
import { pathToFileURL } from 'node:url'

const UNAVAILABLE_ARTIFACT_STATUSES = new Set(['failed', 'missing', 'pending', 'stale', 'unverified'])
const OMITTED_IMAGE_DATA = '[base64 image omitted; forwarded as ACP image content]'

type UnknownRecord = Record<string, unknown>

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as UnknownRecord) : null
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function imageUris(details: UnknownRecord | null): string[] {
  const paths = [details?.imagePath, ...(Array.isArray(details?.imagePaths) ? details.imagePaths : [])]
  const seen = new Set<string>()
  const uris: string[] = []

  for (const path of paths) {
    const absolutePath = nonEmptyString(path)
    if (!absolutePath || !isAbsolute(absolutePath) || seen.has(absolutePath)) continue

    seen.add(absolutePath)
    uris.push(pathToFileURL(absolutePath).href)
  }

  return uris
}

function piContentBlocks(result: unknown): ContentBlock[] {
  const record = asRecord(result)
  const details = asRecord(record?.details)
  const content = record?.content
  if (!Array.isArray(content)) return []

  const fallbackImageUris = imageUris(details)
  let imageIndex = 0
  const blocks: ContentBlock[] = []

  for (const value of content) {
    const block = asRecord(value)
    if (!block) continue

    if (block.type === 'text') {
      const text = nonEmptyString(block.text)
      if (text) blocks.push({ type: 'text', text })
      continue
    }

    if (block.type === 'image') {
      const data = nonEmptyString(block.data)
      const mimeType = nonEmptyString(block.mimeType)
      if (!data || !mimeType) continue

      const explicitUri = nonEmptyString(block.uri)
      const uri = explicitUri ?? fallbackImageUris[imageIndex]
      imageIndex += 1
      blocks.push({ type: 'image', data, mimeType, ...(uri ? { uri } : {}) })
    }
  }

  return blocks
}

function artifactResourceLinks(result: unknown): ContentBlock[] {
  const record = asRecord(result)
  const details = asRecord(record?.details)
  const artifacts = details?.artifacts
  if (!Array.isArray(artifacts)) return []

  const seen = new Set<string>()
  const links: ContentBlock[] = []

  for (const value of artifacts) {
    const artifact = asRecord(value)
    const absolutePath = nonEmptyString(artifact?.absolutePath)
    const status = nonEmptyString(artifact?.status)
    if (!artifact || !absolutePath || !isAbsolute(absolutePath) || artifact.exists !== true) continue
    if (status && UNAVAILABLE_ARTIFACT_STATUSES.has(status)) continue

    const uri = pathToFileURL(absolutePath).href
    if (seen.has(uri)) continue
    seen.add(uri)

    const displayPath = nonEmptyString(artifact.requestedPath) ?? nonEmptyString(artifact.path) ?? absolutePath
    const kind = nonEmptyString(artifact.kind) ?? nonEmptyString(artifact.artifactType)
    const mimeType = nonEmptyString(artifact.mediaType)
    const sizeBytes = typeof artifact.sizeBytes === 'number' && artifact.sizeBytes >= 0 ? artifact.sizeBytes : undefined

    links.push({
      type: 'resource_link',
      uri,
      name: basename(displayPath) || basename(absolutePath),
      title: displayPath,
      ...(kind ? { description: `Saved ${kind} artifact` } : {}),
      ...(mimeType ? { mimeType } : {}),
      ...(sizeBytes !== undefined ? { size: sizeBytes } : {})
    })
  }

  return links
}

export function toolResultToText(result: unknown): string {
  if (!result) return ''

  const details = (result as any)?.details

  // pi's edit tool returns a terse success message in content and the full unified diff in details.diff.
  const diff = details?.diff
  if (typeof diff === 'string' && diff.trim()) {
    return diff
  }

  // pi tool results generally look like: { content: [{type:"text", text:"..."}], details: {...} }
  const content = (result as any).content
  if (Array.isArray(content)) {
    const texts = content
      .map((c: any) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : ''))
      .filter(Boolean)
    if (texts.length) return texts.join('')
    if (content.some((c: any) => c?.type === 'image')) return ''
  }

  // The bash tool frequently returns stdout/stderr in `details` rather than content blocks.
  const stdout =
    (typeof details?.stdout === 'string' ? details.stdout : undefined) ??
    (typeof (result as any)?.stdout === 'string' ? (result as any).stdout : undefined) ??
    (typeof details?.output === 'string' ? details.output : undefined) ??
    (typeof (result as any)?.output === 'string' ? (result as any).output : undefined)

  const stderr =
    (typeof details?.stderr === 'string' ? details.stderr : undefined) ??
    (typeof (result as any)?.stderr === 'string' ? (result as any).stderr : undefined)

  const exitCode =
    (typeof details?.exitCode === 'number' ? details.exitCode : undefined) ??
    (typeof (result as any)?.exitCode === 'number' ? (result as any).exitCode : undefined) ??
    (typeof details?.code === 'number' ? details.code : undefined) ??
    (typeof (result as any)?.code === 'number' ? (result as any).code : undefined)

  if ((typeof stdout === 'string' && stdout.trim()) || (typeof stderr === 'string' && stderr.trim())) {
    const parts: string[] = []
    if (typeof stdout === 'string' && stdout.trim()) parts.push(stdout)
    if (typeof stderr === 'string' && stderr.trim()) parts.push(`stderr:\n${stderr}`)
    if (typeof exitCode === 'number') parts.push(`exit code: ${exitCode}`)
    return parts.join('\n\n').trimEnd()
  }

  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}

export function toolResultToRawOutput(result: unknown): unknown {
  const record = asRecord(result)
  const content = record?.content
  if (!record || !Array.isArray(content)) return result

  let changed = false
  const sanitizedContent = content.map(value => {
    const block = asRecord(value)
    if (block?.type !== 'image' || typeof block.data !== 'string') return value

    changed = true
    return { ...block, data: OMITTED_IMAGE_DATA }
  })

  return changed ? { ...record, content: sanitizedContent } : result
}

export function toolResultToContent(result: unknown): ToolCallContent[] {
  const record = asRecord(result)
  const details = asRecord(record?.details)
  const diff = nonEmptyString(details?.diff)
  const blocks = piContentBlocks(result)
  const visibleBlocks = diff
    ? [{ type: 'text', text: diff } satisfies ContentBlock, ...blocks.filter(b => b.type !== 'text')]
    : blocks

  if (visibleBlocks.length === 0) {
    const text = toolResultToText(result)
    if (text) visibleBlocks.push({ type: 'text', text })
  }

  visibleBlocks.push(...artifactResourceLinks(result))
  return visibleBlocks.map(content => ({ type: 'content', content }))
}
