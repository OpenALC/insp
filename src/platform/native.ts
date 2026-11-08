import type { AttachmentStore, Note, NoteGroup, PlatformAdapter, PlatformCapabilities, WorkspaceSnapshot } from '../domain/models'

export type NativeInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

export function createNativeAdapter(
  invoke: NativeInvoke,
  resolveAsset: (path: string) => string,
  platform: PlatformCapabilities['platform'],
  importImage: AttachmentStore['importImage'],
): PlatformAdapter {
  return {
    capabilities: { platform, encryptedStorage: false, sync: false },
    repository: {
      loadWorkspace: () => invoke<WorkspaceSnapshot>('load_workspace'),
      getNote: (id) => invoke<Note>('get_note', { id }),
      createNote: (groupId, kind = 'richtext') => invoke<Note>('create_note', { groupId, kind }),
      saveNote: (input) => invoke<Note>('save_note', { input }),
      deleteNote: (id) => invoke<void>('delete_note', { id }),
      createGroup: (name) => invoke<NoteGroup>('create_group', { name }),
      renameGroup: (id, name) => invoke<NoteGroup>('rename_group', { id, name }),
      deleteGroup: (id) => invoke<void>('delete_group', { id }),
    },
    attachments: {
      importImage,
      async resolveImage(id) {
        return resolveAsset(await invoke<string>('resolve_image', { id }))
      },
    },
  }
}

export async function readImageBytes(file: File) {
  if (file.size > 20 * 1024 * 1024) throw new Error('图片不能超过 20 MB。')
  return new Uint8Array(await file.arrayBuffer())
}
