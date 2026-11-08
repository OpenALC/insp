import type { NoteKind, SyncPolicy } from '../domain/models'

export interface CipherEnvelope {
  version: 1
  algorithm: 'AES-256-GCM'
  keyId: string
  nonce: string
  ciphertext: string
}

export interface SyncMutation {
  operationId: string
  entityId: string
  entityType: 'note' | 'group' | 'attachment'
  baseRevision: number
  operation: 'put' | 'delete'
  payload: CipherEnvelope | null
}

export interface RemoteChange extends SyncMutation {
  revision: number
  sequence: number
}

export interface PushResult {
  accepted: { operationId: string; revision: number }[]
  conflicts: { operationId: string; current: RemoteChange }[]
}

export interface SyncTransport {
  push(mutations: SyncMutation[]): Promise<PushResult>
  pull(cursor: number): Promise<{ changes: RemoteChange[]; nextCursor: number; hasMore: boolean }>
  uploadAttachment(id: string, ciphertext: Uint8Array): Promise<void>
  downloadAttachment(id: string): Promise<Uint8Array>
}

export interface SyncQueue {
  pending(limit: number): Promise<SyncMutation[]>
  acknowledge(accepted: PushResult['accepted']): Promise<void>
  applyRemote(changes: RemoteChange[], nextCursor: number): Promise<void>
}

export interface VaultCrypto {
  encrypt(plaintext: Uint8Array, associatedData: Uint8Array): Promise<CipherEnvelope>
  decrypt(envelope: CipherEnvelope, associatedData: Uint8Array): Promise<Uint8Array>
  lock(): Promise<void>
}

export interface DocumentHeader {
  id: string
  kind: NoteKind
  schemaVersion: number
  syncPolicy: SyncPolicy
}
