import type { Note } from '../domain/models'
import { canvasBlob } from './attachments'
import { readDocument } from './document'
import { layoutDocument, paginate, paintRows } from './render'
import { exportFile, type AttachmentResolver, type ExportFile, type ExportOptions } from './types'

function stream(dictionary: string, data: Blob): Blob {
  return new Blob([`<< ${dictionary} /Length ${data.size} >>\nstream\n`, data, '\nendstream'])
}

/** Paginated A4 PDF. Raster pages preserve local fonts/CJK without embedded font dependencies. */
export async function toPdf(note: Note, resolveAttachment: AttachmentResolver, options: ExportOptions = {}): Promise<ExportFile> {
  const doc = readDocument(note, options)
  const width = 794
  const height = 1123
  const padding = 56
  const layout = await layoutDocument(doc, resolveAttachment, width, padding, 18, height - 2 * padding)
  const objects: Blob[] = [new Blob(), new Blob()]
  const pageIds: number[] = []
  const add = (value: Blob | string): number => {
    objects.push(typeof value === 'string' ? new Blob([value]) : value)
    return objects.length
  }
  for (const rows of paginate(layout, height)) {
    const page = await paintRows(layout, rows, height, 2)
    let imageId: number
    try {
      const jpeg = await canvasBlob(page, 'image/jpeg')
      imageId = add(stream(`/Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`, jpeg))
    } finally {
      page.width = page.height = 0
    }
    const contentId = add(stream('', new Blob(['q\n595.276 0 0 841.89 0 0 cm\n/Im0 Do\nQ'])))
    pageIds.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.276 841.89] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`))
  }
  objects[0] = new Blob(['<< /Type /Catalog /Pages 2 0 R >>'])
  objects[1] = new Blob([`<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] >>`])
  const header = new Blob(['%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n'])
  const parts: BlobPart[] = [header]
  const offsets = [0]
  let offset = header.size
  objects.forEach((object, index) => {
    offsets.push(offset)
    const part = new Blob([`${index + 1} 0 obj\n`, object, '\nendobj\n'])
    parts.push(part)
    offset += part.size
  })
  parts.push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    + offsets.slice(1).map(value => `${String(value).padStart(10, '0')} 00000 n \n`).join('')
    + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`)
  return exportFile(doc.title, 'pdf', 'application/pdf', parts)
}
