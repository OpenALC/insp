import type { JSONContent } from '@tiptap/core'
import type { MindMapDocument } from './mindmap'

export type NoteContent = JSONContent | MindMapDocument

export type NoteKind = 'richtext' | 'mindmap'
export type PrivacyMode = 'normal' | 'private'
export type SyncPolicy = 'localOnly' | 'sync'

export interface NoteGroup {
  id: string
  name: string
  parentId: string | null
  createdAt: string
  updatedAt: string
}

export interface NoteSummary {
  id: string
  title: string
  groupId: string | null
  kind: NoteKind
  privacy: PrivacyMode
  syncPolicy: SyncPolicy
  preview: string
  createdAt: string
  updatedAt: string
  revision: number
}

export interface Note extends NoteSummary {
  schemaVersion: number
  content: NoteContent
}

export interface NoteWrite {
  id: string
  title: string
  groupId: string | null
  content: NoteContent
  plainText: string
}

export interface WorkspaceSnapshot {
  groups: NoteGroup[]
  notes: NoteSummary[]
  dataDirectory: string
}

export interface Attachment {
  id: string
  mimeType: string
  originalName: string
  byteLength: number
}

export interface WorkspaceRepository {
  loadWorkspace(): Promise<WorkspaceSnapshot>
  getNote(id: string): Promise<Note>
  createNote(groupId: string | null, kind?: NoteKind): Promise<Note>
  saveNote(input: NoteWrite): Promise<Note>
  deleteNote(id: string): Promise<void>
  createGroup(name: string): Promise<NoteGroup>
  renameGroup(id: string, name: string): Promise<NoteGroup>
  deleteGroup(id: string): Promise<void>
}

export interface AttachmentStore {
  importImage(file: File): Promise<Attachment>
  resolveImage(id: string): Promise<string>
}

export interface PlatformCapabilities {
  platform: 'windows' | 'android' | 'harmonyos'
  encryptedStorage: boolean
  sync: boolean
}

export interface PlatformAdapter {
  repository: WorkspaceRepository
  attachments: AttachmentStore
  capabilities: PlatformCapabilities
}
