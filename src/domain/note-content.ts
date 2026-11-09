import type { JSONContent } from '@tiptap/core'

export function isEmptyRichText(content: JSONContent): boolean {
  return content.type === 'doc' && (content.content ?? []).every(
    node => node.type === 'paragraph' && !(node.content?.length),
  )
}
