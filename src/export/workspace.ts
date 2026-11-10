import type { PlatformAdapter, WorkspaceSnapshot } from '../domain/models'
import type { ExportFile } from './types'
import { zip, type ZipEntry } from './zip'

function attachmentIds(content: unknown): string[] {
  const ids = new Set<string>()
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return
    const item = node as { attrs?: { attachmentId?: string }; content?: unknown[] }
    if (item.attrs?.attachmentId) ids.add(item.attrs.attachmentId)
    item.content?.forEach(visit)
  }
  visit(content)
  return [...ids]
}

/** Portable transfer archive for the offline Native edition. The original vault is never modified. */
export async function exportWorkspaceForNative(snapshot: WorkspaceSnapshot, platform: PlatformAdapter): Promise<ExportFile> {
  const notes = await Promise.all(snapshot.notes.map(note => platform.repository.getNote(note.id)))
  const images = new Set(notes.flatMap(note => attachmentIds(note.content)))
  const entries: ZipEntry[] = []
  for (const id of images) {
    const blob = await platform.attachments.readImage(id)
    entries.push({ name: `attachments/${id}`, data: new Uint8Array(await blob.arrayBuffer()) })
  }
  const manifest = {
    format: 'openalc.insp.transfer.v1',
    groups: snapshot.groups,
    notes: notes.map(note => ({
      id: note.id, title: note.title, kind: note.kind, groupId: note.groupId,
      privacy: note.privacy, updatedAt: note.updatedAt, content: note.content,
    })),
  }
  entries.unshift({ name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify(manifest)) })
  return {
    filename: `拾页-Native-迁移-${new Date().toISOString().slice(0, 10)}.zip`,
    mimeType: 'application/zip', blob: zip(entries),
  }
}
