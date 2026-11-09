import { attachmentLoader, canvas, withImage } from './attachments'
import type { ExportDocument, Paragraph, Run } from './document'
import type { AttachmentResolver } from './types'

interface Fragment { text: string; run: Run; width: number }
interface BaseRow { height: number; keepNext?: boolean }
interface TextRow extends BaseRow {
  kind: 'text'
  x: number
  size: number
  fragments: Fragment[]
  marker?: string
  quoteDepth: number
  code: boolean
  treeStart: boolean
}
interface ImageRow extends BaseRow { kind: 'image'; x: number; width: number; blob: Blob }
interface RuleRow extends BaseRow { kind: 'rule'; x: number; width: number }
interface SpaceRow extends BaseRow { kind: 'space' }
export type Row = TextRow | ImageRow | RuleRow | SpaceRow
export interface Layout {
  width: number
  padding: number
  rows: Row[]
}

const words = new Intl.Segmenter(undefined, { granularity: 'word' })
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function font(run: Run, size: number, code: boolean): string {
  const family = code || run.code ? 'ui-monospace, Consolas, monospace'
    : 'system-ui, "Microsoft YaHei", "Noto Sans CJK SC", sans-serif'
  return `${run.italic ? 'italic ' : ''}${run.bold ? '700' : '400'} ${size}px ${family}`
}

function paragraphRows(ctx: CanvasRenderingContext2D, block: Paragraph, x: number, width: number, baseSize: number): TextRow[] {
  const size = block.heading ? baseSize * [1, 1.65, 1.4, 1.2, 1.1, 1.05, 1][block.heading] : baseSize
  const height = Math.ceil(size * 1.55)
  const rows: TextRow[] = []
  let fragments: Fragment[] = []
  let used = 0
  const flush = () => {
    rows.push({
      kind: 'text', x, size, height, fragments, marker: rows.length ? undefined : block.marker,
      quoteDepth: block.quoteDepth, code: block.code, treeStart: Boolean(block.treeDepth) && !rows.length,
      keepNext: Boolean(block.heading),
    })
    fragments = []
    used = 0
  }
  const append = (text: string, run: Run, measured: number) => {
    const previous = fragments.at(-1)
    if (previous?.run === run) { previous.text += text; previous.width += measured }
    else fragments.push({ text, run, width: measured })
    used += measured
  }
  for (const source of block.runs) {
    const run = { ...source, bold: source.bold || Boolean(block.heading) }
    ctx.font = font(run, size, block.code)
    for (const line of run.text.split(/(\n)/)) {
      if (line === '\n') { flush(); continue }
      for (const { segment: token } of words.segment(line.replace(/\t/g, '    '))) {
        const measured = ctx.measureText(token).width
        if (measured <= width) {
          if (used + measured > width && fragments.length) flush()
          append(token, run, measured)
        } else {
          for (const { segment: glyph } of graphemes.segment(token)) {
            const glyphWidth = ctx.measureText(glyph).width
            if (used + glyphWidth > width && fragments.length) flush()
            append(glyph, run, glyphWidth)
          }
        }
      }
    }
  }
  flush()
  return rows
}

export async function layoutDocument(
  doc: ExportDocument, resolveAttachment: AttachmentResolver,
  width: number, padding: number, baseSize: number, maxImageHeight = Infinity,
): Promise<Layout> {
  await document.fonts.ready
  const measurement = canvas(1, 1)
  const load = attachmentLoader(resolveAttachment)
  const rows: Row[] = []
  const contentWidth = width - padding * 2
  for (const block of doc.blocks) {
    const logicalIndent = (block.indent + block.quoteDepth) * baseSize * 1.25
    const indentation = Math.min(logicalIndent, contentWidth * 0.45)
    const markerWidth = block.marker ? Math.max(baseSize * 1.6, block.marker.length * baseSize * 0.65) : 0
    const x = padding + indentation + markerWidth
    const available = width - padding - x
    if (block.kind === 'paragraph') {
      if (block.heading && rows.length) rows.push({ kind: 'space', height: baseSize * 0.6, keepNext: true })
      // Deep outlines retain their level even when indentation is capped for legibility.
      const paragraph = logicalIndent > indentation && block.treeDepth
        ? { ...block, runs: [{ text: `[${block.treeDepth}] ` }, ...block.runs] } : block
      rows.push(...paragraphRows(measurement.ctx, paragraph, x, available, baseSize))
    } else if (block.kind === 'image') {
      if (block.marker) {
        rows.push(...paragraphRows(measurement.ctx, {
          ...block, kind: 'paragraph', runs: [], heading: 0, code: false,
        }, x, available, baseSize))
      }
      const blob = await load(block.attachmentId)
      const dimensions = await withImage(blob, image => ({ width: image.naturalWidth, height: image.naturalHeight }))
      const ratio = Math.min(1, available / dimensions.width, maxImageHeight / dimensions.height)
      rows.push({ kind: 'image', x, width: dimensions.width * ratio, height: dimensions.height * ratio, blob })
    } else rows.push({ kind: 'rule', x, width: available, height: baseSize })
    rows.push({ kind: 'space', height: baseSize * (block.kind === 'paragraph' && block.treeDepth !== undefined ? 0.25 : 0.55) })
  }
  measurement.canvas.width = measurement.canvas.height = 0
  return { width, padding, rows }
}

