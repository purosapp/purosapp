import type { SourceEntityRef } from './sourceIdentity'

export type BioSegment =
  | { type: 'text'; text: string }
  | { type: 'external'; text: string; url: string }
  | { type: 'entity'; text: string; entityType: SourceEntityRef['entityType']; sourceId: string }

const LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)/g
const ENTITY_HREF = /^puros:(artist|album|track|playlist)\/(.+)$/

function decode(value: string): string | null {
  try { return decodeURIComponent(value) } catch { return null }
}

/**
 * Splits provider bio text (see the SDK's `ProviderBioResultV1.text`) into
 * plain text and links. Stray `<br>` tags become line breaks; any link that
 * is neither http(s) nor a `puros:` entity reference stays plain text.
 */
export function parseBioText(value: string): BioSegment[] {
  const source = value.replace(/<br\s*\/?>/gi, '\n\n')
  const segments: BioSegment[] = []
  const pushText = (text: string) => {
    if (!text) return
    const last = segments[segments.length - 1]
    if (last?.type === 'text') last.text += text
    else segments.push({ type: 'text', text })
  }
  let index = 0
  for (const match of source.matchAll(LINK)) {
    pushText(source.slice(index, match.index))
    index = match.index + match[0].length
    const [, text, href] = match
    const entity = ENTITY_HREF.exec(href)
    const sourceId = entity ? decode(entity[2]) : null
    if (entity && sourceId) {
      segments.push({ type: 'entity', text, entityType: entity[1] as SourceEntityRef['entityType'], sourceId })
    } else if (/^https?:\/\//i.test(href)) {
      segments.push({ type: 'external', text, url: href })
    } else {
      pushText(text)
    }
  }
  pushText(source.slice(index))
  return segments
}

/** The bio as it reads on screen, without link markup. */
export function bioPlainText(value: string): string {
  return parseBioText(value).map((segment) => segment.text).join('')
}
