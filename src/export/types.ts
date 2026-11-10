import type { Note } from '../domain/models'

/** Return decrypted local image bytes. */
export type AttachmentResolver = (attachmentId: string) => Blob | Promise<Blob>

export interface ExportOptions {
  /** Include the note title. A matching mind map root is included only once. Default: true. */
  includeTitle?: boolean
}

export interface ImageExportOptions extends ExportOptions {
  /** Logical width in pixels. Default: 1080. */
  width?: number
  /** Pixel density. Default: 1.5. */
  scale?: number
}

export type ExportFormat = 'plaintext' | 'markdown' | 'png' | 'docx' | 'pdf'

export interface ExportFile {
  filename: string
  mimeType: string
  blob: Blob
}

export type ExportErrorCode =
  | 'UNSUPPORTED_CONTENT'
  | 'MISSING_ATTACHMENT'
  | 'UNSUPPORTED_IMAGE'
  | 'IMAGE_DECODE_FAILED'
  | 'CANVAS_UNAVAILABLE'
  | 'IMAGE_TOO_LARGE'

export class NoteExportError extends Error {
  constructor(public readonly code: ExportErrorCode, message: string) {
    super(message)
    this.name = 'NoteExportError'
  }
}

export function exportFilename(note: Pick<Note, 'title'>, extension: string): string {
  const title = note.title.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
    .replace(/[. ]+$/g, '').trim().slice(0, 100)
  const safe = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(title) ? `_${title}` : title
  return `${safe || 'note'}.${extension}`
}

export function exportFile(title: string, extension: string, mimeType: string, parts: BlobPart[]): ExportFile {
  return { filename: exportFilename({ title }, extension), mimeType, blob: new Blob(parts, { type: mimeType }) }
}
