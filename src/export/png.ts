import type { Note } from '../domain/models'
import { canvasBlob } from './attachments'
import { readDocument } from './document'
import { layoutDocument, layoutHeight, paintRows } from './render'
import { exportFile, NoteExportError, type AttachmentResolver, type ExportFile, type ImageExportOptions } from './types'

export async function toPng(note: Note, resolveAttachment: AttachmentResolver, options: ImageExportOptions = {}): Promise<ExportFile> {
  const doc = readDocument(note, options)
  const width = options.width ?? 1080
  const scale = options.scale ?? 1.5
  if (!Number.isFinite(width) || width < 320 || !Number.isFinite(scale) || scale <= 0) {
    throw new RangeError('PNG width must be at least 320 and scale must be positive.')
  }
  const layout = await layoutDocument(doc, resolveAttachment, width, 64, 28)
  const height = layoutHeight(layout)
  const pixelWidth = Math.ceil(width * scale)
  const pixelHeight = Math.ceil(height * scale)
  // Mobile webviews have finite canvas dimensions; reject rather than silently crop a note.
  if (pixelWidth > 16384 || pixelHeight > 16384 || pixelWidth * pixelHeight > 32_000_000) {
    throw new NoteExportError('IMAGE_TOO_LARGE', 'This note exceeds the single-image canvas limit. Export as PDF instead.')
  }
  const image = await paintRows(layout, layout.rows, height, scale)
  try {
    return exportFile(doc.title, 'png', 'image/png', [await canvasBlob(image)])
  } finally {
    image.width = image.height = 0
  }
}
