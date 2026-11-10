import { reactive } from 'vue'
import type { Attachment, Note, NoteGroup, PlatformAdapter, PlatformCapabilities } from '../domain/models'
import { createMindMapDocument, mindMapPreview, mindMapText, unifyMindMapTitle, UNTITLED_MIND_MAP, type MindMapDocument } from '../domain/mindmap.ts'
import { isEmptyRichText } from '../domain/note-content.ts'
import type { NativeInvoke } from '../platform/native'
import type { CipherEnvelope, RemoteChange, SyncMutation, PushResult } from '../sync/contracts'
import { createVault, unlockVault, encryptValue, decryptValue, encodeBase64, decodeBase64, type VaultHeader } from './crypto.ts'
import type { VaultController, VaultState } from './types'

type StoredNote = Note & { deletedAt: string | null }
type StoredImage = Attachment & { dataBase64: string }
type Entity = { type: 'note'; value: StoredNote } | { type: 'group'; value: NoteGroup } | { type: 'attachment'; value: StoredImage }
type Row = { id: string; payload: string | null }
type Receipt = { serverRevision: number; localVersion: number; exists: boolean }
type Pending = SyncMutation & { localVersion: number; inFlight?: boolean }
type DeleteIntent = 'delete' | 'awaiting'
interface Metadata {
  dataDirectory: string
  config: { endpoint: string; token: string } | null
  cursor: number
  versions: Record<string, number>
  receipts: Record<string, Receipt>
  pending: Record<string, Pending>
  deleteIntents: Record<string, DeleteIntent>
  privacyCredential?: VaultHeader | null
  unlockSecret?: string
}
interface Legacy {
  groups: NoteGroup[]
  notes: StoredNote[]
  attachments: StoredImage[]
  dataDirectory: string
}
type ConnectionCode = { endpoint: string; spaceId: string; token: string } & (
  { version: 1 } | { version: 2; unlockSecret: string }
)
type CommitOptions = {
  remote?: boolean
  edit?: (meta: Metadata) => void
  revoke?: string[]
  markDeleteIntent?: string[]
  header?: string
  purgeLegacy?: boolean
}

const entityId = (entity: Entity) => `${entity.type}:${entity.value.id}`
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const timestamp = () => new Date().toISOString()
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const emptyMeta = (): Metadata => ({ dataDirectory: '', config: null, cursor: 0, versions: {}, receipts: {}, pending: {}, deleteIntents: {} })
const secretId = (spaceId: string) => `insp.vault.${spaceId}`

const eligibleForSync = (note: StoredNote) => !note.deletedAt && note.syncPolicy === 'sync'

function withUnifiedTitle(entity: Entity): Entity {
  if (entity.type !== 'note' || entity.value.kind !== 'mindmap') return entity
  const note = entity.value
  const content = unifyMindMapTitle(note.title, note.content as MindMapDocument)
  if (content === note.content) return entity
  return { type: 'note', value: { ...note, title: content.root.text, content, preview: mindMapText(content).replace(/\s+/g, ' ').slice(0, 180) } }
}

export function normalizeEndpoint(input: string): string {
  const url = new URL(input.trim())
  const host = url.hostname
  const octets = host.split('.').map(Number)
  const local = host === 'localhost' || host === '[::1]' || (octets.length === 4 && (
    octets[0] === 127 || octets[0] === 10 || (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31)))
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('同步地址需使用 HTTPS；本机和局域网联调可使用 HTTP。')
  if (url.username || url.password || url.search || url.hash) throw new Error('同步地址不能包含用户名、密码、查询参数或片段。')
  return url.toString().replace(/\/+$/, '')
}