export function layoutHeight(layout: Layout): number {
  return Math.ceil(layout.padding * 2 + layout.rows.reduce((sum, row) => sum + row.height, 0))
}

/** Page breaks occur between text lines; images are scaled to fit rather than sliced. */
export function paginate(layout: Layout, pageHeight: number): Row[][] {
  const capacity = pageHeight - 2 * layout.padding
  const pages: Row[][] = []
  let page: Row[] = []
  let used = 0
  const finish = () => {
    while (page.at(-1)?.kind === 'space') page.pop()
    if (page.length) pages.push(page)
    page = []
    used = 0
  }
  for (let index = 0; index < layout.rows.length; index++) {
    const row = layout.rows[index]
    if (row.kind === 'space' && !page.length) continue
    let needed = row.height
    if (row.keepNext) {
      let next = index + 1
      while (next < layout.rows.length && layout.rows[next].kind === 'space') needed += layout.rows[next++].height
      if (next < layout.rows.length) needed += layout.rows[next].height
    }
    if (used + Math.min(needed, capacity) > capacity && page.length) finish()
    if (row.kind === 'space' && !page.length) continue
    page.push(row)
    used += row.height
  }
  finish()
  return pages.length ? pages : [[]]
}

function paintText(ctx: CanvasRenderingContext2D, row: TextRow, y: number, layout: Layout): void {
  const baseline = y + (row.height - row.size) / 2 + row.size * 0.8
  if (row.code) {
    ctx.fillStyle = '#f1f3f5'
    ctx.fillRect(row.x - 6, y, layout.width - layout.padding - row.x + 6, row.height)
  }
  if (row.quoteDepth) {
    ctx.fillStyle = '#b9c6d2'
    ctx.fillRect(layout.padding - 12, y, 3, row.height)
  }
  if (row.treeStart) {
    ctx.strokeStyle = '#b9c6d2'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(row.x - row.size * 1.5, y)
    ctx.lineTo(row.x - row.size * 1.5, y + row.height / 2)
    ctx.lineTo(row.x - row.size * 0.4, y + row.height / 2)
    ctx.stroke()
  }
  if (row.marker) {
    ctx.font = font({ text: '' }, row.size, false)
    ctx.fillStyle = '#526171'
    ctx.textAlign = 'right'
    ctx.fillText(row.marker, row.x - row.size * 0.4, baseline)
    ctx.textAlign = 'left'
  }
  let x = row.x
  for (const fragment of row.fragments) {
    ctx.font = font(fragment.run, row.size, row.code)
    if (fragment.run.highlight || fragment.run.code) {
      ctx.fillStyle = fragment.run.highlight ? '#fff0a6' : '#e9edf1'
      ctx.fillRect(x, y + 2, fragment.width, row.height - 4)
    }
    ctx.fillStyle = fragment.run.href ? '#2463a0' : '#192532'
    ctx.fillText(fragment.text, x, baseline)
    if (fragment.run.underline || fragment.run.href) ctx.fillRect(x, baseline + 3, fragment.width, Math.max(1, row.size / 18))
    if (fragment.run.strike) ctx.fillRect(x, baseline - row.size * 0.3, fragment.width, Math.max(1, row.size / 18))
    x += fragment.width
  }
}

export async function paintRows(layout: Layout, rows: Row[], height: number, scale: number): Promise<HTMLCanvasElement> {
  const output = canvas(Math.ceil(layout.width * scale), Math.ceil(height * scale))
  output.ctx.fillStyle = '#ffffff'
  output.ctx.fillRect(0, 0, output.canvas.width, output.canvas.height)
  output.ctx.scale(scale, scale)
  output.ctx.textBaseline = 'alphabetic'
  let y = layout.padding
  try {
    for (const row of rows) {
      if (row.kind === 'text') paintText(output.ctx, row, y, layout)
      else if (row.kind === 'image') await withImage(row.blob, image => output.ctx.drawImage(image, row.x, y, row.width, row.height))
      else if (row.kind === 'rule') {
        output.ctx.fillStyle = '#cbd5df'
        output.ctx.fillRect(row.x, y + row.height / 2, row.width, 1)
      }
      y += row.height
    }
    return output.canvas
  } catch (error) {
    output.canvas.width = output.canvas.height = 0
    throw error
  }
}
