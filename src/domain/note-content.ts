import type { JSONContent } from '@tiptap/core'

export function isEmptyRichText(content: JSONContent): boolean {
  return content.type === 'doc' && (content.content ?? []).every(
    node => node.type === 'paragraph' && !(node.content?.length),
  )
}

export function richTextCardPreview(content: JSONContent): JSONContent {
  let remaining = 320
  let imageIncluded = false
  function excerpt(node: JSONContent): JSONContent | null {
    if (node.type === 'text') {
      const text = (node.text ?? '').slice(0, remaining)
      remaining -= text.length
      return text ? { ...node, text } : null
    }
    if (node.type === 'image') {
      if (imageIncluded) return null
      imageIncluded = true
      remaining -= 80
      return node
    }
    const children = (node.content ?? []).map(excerpt).filter((child): child is JSONContent => child !== null)
    return { ...node, content: children }
  }
  const blocks: JSONContent[] = []
  for (const block of (content.content ?? []).slice(0, 4)) {
    if (remaining <= 0) break
    const selected = excerpt(block)
    if (selected) blocks.push(selected)
  }
  return { type: 'doc', content: blocks }
}