function connectionString(config: ConnectionCode): string {
  return `insp${config.version}.` + encodeBase64(new TextEncoder().encode(JSON.stringify(config))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function parseConnection(code: string): ConnectionCode {
  const prefix = code.trim().slice(0, 6)
  if (prefix !== 'insp1.' && prefix !== 'insp2.') throw new Error('连接码格式不正确。')
  const encoded = code.trim().slice(6).replace(/-/g, '+').replace(/_/g, '/')
  const result = JSON.parse(new TextDecoder().decode(decodeBase64(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')))) as ConnectionCode
  if ((result.version !== 1 && result.version !== 2) || prefix !== `insp${result.version}.` ||
      !result.spaceId || typeof result.token !== 'string' || result.token.length < 32 ||
      (result.version === 2 && (typeof result.unlockSecret !== 'string' || !result.unlockSecret))) throw new Error('连接码格式不正确。')
  result.endpoint = normalizeEndpoint(result.endpoint)
  return result
}

function imageIds(content: unknown): Set<string> {
  const ids = new Set<string>()
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return
    const object = node as { attrs?: { attachmentId?: string }; content?: unknown[] }
    if (object.attrs?.attachmentId) ids.add(`attachment:${object.attrs.attachmentId}`)
    object.content?.forEach(visit)
  }
  visit(content)
  return ids
}

function imageType(bytes: Uint8Array): string {
  if (bytes.length >= 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (bytes.length >= 6 && bytes[0] === 71 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 56) return 'image/gif'
  if (bytes.length >= 12 && bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70 && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80) return 'image/webp'
  throw new Error('请选择 PNG、JPEG、GIF 或 WebP 图片。')
}

export class EncryptedWorkspace implements VaultController {
  readonly state: VaultState = reactive({ ready: false, initialized: false, locked: true, privateVisible: false, privacyConfigured: false, systemAuthAvailable: false, migrationRequired: false, busy: false, syncing: false, endpoint: '', spaceId: '', connectionCode: '', lastSync: '', syncError: '' })
  readonly platform: PlatformAdapter
  private header: VaultHeader | null = null
  private key: CryptoKey | null = null
  private meta = emptyMeta()
  private entities = new Map<string, Entity>()
  private rows = new Map<string, string | null>()
  private urls = new Map<string, string>()
  private queue: Promise<unknown> = Promise.resolve()
  private syncWork: Promise<void> | null = null
  private syncTimer: ReturnType<typeof setTimeout> | undefined
  private syncAgain = false
  private epoch = 0
  private privacyEpoch = 0
  private beforeApply: () => Promise<void> = async () => {}
  private afterApply: () => Promise<void> = async () => {}
  private invoke: NativeInvoke

  constructor(invoke: NativeInvoke, kind: PlatformCapabilities['platform']) {
    this.invoke = invoke
    this.platform = {
      capabilities: { platform: kind, encryptedStorage: true, sync: true },
      repository: {
        loadWorkspace: async () => {
          await this.queue
          this.requireKey()
          return {
            groups: copy(this.groups()),
            notes: this.notes().filter(n => !n.deletedAt && (n.privacy !== 'private' || this.state.privateVisible)).map(n => {
              const { content: _content, schemaVersion: _schema, deletedAt: _deleted, ...summary } = n
              return copy({ ...summary, mindMapPreview: n.kind === 'mindmap' ? mindMapPreview(n.content as MindMapDocument) : undefined })
            }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
            dataDirectory: this.meta.dataDirectory,
          }
        },
        getNote: async id => { await this.queue; return copy(this.note(id)) },
        createNote: (groupId, kind = 'richtext') => this.write(async () => {
          const now = timestamp()
          const title = kind === 'mindmap' ? UNTITLED_MIND_MAP : '未命名笔记'
          const note: StoredNote = { id: crypto.randomUUID(), title, groupId, kind, privacy: 'normal', syncPolicy: 'sync', preview: kind === 'mindmap' ? title : '', createdAt: now, updatedAt: now, revision: 1, schemaVersion: 1, content: kind === 'mindmap' ? createMindMapDocument(title) : { type: 'doc', content: [{ type: 'paragraph' }] }, deletedAt: null }
          await this.persist([{ type: 'note', value: note }])
          return copy(note)
        }),
        convertToMindMap: id => this.write(async () => {
          const previous = this.note(id)
          if (previous.kind !== 'richtext' || !isEmptyRichText(previous.content)) {
            throw new Error('只有空白笔记可以创建灵感笔记，已有正文和图片会保留。')
          }
          const title = previous.title === '未命名笔记' ? UNTITLED_MIND_MAP : previous.title
          const content = createMindMapDocument(title)
          const next: StoredNote = {
            ...previous, kind: 'mindmap', title, content, preview: content.root.text,
            updatedAt: timestamp(), revision: previous.revision + 1,
          }
          await this.persist([{ type: 'note', value: next }])
          return copy(next)
        }),
        saveNote: input => this.write(async () => {
          const previous = this.note(input.id)
          const content = copy(input.content)
          let title = input.title.trim() || '未命名笔记'
          let text = input.plainText
          if (previous.kind === 'mindmap') {
            const map = content as MindMapDocument
            title = map.root.text.trim() ? map.root.text : UNTITLED_MIND_MAP
            map.root.text = title
            text = mindMapText(map)
          }
          const next: StoredNote = { ...previous, title, groupId: input.groupId, content, preview: text.replace(/\s+/g, ' ').slice(0, 180), updatedAt: timestamp(), revision: previous.revision + 1 }
          await this.persist([{ type: 'note', value: next }], [], { markDeleteIntent: this.orphanedAttachments(previous, next) })
          return copy(next)
        }),
        deleteNote: id => this.write(async () => {
          const note = this.note(id)
          const deleted = { ...note, deletedAt: timestamp(), updatedAt: timestamp(), revision: note.revision + 1 }
          await this.persist([{ type: 'note', value: deleted }], [], {
            revoke: [`note:${id}`],
            markDeleteIntent: [...(eligibleForSync(note) ? [`note:${id}`] : []), ...this.orphanedAttachments(note, deleted)],
          })
        }),
        createGroup: name => this.write(async () => {
          const now = timestamp()
          const group: NoteGroup = { id: crypto.randomUUID(), name: name.trim(), parentId: null, createdAt: now, updatedAt: now }
          await this.persist([{ type: 'group', value: group }])
          return copy(group)
        }),
        renameGroup: (id, name) => this.write(async () => {
          const previous = this.entities.get('group:' + id)
          if (previous?.type !== 'group') throw new Error('分组不存在。')
          const group = { ...previous.value, name: name.trim(), updatedAt: timestamp() }
          await this.persist([{ type: 'group', value: group }])
          return copy(group)
        }),
        deleteGroup: id => this.write(async () => {
          const updates: Entity[] = this.notes().filter(n => n.groupId === id).map(n => ({ type: 'note', value: { ...n, groupId: null, revision: n.revision + 1, updatedAt: timestamp() } }))
          await this.persist(updates, ['group:' + id], { markDeleteIntent: ['group:' + id] })
        }),
      },
      attachments: {
        importImage: file => this.write(async () => {
          if (file.size > 20 * 1024 * 1024) throw new Error('图片不能超过 20 MB。')
          const bytes = new Uint8Array(await file.arrayBuffer())
          const attachment: StoredImage = { id: crypto.randomUUID(), mimeType: imageType(bytes), originalName: file.name, byteLength: bytes.length, dataBase64: encodeBase64(bytes) }
          await this.persist([{ type: 'attachment', value: attachment }])
          const { dataBase64: _bytes, ...metadata } = attachment
          return metadata
        }),
        resolveImage: async id => {
          await this.queue
          this.requireKey()
          this.requireImageAccess(id)
          const previous = this.urls.get(id)
          if (previous) return previous
          const url = URL.createObjectURL(await this.imageBlob(id))
          this.urls.set(id, url)
          return url
        },
        readImage: id => this.imageBlob(id),
      },
    }
  }

  setSyncHooks(beforeApply: () => Promise<void>, afterApply: () => Promise<void>): void {
    this.beforeApply = beforeApply
    this.afterApply = afterApply
  }

  async initialize(): Promise<void> {
    const serialized = await this.invoke<string | null>('vault_header')
    this.header = serialized ? JSON.parse(serialized) as VaultHeader : null
    this.state.initialized = this.header !== null
    this.state.spaceId = this.header?.id ?? ''
    this.state.ready = true
  }

  async openLocal(): Promise<void> {
    this.state.systemAuthAvailable = await this.invoke<boolean>('device_auth_status') === true
    if (!this.state.locked) return
    if (!this.header) {
      const secret = encodeBase64(crypto.getRandomValues(new Uint8Array(32)))
      await this.setupWorkspace(secret, undefined, true)
      return
    }
    const secret = await this.invoke<string | null>('device_secret_get', { id: secretId(this.header.id) })
    this.state.migrationRequired = secret === null
    if (secret !== null) await this.unlock(secret)
  }

  rememberLocalAccess(password: string): Promise<void> {
    return this.write(async () => {
      const epoch = this.epoch
      await unlockVault(this.header!, password)
      if (epoch !== this.epoch) throw new Error('加密空间已锁定。')
      await this.invoke<void>('device_secret_set', { id: secretId(this.header!.id), value: password })
      await this.persist([], [], { remote: true, edit: meta => { meta.unlockSecret = password } })
      this.state.migrationRequired = false
    })
  }

  private requireKey(): CryptoKey {
    if (!this.key || this.state.locked) throw new Error('请先解锁加密空间。')
    return this.key
  }

  private write<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.queue.then(() => { this.requireKey(); return action() })
    this.queue = operation.then(() => undefined, () => undefined)
    return operation
  }

  private notes(): StoredNote[] { return [...this.entities.values()].flatMap(e => e.type === 'note' ? [e.value] : []) }
  private groups(): NoteGroup[] { return [...this.entities.values()].flatMap(e => e.type === 'group' ? [e.value] : []) }
  private note(id: string): StoredNote {
    this.requireKey()
    const entity = this.entities.get('note:' + id)
    if (entity?.type !== 'note' || entity.value.deletedAt) throw new Error('笔记不存在或已删除。')
    if (entity.value.privacy === 'private' && !this.state.privateVisible) throw new Error('请先解锁隐私笔记。')
    return entity.value
  }

  private requireImageAccess(id: string): void {
    const references = this.notes().filter(note => imageIds(note.content).has('attachment:' + id))
    if (!this.state.privateVisible && references.length && references.every(note => note.privacy === 'private' || note.deletedAt)) {
      throw new Error('请先解锁隐私笔记。')
    }
  }

  private async imageBlob(id: string): Promise<Blob> {
    await this.queue
    this.requireKey()
    this.requireImageAccess(id)
    const epoch = this.epoch
    const entity = await this.readEntity('attachment:' + id)
    if (epoch !== this.epoch || this.state.locked) throw new Error('加密空间已锁定。')
    this.requireImageAccess(id)
    if (entity.type !== 'attachment') throw new Error('图片附件不存在。')
    return new Blob([decodeBase64(entity.value.dataBase64)], { type: entity.value.mimeType })
  }

  private async readEntity(id: string): Promise<Entity> {
    const key = this.requireKey()
    const cached = this.entities.get(id)
    if (cached) return cached
    const payload = this.rows.get(id) ?? await this.invoke<string | null>('vault_get', { id })
    if (!payload) throw new Error('本地加密记录不存在。')
    return decryptValue<Entity>(key, this.header!.id, id, JSON.parse(payload) as CipherEnvelope)
  }

  private async persist(entities: Entity[], removed: string[] = [], options: CommitOptions = {}): Promise<void> {
    entities = [...new Map(entities.map(entity => [entityId(entity), withUnifiedTitle(entity)])).values()]
    const key = this.requireKey()
    const meta = copy(this.meta)
    const puts: { id: string; payload: string }[] = []
    for (const entity of entities) {
      const id = entityId(entity)
      meta.versions[id] = (meta.versions[id] ?? 0) + 1
      puts.push({ id, payload: JSON.stringify(await encryptValue(key, this.header!.id, id, entity)) })
    }
    for (const id of removed) meta.versions[id] = (meta.versions[id] ?? 0) + 1
    for (const id of options.markDeleteIntent ?? []) {
      const pending = meta.pending[id]
      meta.deleteIntents[id] = meta.receipts[id]?.exists
        ? 'delete'
        : pending?.operation === 'put' && pending.inFlight ? 'awaiting' : 'delete'
      delete meta.pending[id]
    }
    for (const id of options.revoke ?? []) {
      if ((options.markDeleteIntent ?? []).includes(id)) continue
      const pending = meta.pending[id]
      if (meta.receipts[id]?.exists) meta.deleteIntents[id] = 'delete'
      else if (pending?.operation === 'put' && pending.inFlight) meta.deleteIntents[id] = 'awaiting'
      delete meta.pending[id]
    }
    options.edit?.(meta)
    puts.push({ id: '$meta', payload: JSON.stringify(await encryptValue(key, this.header!.id, '$meta', meta)) })
    await this.invoke<void>('vault_commit', { input: { puts, deletes: removed, header: options.header, purgeLegacy: options.purgeLegacy ?? false } })
    this.meta = meta
    const encryptedRows = new Map(puts.map(row => [row.id, row.payload]))
    for (const entity of entities) {
      const id = entityId(entity)
      this.rows.set(id, entity.type === 'attachment' ? null : encryptedRows.get(id)!)
      if (entity.type !== 'attachment') this.entities.set(id, copy(entity))
    }
    for (const id of removed) { this.entities.delete(id); this.rows.delete(id) }
    this.updateState()
    if (!options.remote) this.scheduleSync()
  }

  private updateState() {
    this.state.endpoint = this.meta.config?.endpoint ?? ''
    this.state.spaceId = this.header?.id ?? ''
    this.state.privacyConfigured = this.meta.privacyCredential !== null
    this.state.connectionCode = this.meta.config ? connectionString({ ...this.meta.config, spaceId: this.header!.id,
      ...(this.meta.unlockSecret ? { version: 2, unlockSecret: this.meta.unlockSecret } as const : { version: 1 } as const),
    }) : ''
  }

  async setup(password: string, connectionCode?: string): Promise<void> {
    await this.setupWorkspace(password, connectionCode)
  }

  joinWorkspace(code: string, password?: string): Promise<void> {
    const operation = this.queue.then(async () => {
      if (this.state.initialized) this.requireKey()
      const rows = await this.invoke<Row[]>('vault_list')
      const legacy = await this.invoke<Legacy>('vault_legacy_export')
      if (rows.some(row => row.id !== '$meta') || (!this.state.initialized && rows.length) ||
          this.entities.size || legacy.notes.length || legacy.groups.length || legacy.attachments.length ||
          [this.meta.versions, this.meta.receipts, this.meta.pending, this.meta.deleteIntents].some(history => Object.keys(history).length)) {
        throw new Error('仅能在完全空白的本地空间连接已有空间；请先保留现有笔记、回收站、分组和附件。')
      }
      const epoch = this.epoch
      const connection = parseConnection(code)
      const secret = connection.version === 2 ? connection.unlockSecret : password
      if (!secret) throw new Error('此旧版连接码需要原空间口令。')
      this.state.busy = true
      try {
        const { header } = await this.request<{ header: VaultHeader }>(connection, 'GET', '')
        if (header.id !== connection.spaceId) throw new Error('同步空间标识不匹配。')
        const key = await unlockVault(header, secret)
        if (epoch !== this.epoch) throw new Error('加密空间已锁定。')
        const meta: Metadata = {
          ...emptyMeta(), dataDirectory: this.state.initialized ? this.meta.dataDirectory : legacy.dataDirectory,
          config: { endpoint: connection.endpoint, token: connection.token }, unlockSecret: secret,
          ...(connection.version === 2 ? { privacyCredential: null } : {}),
        }
        const payload = JSON.stringify(await encryptValue(key, header.id, '$meta', meta))
        // Store the new space's secret first; a failed commit leaves the old space and its secret intact.
        await this.invoke<void>('device_secret_set', { id: secretId(header.id), value: secret })
        await this.invoke<void>('vault_commit', { input: {
          header: JSON.stringify(header), puts: [{ id: '$meta', payload }], deletes: [], purgeLegacy: true,
        } })
        this.clearMemory()
        this.header = header
        this.key = key
        this.meta = meta
        this.rows.set('$meta', payload)
        this.state.initialized = true
        this.state.locked = false
        this.state.migrationRequired = false
        this.state.lastSync = ''
        this.state.syncError = ''
        this.updateState()
      } finally { this.state.busy = false }
    })
    this.queue = operation.then(() => undefined, () => undefined)
    return operation.then(() => this.syncNow())
  }

  private async setupWorkspace(password: string, connectionCode?: string, remember = false): Promise<void> {
    if (this.state.initialized) throw new Error('本机已有加密空间，请使用原口令解锁。')
    this.state.busy = true
    try {
      let config: Metadata['config'] = null
      if (connectionCode?.trim()) {
        const connection = parseConnection(connectionCode)
        const response = await this.request<{ header: VaultHeader }>(connection, 'GET', '')
        if (response.header.id !== connection.spaceId) throw new Error('同步空间标识不匹配。')
        this.header = response.header
        if (connection.version === 2) password = connection.unlockSecret
        this.key = await unlockVault(this.header, password)
        config = { endpoint: connection.endpoint, token: connection.token }
      } else {
        const created = await createVault(password)
        this.header = created.header
        this.key = created.key
      }
      const legacy = await this.invoke<Legacy>('vault_legacy_export')
      this.meta = { ...emptyMeta(), config, dataDirectory: legacy.dataDirectory }
      if (remember) {
        await this.invoke<void>('device_secret_set', { id: secretId(this.header!.id), value: password })
        this.meta.privacyCredential = null
        this.meta.unlockSecret = password
      }
      this.state.locked = false
      const entities: Entity[] = [
        ...legacy.groups.map(value => ({ type: 'group' as const, value })),
        ...legacy.notes.map(value => ({ type: 'note' as const, value: { ...value, deletedAt: value.deletedAt ?? null, syncPolicy: value.privacy === 'private' ? value.syncPolicy : 'sync' as const } })),
        ...legacy.attachments.map(value => ({ type: 'attachment' as const, value })),
      ]
      await this.persist(entities, [], { header: JSON.stringify(this.header), purgeLegacy: true, remote: true })
      this.state.initialized = true
      this.state.migrationRequired = false
    } catch (error) {
      this.clearMemory()
      await this.initialize()
      throw error
    } finally { this.state.busy = false }
    if (this.meta.config) await this.syncNow()
  }

  async unlock(password: string): Promise<void> {
    const epoch = this.epoch
    this.state.busy = true
    try {
      const key = await unlockVault(this.header!, password)
      const rows = await this.invoke<Row[]>('vault_list')
      const metaRow = rows.find(row => row.id === '$meta')
      if (!metaRow?.payload) throw new Error('加密空间元数据缺失，请从完整备份恢复。')
      const meta = await decryptValue<Metadata>(key, this.header!.id, '$meta', JSON.parse(metaRow.payload) as CipherEnvelope)
      meta.deleteIntents ??= {}
      const entities = new Map<string, Entity>()
      for (const row of rows) {
        if (row.id === '$meta' || row.payload === null) continue
        const entity = await decryptValue<Entity>(key, this.header!.id, row.id, JSON.parse(row.payload) as CipherEnvelope)
        if (entityId(entity) !== row.id) throw new Error('加密记录标识不匹配。')
        entities.set(row.id, withUnifiedTitle(entity))
      }
      if (epoch !== this.epoch) throw new Error('加密空间已锁定。')
      this.key = key
      this.meta = meta
      this.entities = entities
      this.rows = new Map(rows.map(row => [row.id, row.payload]))
      this.state.locked = false
      this.state.privateVisible = false
      this.updateState()
      this.scheduleSync()
    } finally { this.state.busy = false }
  }

  private clearMemory() {
    this.epoch++
    this.privacyEpoch++
    if (this.syncTimer) clearTimeout(this.syncTimer)
    this.key = null
    this.meta = emptyMeta()
    this.entities.clear()
    this.rows.clear()
    this.urls.forEach(url => URL.revokeObjectURL(url))
    this.urls.clear()
    this.state.locked = true
    this.state.privateVisible = false
    this.state.connectionCode = ''
    this.state.endpoint = ''
    this.syncWork = null
    this.state.syncing = false
    this.syncAgain = false
  }

  async lock(): Promise<void> { await this.queue; this.clearMemory() }
  async revealPrivate(password: string): Promise<void> {
    this.requireKey()
    const epoch = this.epoch
    const privacyEpoch = this.privacyEpoch
    const credential = this.meta.privacyCredential
    if (credential === null) throw new Error('请先设置隐私 PIN 或复杂口令，或使用系统认证。')
    await unlockVault(credential ?? this.header!, password)
    if (epoch !== this.epoch || privacyEpoch !== this.privacyEpoch) throw new Error('隐私区已锁定，请重新认证。')
    this.state.privateVisible = true
  }

  async revealPrivateWithSystem(): Promise<void> {
    this.requireKey()
    const epoch = this.epoch
    const privacyEpoch = this.privacyEpoch
    const authenticated = await this.invoke<boolean>('device_authenticate')
    if (epoch !== this.epoch || privacyEpoch !== this.privacyEpoch) throw new Error('隐私区已锁定，请重新认证。')
    if (authenticated !== true) throw new Error('系统认证未通过或已取消。')
    this.state.privateVisible = true
  }

  setPrivacyPassword(password: string): Promise<void> {
    return this.write(async () => {
      if (this.meta.privacyCredential !== null && !this.state.privateVisible) throw new Error('请先认证隐私区，再修改隐私口令。')
      const privacyEpoch = this.privacyEpoch
      const { header } = await createVault(password)
      if (privacyEpoch !== this.privacyEpoch) throw new Error('隐私区已锁定，请重新认证。')
      await this.persist([], [], { remote: true, edit: meta => { meta.privacyCredential = header } })
    })
  }

  hidePrivate(): void {
    this.privacyEpoch++
    this.state.privateVisible = false
    const publicImages = new Set(this.notes().filter(n => !n.deletedAt && n.privacy === 'normal').flatMap(n => [...imageIds(n.content)]))
    for (const note of this.notes().filter(n => n.privacy === 'private')) {
      for (const id of imageIds(note.content)) {
        if (publicImages.has(id)) continue
        const imageId = id.slice('attachment:'.length)
        const url = this.urls.get(imageId)
        if (url) URL.revokeObjectURL(url)
        this.urls.delete(imageId)
      }
    }
  }

  setNotePolicy(id: string, privacy: Note['privacy'], syncPolicy: Note['syncPolicy']): Promise<Note> {
    return this.write(async () => {
      const note = this.note(id)
      const next = { ...note, privacy, syncPolicy, updatedAt: timestamp(), revision: note.revision + 1 }
      const revoke = eligibleForSync(note) && !eligibleForSync(next)
        ? [`note:${id}`, ...this.orphanedAttachments(note, next)]
        : []
      await this.persist([{ type: 'note', value: next }], [], { revoke })
      return copy(next)
    })
  }

  private scheduleSync() {
    if (!this.meta.config || this.state.locked) return
    if (this.state.syncing) { this.syncAgain = true; return }
    if (this.syncTimer) clearTimeout(this.syncTimer)
    this.syncTimer = setTimeout(() => {
      this.syncTimer = undefined
      void this.syncNow().catch(error => { this.state.syncError = message(error) })
    }, 1200)
  }

  private async request<T>(config: { endpoint: string; token: string; spaceId?: string }, method: string, suffix: string, body?: unknown): Promise<T> {
    const response = await this.invoke<{ status: number; body: string }>('sync_http', { input: { url: `${config.endpoint}/v1/spaces/${encodeURIComponent(config.spaceId ?? this.header!.id)}${suffix}`, method, token: config.token, body: body === undefined ? undefined : JSON.stringify(body) } })
    if (response.status < 200 || response.status >= 300) throw new Error(response.status === 401 ? '同步凭据无效，请检查连接码。' : `同步服务返回 HTTP ${response.status}。`)
    return JSON.parse(response.body) as T
  }

  private orphanedAttachments(previous: StoredNote, next: StoredNote): string[] {
    if (!eligibleForSync(previous)) return []
    const nextImages = eligibleForSync(next) ? imageIds(next.content) : new Set<string>()
    return [...imageIds(previous.content)].filter(id => !nextImages.has(id) && !this.notes().some(note =>
      note.id !== previous.id && eligibleForSync(note) && imageIds(note.content).has(id)))
  }

  async configureSync(endpoint: string): Promise<void> {
    await this.queue
    this.requireKey()
    const normalizedEndpoint = normalizeEndpoint(endpoint)
    const endpointChanged = this.meta.config !== null && normalizeEndpoint(this.meta.config.endpoint) !== normalizedEndpoint
    const token = this.meta.config?.token ?? encodeBase64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const config = { endpoint: normalizedEndpoint, token }
    const result = await this.request<{ header: VaultHeader }>(config, 'PUT', '', { header: this.header })
    const remote = result.header
    const local = this.header!
    if (remote.version !== local.version || remote.id !== local.id || remote.kdf.algorithm !== local.kdf.algorithm || remote.kdf.iterations !== local.kdf.iterations || remote.kdf.salt !== local.kdf.salt || remote.wrappedKey.algorithm !== local.wrappedKey.algorithm || remote.wrappedKey.keyId !== local.wrappedKey.keyId || remote.wrappedKey.nonce !== local.wrappedKey.nonce || remote.wrappedKey.ciphertext !== local.wrappedKey.ciphertext) throw new Error('远端空间密钥与本机不一致，未上传笔记。')
    await this.write(() => this.persist([], [], { remote: true, edit: meta => {
      if (endpointChanged) {
        meta.cursor = 0
        meta.receipts = {}
        meta.pending = {}
        meta.deleteIntents = {}
      }
      meta.config = config
    } }))
    await this.syncNow()
  }

  private desired(): Set<string> {
    const ids = new Set<string>()
    for (const note of this.notes()) {
      if (note.deletedAt || note.syncPolicy !== 'sync') continue
      ids.add('note:' + note.id)
      if (note.groupId && this.rows.has('group:' + note.groupId)) ids.add('group:' + note.groupId)
      for (const id of imageIds(note.content)) ids.add(id)
    }
    return ids
  }

  private async preparePending(): Promise<Pending[]> {
    return this.write(async () => {
      const desired = this.desired()
      const pending: Record<string, Pending> = {}
      const deleteIntents = { ...this.meta.deleteIntents }
      for (const id of new Set([...desired, ...Object.keys(this.meta.receipts), ...Object.keys(deleteIntents)])) {
        const receipt = this.meta.receipts[id]
        const version = this.meta.versions[id] ?? 0
        const operation = desired.has(id) ? 'put' : 'delete'
        if (operation === 'put') delete deleteIntents[id]
        else if (!deleteIntents[id]) continue
        else if (deleteIntents[id] === 'awaiting') continue
        else if (!receipt?.exists) { delete deleteIntents[id]; continue }
        if ((operation === 'put' && receipt?.exists && receipt.localVersion === version) || (operation === 'delete' && !receipt?.exists)) continue
        const previous = this.meta.pending[id]
        if (previous && previous.localVersion === version && previous.operation === operation && previous.baseRevision === (receipt?.serverRevision ?? 0)) { pending[id] = previous; continue }
        const serialized = operation === 'put' ? this.rows.get(id) ?? await this.invoke<string | null>('vault_get', { id }) : null
        if (operation === 'put' && !serialized) throw new Error('同步图片或笔记的本地密文缺失，未提交不完整文档。')
        pending[id] = { operationId: crypto.randomUUID(), entityId: id, entityType: id.split(':')[0] as SyncMutation['entityType'], baseRevision: receipt?.serverRevision ?? 0, operation, payload: serialized ? JSON.parse(serialized) as CipherEnvelope : null, localVersion: version }
      }
      await this.persist([], [], { remote: true, edit: meta => { meta.pending = pending; meta.deleteIntents = deleteIntents } })
      const priority = (p: Pending) => p.operation === 'put'
        ? ({ attachment: 0, group: 1, note: 2 }[p.entityType])
        : ({ note: 3, group: 4, attachment: 5 }[p.entityType])
      return copy(Object.values(pending).sort((a, b) => priority(a) - priority(b)))
    })
  }

  private async applyRemote(changes: RemoteChange[], cursor: number, epoch: number): Promise<void> {
    if (epoch !== this.epoch) return
    const hasUnappliedChanges = changes.some(change => change.revision > (this.meta.receipts[change.entityId]?.serverRevision ?? 0))
    if (hasUnappliedChanges) await this.beforeApply()
    try {
      await this.write(async () => {
        if (epoch !== this.epoch) return
        const updates: Entity[] = []
        const effectiveNotes = new Map(this.notes().map(note => [note.id, note]))
        const removed: string[] = []
        const acknowledgements: { change: RemoteChange; keepDirty: boolean }[] = []
        for (const change of changes) {
          const id = change.entityId
          const receipt = this.meta.receipts[id]
          if (change.revision <= (receipt?.serverRevision ?? 0)) continue
          const existing = this.entities.get(id)
          const pending = this.meta.pending[id]
          const own = pending?.operationId === change.operationId
          const dirty = (this.meta.versions[id] ?? 0) > (receipt?.localVersion ?? 0)
          const localOnly = existing?.type === 'note' && existing.value.syncPolicy === 'localOnly'
          let next: Entity | null = null
          if (change.operation === 'put') {
            if (!change.payload) throw new Error('远端密文记录不完整。')
            next = await decryptValue<Entity>(this.requireKey(), this.header!.id, id, change.payload)
            if (entityId(next) !== id || next.type !== change.entityType) throw new Error('远端加密记录标识不匹配。')
          }
          const newerLocal = own && (this.meta.versions[id] ?? 0) > pending.localVersion
          const locallyDeleted = change.operation === 'put' && this.meta.deleteIntents[id] && (
            (existing?.type === 'note' && Boolean(existing.value.deletedAt)) || (id.startsWith('group:') && !existing)
          )
          if (localOnly || newerLocal || locallyDeleted) { acknowledgements.push({ change, keepDirty: true }); continue }
          if (!own && dirty && existing?.type === 'note' && !existing.value.deletedAt) {
            const localCopy: StoredNote = { ...copy(existing.value), id: crypto.randomUUID(), title: existing.value.title + '（冲突副本）', syncPolicy: 'localOnly', revision: 1, updatedAt: timestamp() }
            if (localCopy.kind === 'mindmap') {
              const map = localCopy.content as MindMapDocument
              map.root.text = localCopy.title
              localCopy.preview = mindMapText(map).replace(/\s+/g, ' ').slice(0, 180)
            }
            updates.push({ type: 'note', value: localCopy })
            effectiveNotes.set(localCopy.id, localCopy)
          }
          if (!own && dirty && existing?.type === 'group') {
            updates.push({ type: 'group', value: { ...existing.value, id: crypto.randomUUID(), name: existing.value.name + '（本地副本）', updatedAt: timestamp() } })
          }
          if (next) {
            updates.push(next)
            if (next.type === 'note') effectiveNotes.set(next.value.id, next.value)
          } else if (existing?.type === 'note') {
            const deleted = { ...existing.value, deletedAt: timestamp(), revision: existing.value.revision + 1 }
            updates.push({ type: 'note', value: deleted })
            effectiveNotes.set(deleted.id, deleted)
          }
          else if (existing?.type === 'group') {
            if (![...effectiveNotes.values()].some(n => !n.deletedAt && n.syncPolicy === 'localOnly' && n.groupId === existing.value.id)) removed.push(id)
          } else if (id.startsWith('attachment:')) {
            if (![...effectiveNotes.values()].some(n => !n.deletedAt && imageIds(n.content).has(id))) removed.push(id)
          }
          acknowledgements.push({ change, keepDirty: false })
        }
        await this.persist(updates, removed, { remote: true, edit: meta => {
          meta.cursor = Math.max(meta.cursor, cursor)
          for (const { change, keepDirty } of acknowledgements) {
            const id = change.entityId
            meta.receipts[id] = { serverRevision: change.revision, exists: change.operation === 'put', localVersion: keepDirty ? (meta.receipts[id]?.localVersion ?? 0) : (meta.versions[id] ?? 0) }
            delete meta.pending[id]
            if (change.operation === 'delete') delete meta.deleteIntents[id]
          }
        } })
      })
    } finally { if (hasUnappliedChanges && epoch === this.epoch) await this.afterApply() }
  }

  private async pull(epoch: number) {
    let hasMore = true
    while (hasMore && epoch === this.epoch) {
      const page = await this.request<{ changes: RemoteChange[]; nextCursor: number; hasMore: boolean }>(this.meta.config!, 'GET', `/changes?cursor=${this.meta.cursor}&limit=100`)
      if (epoch !== this.epoch) return
      await this.applyRemote(page.changes, page.nextCursor, epoch)
      hasMore = page.hasMore
    }
    if (epoch === this.epoch) await this.write(() => this.persist([], [], { remote: true, edit: meta => {
      for (const [id, intent] of Object.entries(meta.deleteIntents)) {
        if (intent !== 'awaiting') continue
        if (meta.receipts[id]?.exists) meta.deleteIntents[id] = 'delete'
      }
    } }))
  }

  syncNow(): Promise<void> {
    if (this.syncWork) return this.syncWork
    if (this.state.locked || !this.meta.config) return Promise.resolve()
    if (this.syncTimer) clearTimeout(this.syncTimer)
    const epoch = this.epoch
    this.state.syncing = true
    this.state.syncError = ''
    this.syncAgain = false
    const operation = (async () => {
      await this.pull(epoch)
      for (let round = 0; round < 2 && epoch === this.epoch; round++) {
        const pending = await this.preparePending()
        if (!pending.length) break
        // Attachments can approach 27 MB after base64; send each mutation independently.
        for (const mutation of pending) {
          if (epoch !== this.epoch) return
          let shouldSend = false
          await this.write(() => this.persist([], [], { remote: true, edit: meta => {
            const current = meta.pending[mutation.entityId]
            if (current?.operationId !== mutation.operationId) return
            const desired = this.desired().has(mutation.entityId)
            if (mutation.operation === 'put' ? !desired : desired || !meta.deleteIntents[mutation.entityId] || meta.deleteIntents[mutation.entityId] === 'awaiting') return
            current.inFlight = true
            shouldSend = true
          } }))
          if (!shouldSend) continue
          const { localVersion, inFlight: _inFlight, ...wire } = mutation
          const result = await this.request<PushResult>(this.meta.config!, 'POST', '/push', { mutations: [wire] })
          if (epoch !== this.epoch) return
          await this.write(() => this.persist([], [], { remote: true, edit: meta => {
            for (const accepted of result.accepted) {
              const current = meta.pending[mutation.entityId]
              if (current?.operationId !== accepted.operationId) continue
              meta.receipts[mutation.entityId] = { serverRevision: accepted.revision, localVersion, exists: mutation.operation === 'put' }
              delete meta.pending[mutation.entityId]
              if (mutation.operation === 'delete') delete meta.deleteIntents[mutation.entityId]
            }
          } }))
          if (result.conflicts.length) await this.applyRemote(result.conflicts.map(c => c.current), this.meta.cursor, epoch)
        }
        await this.pull(epoch)
      }
      if (epoch === this.epoch) this.state.lastSync = timestamp()
    })()
    const tracked = operation.catch(error => {
      if (epoch === this.epoch) this.state.syncError = message(error)
      throw error
    }).finally(() => {
      if (this.syncWork !== tracked) return
      this.syncWork = null
      this.state.syncing = false
      if (this.syncAgain && epoch === this.epoch) this.scheduleSync()
    })
    this.syncWork = tracked
    return tracked
  }
}
