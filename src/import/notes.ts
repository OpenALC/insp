import { Editor, type JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import { Markdown } from '@tiptap/markdown'
import Image from '@tiptap/extension-image'
import { unzipSync } from 'fflate'

export interface ImportedNote {
  title: string
  content: JSONContent
  plainText: string
}

function plainDocument(text: string): JSONContent {
  return {
    type: 'doc',
    content: text.replace(/\r\n?/g, '\n').split(/\n\n+/).map(paragraph => ({
      type: 'paragraph',
      content: paragraph.split('\n').flatMap((line, index) => [
        ...(index ? [{ type: 'hardBreak' }] : []),
        ...(line ? [{ type: 'text', text: line }] : []),
      ]),
    })),
  }
}

function parseNote(name: string, text: string, titleOverride = ''): ImportedNote {
  const title = titleOverride || name.replace(/\.(md|markdown|txt)$/i, '').split(/[\\/]/).pop() || '导入的笔记'
  if (/\.(md|markdown)$/i.test(name)) {
    const editor = new Editor({ extensions: [StarterKit, TaskList, TaskItem.configure({ nested: true }), Image, Markdown] })
    const content = editor.markdown!.parse(text)
    editor.destroy()
    return { title, content, plainText: text }
  }
  return { title, content: plainDocument(text), plainText: text }
}

function imageMime(name: string) {
  return /\.png$/i.test(name) ? 'image/png' : /\.webp$/i.test(name) ? 'image/webp' : /\.gif$/i.test(name) ? 'image/gif' : 'image/jpeg'
}

async function resolveImages(node: JSONContent, archive: Record<string, Uint8Array>, importImage: (file: File) => Promise<string>): Promise<void> {
  if (node.type === 'image') {
    const source = String(node.attrs?.src ?? '')
    const name = source.split('?')[0].split('/').pop() ?? ''
    const bytes = archive[`attachment/${name}`]
    if (bytes) {
      node.attrs = { attachmentId: await importImage(new File([new Uint8Array(bytes)], name, { type: imageMime(name) })), alt: node.attrs?.alt ?? '' }
    } else {
      node.type = 'paragraph'
      node.content = [{ type: 'text', text: `${node.attrs?.alt || '图片'}：${source}` }]
      delete node.attrs
    }
  }
  for (const child of node.content ?? []) await resolveImages(child, archive, importImage)
}

export async function readImportedNotes(file: File, importImage: (file: File) => Promise<string>): Promise<ImportedNote[]> {
  if (/\.(md|markdown|txt)$/i.test(file.name)) {
    const note = parseNote(file.name, await file.text())
    await resolveImages(note.content, {}, importImage)
    return [note]
  }
  if (/\.(png|jpe?g|gif|webp)$/i.test(file.name)) {
    const attachmentId = await importImage(file)
    const title = file.name.replace(/\.(png|jpe?g|gif|webp)$/i, '') || '导入的图片'
    return [{ title, plainText: title, content: { type: 'doc', content: [{ type: 'image', attrs: { attachmentId, alt: title } }] } }]
  }
  if (/\.zip$/i.test(file.name)) {
    const archive = unzipSync(new Uint8Array(await file.arrayBuffer()), {
      filter: entry => (/\.(md|markdown|txt|json|png|jpe?g|gif|webp)$/i.test(entry.name)) && entry.originalSize <= 20_000_000,
    })
    if (archive['metadata.json'] && archive['content.md']) {
      const metadata = JSON.parse(new TextDecoder().decode(archive['metadata.json'])) as { title?: string; noteType?: string }
      const markdown = new TextDecoder().decode(archive['content.md'])
      const firstLine = markdown.split('\n').find(line => line.trim())?.replace(/<[^>]+>|[*_`~#]/g, '').trim().slice(0, 48) ?? ''
      const note = parseNote('content.md', markdown, metadata.title?.trim() || firstLine || '导入的小米笔记')
      await resolveImages(note.content, archive, importImage)
      return [note]
    }
    const notes = Object.entries(archive).filter(([name]) => /\.(md|markdown|txt)$/i.test(name)).map(([name, bytes]) => parseNote(name, new TextDecoder().decode(bytes)))
    for (const note of notes) await resolveImages(note.content, archive, importImage)
    if (notes.length) return notes
    throw new Error('ZIP 中未找到可导入的笔记。')
  }
  throw new Error(`不支持的文件：${file.name}`)
}
