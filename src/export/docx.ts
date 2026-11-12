import type { Note } from '../domain/models'
import { attachmentLoader, pngImage } from './attachments'
import { readDocument, xml, type Paragraph, type Run } from './document'
import { exportFile, type AttachmentResolver, type ExportFile, type ExportOptions } from './types'
import { xmlEntry, zip, type ZipEntry } from './zip'

const wordNS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const relNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const packageRelNS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

function textRun(run: Run, code = false): string {
  const properties = [
    run.code || code ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>' : '',
    run.bold ? '<w:b/>' : '', run.italic ? '<w:i/>' : '',
    run.strike ? '<w:strike/>' : '',
    run.href ? '<w:color w:val="2463A0"/>' : '',
    run.highlight ? '<w:highlight w:val="yellow"/>' : '',
    run.underline || run.href ? '<w:u w:val="single"/>' : '',
    run.code || code ? '<w:shd w:fill="F1F3F5"/>' : '',
  ].join('')
  const content = run.text.split(/(\n|\t)/).map(part => part === '\n' ? '<w:br/>' : part === '\t' ? '<w:tab/>'
    : `<w:t xml:space="preserve">${xml(part)}</w:t>`).join('')
  return `<w:r><w:rPr>${properties}</w:rPr>${content}</w:r>`
}

function paragraphProperties(block: Paragraph): string {
  const heading = block.heading ? `<w:pStyle w:val="Heading${block.heading}"/><w:keepNext/>` : ''
  const indent = (block.indent + block.quoteDepth) * 360 + (block.marker ? 300 : 0)
  const code = block.code ? '<w:shd w:fill="F1F3F5"/>' : ''
  return `<w:pPr>${heading}${code}<w:spacing w:after="140" w:line="300" w:lineRule="auto"/><w:ind w:left="${indent}"${block.marker ? ' w:hanging="300"' : ''}/></w:pPr>`
}

function drawing(id: number, relationship: string, width: number, height: number, alt: string): string {
  return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">
    <wp:extent cx="${width}" cy="${height}"/><wp:docPr id="${id}" name="Image ${id}" descr="${xml(alt)}"/>
    <wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>
    <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
    <pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="Image ${id}"/><pic:cNvPicPr/></pic:nvPicPr>
    <pic:blipFill><a:blip r:embed="${relationship}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
    <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${width}" cy="${height}"/></a:xfrm>
    <a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>
    </a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
}

/** Real OOXML: editable paragraphs and marks, embedded PNGs, and clickable links. */
export async function toDocx(note: Note, resolveAttachment: AttachmentResolver, options: ExportOptions = {}): Promise<ExportFile> {
  const doc = readDocument(note, options)
  const load = attachmentLoader(resolveAttachment)
  const media = new Map<string, { relationship: string; width: number; height: number }>()
  const files: ZipEntry[] = []
  const relationships = [`<Relationship Id="styles" Type="${relNS}/styles" Target="styles.xml"/>`]
  const body: string[] = []
  let relationIndex = 0
  let imageIndex = 0
  for (const block of doc.blocks) {
    if (block.kind === 'paragraph') {
      const runs: string[] = block.marker ? [textRun({ text: `${block.marker} ` })] : []
      if (block.quoteDepth) runs.unshift('<w:r><w:rPr><w:color w:val="777E77"/></w:rPr><w:t>❝ </w:t></w:r>')
      for (const run of block.runs) {
        let value = textRun(run, block.code)
        if (run.href && /^(https?:|mailto:|tel:)/i.test(run.href)) {
          const id = `r${++relationIndex}`
          relationships.push(`<Relationship Id="${id}" Type="${relNS}/hyperlink" Target="${xml(run.href)}" TargetMode="External"/>`)
          value = `<w:hyperlink r:id="${id}">${value}</w:hyperlink>`
        } else if (run.href) value += textRun({ text: ` (${run.href})` })
        runs.push(value)
      }
      body.push(`<w:p>${paragraphProperties(block)}${runs.join('')}</w:p>`)
    } else if (block.kind === 'rule') {
      body.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:color="CBD5DF"/></w:pBdr></w:pPr></w:p>')
    } else {
      let image = media.get(block.attachmentId)
      if (!image) {
        const normalized = await pngImage(await load(block.attachmentId))
        const relationship = `r${++relationIndex}`
        const name = `image${media.size + 1}.png`
        image = { relationship, width: normalized.width, height: normalized.height }
        media.set(block.attachmentId, image)
        files.push({ name: `word/media/${name}`, data: new Uint8Array(await normalized.blob.arrayBuffer()) })
        relationships.push(`<Relationship Id="${relationship}" Type="${relNS}/image" Target="media/${name}"/>`)
      }
      const indent = (block.indent + block.quoteDepth) * 360
      const widthLimit = Math.max(720, 9638 - indent) * 635
      const scale = Math.min(9525, widthLimit / image.width, 12000 * 635 / image.height)
      const width = Math.round(image.width * scale)
      const height = Math.round(image.height * scale)
      body.push(`<w:p><w:pPr><w:spacing w:after="160"/><w:ind w:left="${indent}"/></w:pPr>`
        + (block.quoteDepth ? '<w:r><w:rPr><w:color w:val="777E77"/></w:rPr><w:t>❝ </w:t></w:r>' : '')
        + (block.marker ? textRun({ text: `${block.marker} ` }) : '')
        + drawing(++imageIndex, image.relationship, width, height, block.alt) + '</w:p>')
    }
  }
  const headingStyles = Array.from({ length: 6 }, (_, index) => {
    const level = index + 1
    return `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/>
      <w:pPr><w:keepNext/><w:spacing w:before="220" w:after="140"/><w:outlineLvl w:val="${index}"/></w:pPr>
      <w:rPr><w:b/><w:sz w:val="${[40, 32, 28, 26, 24, 22][index]}"/></w:rPr></w:style>`
  }).join('')
  files.push(
    xmlEntry('[Content_Types].xml', `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>
      <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
      <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`),
    xmlEntry('_rels/.rels', `<Relationships xmlns="${packageRelNS}"><Relationship Id="document" Type="${relNS}/officeDocument" Target="word/document.xml"/></Relationships>`),
    xmlEntry('word/_rels/document.xml.rels', `<Relationships xmlns="${packageRelNS}">${relationships.join('')}</Relationships>`),
    xmlEntry('word/styles.xml', `<w:styles xmlns:w="${wordNS}"><w:docDefaults><w:rPrDefault><w:rPr>
      <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Microsoft YaHei"/><w:sz w:val="22"/>
      </w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>${headingStyles}</w:styles>`),
    xmlEntry('word/document.xml', `<w:document xmlns:w="${wordNS}" xmlns:r="${relNS}"
      xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
      xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
      xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${body.join('')}
      <w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>
      </w:body></w:document>`),
  )
  return exportFile(doc.title, 'docx', mimeType, [zip(files)])
}
