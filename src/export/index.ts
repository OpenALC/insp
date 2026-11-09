export { toPlainText, toMarkdown } from './text'
export { toPng } from './png'
export { toDocx } from './docx'
export { toPdf } from './pdf'
export { NoteExportError, exportFilename } from './types'
export type {
  AttachmentResolver, ExportFile, ExportFormat, ExportOptions, ImageExportOptions, ExportErrorCode,
} from './types'

import type { Note } from '../domain/models'
import type { AttachmentResolver, ExportFile, ExportFormat, ImageExportOptions } from './types'
import { toPlainText, toMarkdown } from './text'
import { toPng } from './png'
import { toDocx } from './docx'
import { toPdf } from './pdf'

export function exportNote(note: Note, format: 'plaintext', resolveAttachment: AttachmentResolver, options?: ImageExportOptions): Promise<string>
export function exportNote(note: Note, format: Exclude<ExportFormat, 'plaintext'>, resolveAttachment: AttachmentResolver, options?: ImageExportOptions): Promise<ExportFile>
export function exportNote(note: Note, format: ExportFormat, resolveAttachment: AttachmentResolver, options?: ImageExportOptions): Promise<string | ExportFile>
export async function exportNote(
  note: Note, format: ExportFormat, resolveAttachment: AttachmentResolver, options: ImageExportOptions = {},
): Promise<string | ExportFile> {
  switch (format) {
    case 'plaintext': return toPlainText(note, options)
    case 'markdown': return toMarkdown(note, resolveAttachment, options)
    case 'png': return toPng(note, resolveAttachment, options)
    case 'docx': return toDocx(note, resolveAttachment, options)
    case 'pdf': return toPdf(note, resolveAttachment, options)
  }
}
