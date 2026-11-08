import type { Note, PrivacyMode, SyncPolicy } from '../domain/models'

export interface VaultState {
  ready: boolean
  initialized: boolean
  locked: boolean
  privateVisible: boolean
  busy: boolean
  syncing: boolean
  endpoint: string
  spaceId: string
  connectionCode: string
  lastSync: string
  syncError: string
}

export interface VaultController {
  state: VaultState
  initialize(): Promise<void>
  setSyncHooks(beforeApply: () => Promise<void>, afterApply: () => Promise<void>): void
  setup(password: string, connectionCode?: string): Promise<void>
  unlock(password: string): Promise<void>
  lock(): Promise<void>
  revealPrivate(password: string): Promise<void>
  hidePrivate(): void
  setNotePolicy(id: string, privacy: PrivacyMode, syncPolicy: SyncPolicy): Promise<Note>
  configureSync(endpoint: string): Promise<void>
  syncNow(): Promise<void>
}
