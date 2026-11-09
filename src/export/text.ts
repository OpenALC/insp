import type { Note } from '../domain/models'
import { attachmentLoader, dataUrl } from './attachments'
import { paragraphText, readDocument, type Block, type Run } from './document'
import { exportFile, type AttachmentResolver, type ExportFile, type ExportOptions } from './types'

export function toPlainText(note: Note, options: ExportOptions = {}): string {
  return readDocument(note, options).blocks.map(block => {
    const prefix = '  '.repeat(block.indent) + '> '.repeat(block.quoteDepth) + (block.marker ? `${block.marker} ` : '')
    const text = block.kind === 'image' ? `[Image${block.alt ? `: ${block.alt}` : ''}]`
      : block.kind === 'rule' ? '---' : block.runs.map(run => run.text + (run.href ? ` (${run.href})` : '')).join('')
    return prefix + text.replace(/\n/g, `\n${' '.repeat(prefix.length)}`)
  }).join('\n\n')
}

function escapeMarkdown(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/([\\`*_{}\[\]()<>#+.!|~\-])/g, '\\$1')
}

function destination(value: string): string {
  return value.replace(/[\s()<>\\\u0000-\u001f\u007f]/g, char =>
    Array.from(new TextEncoder().encode(char), byte => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`).join(''))
}

function codeSpan(value: string): string {
  const length = Math.max(0, ...(value.match(/`+/g) ?? []).map(match => match.length)) + 1
  const fence = '`'.repeat(length)
  const pad = value.startsWith('`') || value.endsWith('`') || (/^ .* $/.test(value) && value.trim()) ? ' ' : ''
  return `${fence}${pad}${value}${pad}${fence}`
}

function markdownRun(run: Run): string {
  if (!run.text) return ''
  const leading = run.text.match(/^\s*/)?.[0] ?? ''
  const trailing = run.text.trim() ? run.text.match(/\s*$/)?.[0] ?? '' : ''
  const core = run.text.slice(leading.length, run.text.length - trailing.length)
  if (!core) return run.text.replace(/\n/g, '  \n')
  let value = run.code ? codeSpan(core) : escapeMarkdown(core)
  if (run.bold) value = `**${value}**`
  if (run.italic) value = `*${value}*`
  if (run.strike) value = `~~${value}~~`
  if (run.underline) value = `<u>${value}</u>`
  if (run.highlight) value = `<mark>${value}</mark>`
  if (run.href) value = /^(https?:|mailto:|tel:|#)/i.test(run.href)
    ? `[${value}](${destination(run.href)})` : `${value} (${escapeMarkdown(run.href)})`
  return `${leading}${value}${trailing}`.replace(/\n/g, '  \n')
}

function positioned(block: Block, value: string): string {
  return value.split('\n').map((line, index) =>
    (index ? block.markdownContinuationPrefix : block.markdownPrefix) + line).join('\n')
}

/** A single self-contained .md file, with local images embedded as data URLs. */
export async function toMarkdown(note: Note, resolveAttachment: AttachmentResolver, options: ExportOptions = {}): Promise<ExportFile> {
  const doc = readDocument(note, options)
  const load = attachmentLoader(resolveAttachment)
  const output: string[] = []
  for (const block of doc.blocks) {
    let value: string
    if (block.kind === 'image') {
      const source = await dataUrl(await load(block.attachmentId))
      value = `![${escapeMarkdown(block.alt).replace(/\n/g, ' ')}](${source})`
    } else if (block.kind === 'rule') value = '---'
    else if (block.code) {
      const text = paragraphText(block)
      const fence = '`'.repeat(Math.max(3, ...(text.match(/`+/g) ?? []).map(match => match.length + 1)))
      value = `${fence}${(block.language ?? '').replace(/[^\w+-]/g, '')}\n${text}\n${fence}`
    } else value = (block.heading ? '#'.repeat(block.heading) + ' ' : '') + block.runs.map(markdownRun).join('')
    output.push(positioned(block, value))
  }
  return exportFile(doc.title, 'md', 'text/markdown;charset=utf-8', [output.join('\n\n') + '\n'])
}
