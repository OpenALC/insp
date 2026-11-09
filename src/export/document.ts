import type { JSONContent } from '@tiptap/core'
import type { Note } from '../domain/models'
import type { MindMapDocument, MindMapNode } from '../domain/mindmap'
import { NoteExportError, type ExportOptions } from './types'

export interface Run {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  highlight?: boolean
  code?: boolean
  href?: string
}

interface Position {
  indent: number
  quoteDepth: number
  marker?: string
  markdownPrefix: string
  markdownContinuationPrefix: string
}

export interface Paragraph extends Position {
  kind: 'paragraph'
  runs: Run[]
  heading: number
  code: boolean
  language?: string
  treeDepth?: number
}

export interface ImageBlock extends Position {
  kind: 'image'
  attachmentId: string
  alt: string
}

export interface RuleBlock extends Position { kind: 'rule' }
export type Block = Paragraph | ImageBlock | RuleBlock
export interface ExportDocument { title: string; blocks: Block[] }

function inline(node: JSONContent): Run[] {
  if (node.type === 'hardBreak') return [{ text: '\n' }]
  if (node.type === 'text') {
    const run: Run = { text: node.text ?? '' }
    for (const mark of node.marks ?? []) {
      if (mark.type === 'link') run.href = String(mark.attrs?.href ?? '')
      else if (mark.type === 'bold') run.bold = true
      else if (mark.type === 'italic') run.italic = true
      else if (mark.type === 'underline') run.underline = true
      else if (mark.type === 'strike') run.strike = true
      else if (mark.type === 'highlight') run.highlight = true
      else if (mark.type === 'code') run.code = true
      else throw new NoteExportError('UNSUPPORTED_CONTENT', `Unsupported text mark: ${mark.type}`)
    }
    return [run]
  }
  throw new NoteExportError('UNSUPPORTED_CONTENT', `Unsupported inline content: ${node.type}`)
}

/** Read synchronously into detached blocks before any attachment resolution can yield. */
export function readDocument(note: Note, options: ExportOptions = {}): ExportDocument {
  const blocks: Block[] = []
  const origin: Position = { indent: 0, quoteDepth: 0, markdownPrefix: '', markdownContinuationPrefix: '' }
  const addParagraph = (text: string, heading: number, extra: Partial<Paragraph> = {}) => {
    blocks.push({ ...origin, kind: 'paragraph', runs: [{ text }], heading, code: false, ...extra })
  }
  const includeTitle = options.includeTitle !== false && Boolean(note.title)
  if (note.kind === 'mindmap') {
    const { root } = note.content as MindMapDocument
    const separateTitle = includeTitle && note.title !== root.text
    if (separateTitle) addParagraph(note.title, 1)
    const visit = (node: MindMapNode, depth: number) => {
      addParagraph(node.text, depth === 0 ? (separateTitle ? 2 : 1) : 0, {
        treeDepth: depth, indent: Math.max(0, depth - 1),
        markdownPrefix: '  '.repeat(Math.max(0, depth - 1)) + (depth ? '- ' : ''),
        markdownContinuationPrefix: '  '.repeat(depth),
        marker: depth ? '•' : undefined,
      })
      node.children.forEach(child => visit(child, depth + 1))
    }
    visit(root, 0)
  } else {
    if (includeTitle) addParagraph(note.title, 1)
    const walk = (node: JSONContent, position: Position): void => {
      const children = node.content ?? []
      switch (node.type) {
        case 'doc':
          children.forEach(child => walk(child, position))
          return
        case 'paragraph':
        case 'heading':
        case 'codeBlock':
          blocks.push({
            ...position, kind: 'paragraph', runs: children.flatMap(inline),
            heading: node.type === 'heading' ? Number(node.attrs?.level ?? 1) : 0,
            code: node.type === 'codeBlock', language: String(node.attrs?.language ?? ''),
          })
          return
        case 'image': {
          const attachmentId = node.attrs?.attachmentId
          if (typeof attachmentId !== 'string' || !attachmentId) {
            throw new NoteExportError('MISSING_ATTACHMENT', 'An image has no local attachment ID.')
          }
          blocks.push({ ...position, kind: 'image', attachmentId, alt: String(node.attrs?.alt ?? '') })
          return
        }
        case 'horizontalRule':
          blocks.push({ ...position, kind: 'rule' })
          return
        case 'blockquote':
          children.forEach(child => walk(child, {
            ...position, quoteDepth: position.quoteDepth + 1,
            markdownPrefix: position.markdownPrefix + '> ',
            markdownContinuationPrefix: position.markdownContinuationPrefix + '> ',
          }))
          return
        case 'bulletList':
        case 'orderedList':
        case 'taskList':
          children.forEach((item, index) => {
            const marker = node.type === 'orderedList' ? `${Number(node.attrs?.start ?? 1) + index}.`
              : node.type === 'taskList' ? (item.attrs?.checked ? '[x]' : '[ ]') : '•'
            const contents = item.content ?? []
            const start = blocks.length
            const contentPrefix = position.markdownPrefix + ' '.repeat(node.type === 'orderedList' ? marker.length + 1 : 2)
            const markdownMarker = node.type === 'orderedList' ? `${marker} `
              : node.type === 'taskList' ? `- ${marker} ` : '- '
            contents.forEach(child => {
              walk(child, {
                ...position, indent: position.indent + 1, marker: undefined,
                markdownPrefix: contentPrefix, markdownContinuationPrefix: contentPrefix,
              })
            })
            const first = blocks[start]
            if (!first || first.marker) {
              blocks.splice(start, 0, {
                ...position, marker, kind: 'paragraph', runs: [], heading: 0, code: false,
                markdownPrefix: position.markdownPrefix + markdownMarker,
                markdownContinuationPrefix: contentPrefix,
              })
            } else {
              first.marker = marker
              first.indent -= 1
              first.markdownPrefix = position.markdownPrefix + markdownMarker + first.markdownPrefix.slice(contentPrefix.length)
            }
          })
          return
        default:
          throw new NoteExportError('UNSUPPORTED_CONTENT', `Unsupported block: ${node.type}`)
      }
    }
    walk(note.content as JSONContent, origin)
  }
  return { title: note.title, blocks }
}

export function paragraphText(block: Paragraph): string {
  return block.runs.map(run => run.text).join('')
}

export function xml(value: string): string {
  // XML 1.0 cannot encode these control characters, even as character references.
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}
