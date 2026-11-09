import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Attachment, Note, NoteGroup } from '../domain/models'
import type { NativeInvoke } from '../platform/native'
import type { CipherEnvelope, RemoteChange, SyncMutation } from '../sync/contracts'
import { decryptValue, unlockVault, type VaultHeader } from './crypto.ts'
import { EncryptedWorkspace } from './workspace.ts'

const PASSWORD = 'workspace test passphrase'
const ENDPOINT = 'https://sync.example.test'
const ENDPOINT_B = 'https://sync-b.example.test'
const IMAGE_BASE64 = 'aW1hZ2UtYnl0ZXM='
const DELETED_AT = '2025-01-02T03:04:05.000Z'

type LegacyNote = Note & { deletedAt: string | null }
type LegacyAttachment = Attachment & { dataBase64: string }
type Legacy = { groups: NoteGroup[]; notes: LegacyNote[]; attachments: LegacyAttachment[]; dataDirectory: string }
type StoredEntity =
  | { type: 'note'; value: LegacyNote }
  | { type: 'attachment'; value: LegacyAttachment }
  | { type: 'group'; value: NoteGroup }
type CommitInput = { header?: string; puts: { id: string; payload: string }[]; deletes: string[]; purgeLegacy: boolean }
type HttpInput = { url: string; method: string; token: string; body?: string }
type Space = { header: VaultHeader; token: string; changes: RemoteChange[]; current: Map<string, RemoteChange> }

function emptyLegacy(): Legacy {
  return { groups: [], notes: [], attachments: [], dataDirectory: 'legacy-data' }
}

function document(text: string): Note['content'] {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }
}

function legacyNote(
  id: string,
  title: string,
  options: { deletedAt?: string | null; privacy?: Note['privacy']; syncPolicy?: Note['syncPolicy']; body?: string } = {},
): LegacyNote {
  const now = '2025-01-01T00:00:00.000Z'
  const body = options.body ?? title
  return {
    id, title, groupId: null, kind: 'richtext', privacy: options.privacy ?? 'normal',
    syncPolicy: options.syncPolicy ?? 'localOnly', preview: body, createdAt: now, updatedAt: now,
    revision: 1, schemaVersion: 1, content: document(body), deletedAt: options.deletedAt ?? null,
  }
}

function createStore(legacy = emptyLegacy()) {
  return {
    header: null as string | null, rows: new Map<string, string | null>(), legacy: structuredClone(legacy),
    secrets: new Map<string, string>(), systemAuthAvailable: false, authenticate: async (): Promise<boolean> => false,
  }
}

class MemorySyncServer {
  online = true
  pushOnline = true
  captureRejectedPush = false
  beforePush?: () => Promise<void>
  mutations: SyncMutation[] = []
  readonly rejectedPushes: { spaceId: string; mutation: SyncMutation }[] = []
  private sequence = 0
  private spaces = new Map<string, Space>()

  latest(spaceId: string, entityId: string): RemoteChange | undefined {
    return this.spaces.get(spaceId)?.current.get(entityId)
  }

  commitLatePush(spaceId: string, mutation: SyncMutation): void {
    const space = this.spaces.get(spaceId)!
    const current = space.current.get(mutation.entityId)
    const revision = current?.revision ?? 0
    if (mutation.baseRevision !== revision) return
    const change: RemoteChange = { ...structuredClone(mutation), revision: revision + 1, sequence: ++this.sequence }
    space.current.set(change.entityId, change)
    space.changes.push(change)
    this.mutations.push(structuredClone(mutation))
  }

  async handle(input: HttpInput): Promise<{ status: number; body: string }> {
    if (!this.online) return this.reply(503, {})
    const url = new URL(input.url)
    const path = url.pathname.split('/')
    if (path[1] !== 'v1' || path[2] !== 'spaces' || !path[3]) return this.reply(404, {})
    const spaceId = decodeURIComponent(path[3])
    const route = path.slice(4).join('/')

    if (input.method === 'PUT' && route === '') {
      const { header } = JSON.parse(input.body!) as { header: VaultHeader }
      const existing = this.spaces.get(spaceId)
      if (existing && existing.token !== input.token) return this.reply(401, {})
      this.spaces.set(spaceId, existing ?? { header, token: input.token, changes: [], current: new Map() })
      this.spaces.get(spaceId)!.header = header
      return this.reply(200, { header })
    }

    const space = this.spaces.get(spaceId)
    if (!space) return this.reply(404, {})
    if (space.token !== input.token) return this.reply(401, {})
    if (input.method === 'GET' && route === '') return this.reply(200, { header: space.header })

    if (input.method === 'GET' && route === 'changes') {
      const cursor = Number(url.searchParams.get('cursor') ?? 0)
      return this.reply(200, {
        changes: space.changes.filter(change => change.sequence > cursor),
        nextCursor: space.changes.at(-1)?.sequence ?? cursor,
        hasMore: false,
      })
    }

    if (input.method === 'POST' && route === 'push') {
      const { mutations } = JSON.parse(input.body!) as { mutations: SyncMutation[] }
      if (!this.pushOnline) {
        if (this.captureRejectedPush) this.rejectedPushes.push(...mutations.map(mutation => ({ spaceId, mutation: structuredClone(mutation) })))
        return this.reply(503, {})
      }
      await this.beforePush?.()
      const accepted: { operationId: string; revision: number }[] = []
      const conflicts: { operationId: string; current: RemoteChange }[] = []
      for (const mutation of mutations) {
        this.mutations.push(structuredClone(mutation))
        const current = space.current.get(mutation.entityId)
        const revision = current?.revision ?? 0
        if (mutation.baseRevision !== revision) {
          if (current) conflicts.push({ operationId: mutation.operationId, current: structuredClone(current) })
          continue
        }
        const change: RemoteChange = { ...mutation, revision: revision + 1, sequence: ++this.sequence }
        space.current.set(change.entityId, change)
        space.changes.push(change)
        accepted.push({ operationId: change.operationId, revision: change.revision })
      }
      return this.reply(200, { accepted, conflicts })
    }

    return this.reply(404, {})
  }

  private reply(status: number, value: unknown) {
    return { status, body: JSON.stringify(value) }
  }
}

function nativeInvoke(
  store: ReturnType<typeof createStore>,
  server?: MemorySyncServer | ((input: HttpInput) => Promise<{ status: number; body: string }> | { status: number; body: string }),
): NativeInvoke {
  return async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    let result: unknown
    switch (command) {
      case 'device_secret_get': result = store.secrets.get((args as { id: string }).id) ?? null; break
      case 'device_secret_set': {
        const { id, value } = args as { id: string; value: string }
        store.secrets.set(id, value)
        break
      }
      case 'device_auth_status': result = store.systemAuthAvailable; break
      case 'device_authenticate': result = await store.authenticate(); break
      case 'vault_header': result = store.header; break
      case 'vault_list': result = [...store.rows].map(([id, payload]) => ({ id, payload })); break
      case 'vault_get': result = store.rows.get((args as { id: string }).id) ?? null; break
      case 'vault_legacy_export': result = structuredClone(store.legacy); break
      case 'vault_commit': {
        const { input } = args as { input: CommitInput }
        if (input.header !== undefined) store.header = input.header
        for (const { id, payload } of input.puts) store.rows.set(id, payload)
        for (const id of input.deletes) store.rows.delete(id)
        if (input.purgeLegacy) store.legacy = emptyLegacy()
        result = undefined
        break
      }
      case 'sync_http': {
        const input = (args as { input: HttpInput }).input
        result = typeof server === 'function' ? server(input) : server!.handle(input)
        break
      }
      default: throw new Error(`Unexpected native command: ${command}`)
    }
    return result as T
  }
}

function workspace(store: ReturnType<typeof createStore>, server?: MemorySyncServer | ((input: HttpInput) => Promise<{ status: number; body: string }> | { status: number; body: string })) {
  return new EncryptedWorkspace(nativeInvoke(store, server), 'windows')
}

async function persistedMetadata(store: ReturnType<typeof createStore>, password = PASSWORD) {
  const header = JSON.parse(store.header!) as VaultHeader
  const key = await unlockVault(header, password)
  return decryptValue<{ receipts: Record<string, unknown>; pending: Record<string, { operation?: string; inFlight?: boolean }>; deleteIntents: Record<string, string> }>(
    key, header.id, '$meta', JSON.parse(store.rows.get('$meta')!) as CipherEnvelope,
  )
}

async function editNote(instance: EncryptedWorkspace, id: string, title: string, body: string) {
  const previous = await instance.platform.repository.getNote(id)
  return instance.platform.repository.saveNote({ id, title, groupId: previous.groupId, content: document(body), plainText: body })
}

test('sync acknowledgements keep the editor active while new remote edits still refresh it', async () => {
  const server = new MemorySyncServer()
  const instance = workspace(createStore(), server)
  await instance.initialize()
  await instance.setup(PASSWORD)
  await instance.configureSync(ENDPOINT)
  let before = 0
  let after = 0
  instance.setSyncHooks(async () => { before++ }, async () => { after++ })
  const note = await instance.platform.repository.createNote(null)
  await editNote(instance, note.id, 'Typing', 'Keep the keyboard open')
  await instance.syncNow()
  await instance.syncNow()
  assert.deepEqual({ before, after }, { before: 0, after: 0 })

  const peer = workspace(createStore(), server)
  await peer.initialize()
  await peer.setup(PASSWORD, instance.state.connectionCode)
  await editNote(peer, note.id, 'Remote edit', 'Content from another device')
  await peer.syncNow()
  await instance.syncNow()
  assert.deepEqual({ before, after }, { before: 1, after: 1 })
  assert.deepEqual((await instance.platform.repository.getNote(note.id)).content, document('Content from another device'))
  await peer.lock()
  await instance.lock()
})

test('setup encrypts legacy notes, tombstones, and image bytes; locking blocks reads and wrong passwords', async () => {
  const deleted = legacyNote('deleted-note', 'MIGRATION_SECRET_TITLE', { deletedAt: DELETED_AT, body: 'MIGRATION_SECRET_BODY' })
  const active = legacyNote('active-note', 'ACTIVE_SECRET_TITLE', { body: 'ACTIVE_SECRET_BODY' })
  active.content = {
    type: 'doc',
    content: [{ type: 'image', attrs: { attachmentId: 'legacy-image' } }],
  }
  const legacy = emptyLegacy()
  legacy.notes = [active, deleted]
  legacy.attachments = [{ id: 'legacy-image', mimeType: 'image/png', originalName: 'IMAGE_SECRET_NAME.png', byteLength: 11, dataBase64: IMAGE_BASE64 }]

  const store = createStore(legacy)
  const instance = workspace(store)
  await instance.initialize()
  await instance.setup(PASSWORD)

  assert.ok(store.rows.has('note:active-note'))
  assert.ok(store.rows.has('note:deleted-note'))
  assert.ok(store.rows.has('attachment:legacy-image'))
  const persisted = JSON.stringify({ header: store.header, rows: [...store.rows] })
  for (const secret of ['MIGRATION_SECRET_TITLE', 'MIGRATION_SECRET_BODY', 'ACTIVE_SECRET_TITLE', 'IMAGE_SECRET_NAME.png', IMAGE_BASE64]) {
    assert.equal(persisted.includes(secret), false)
  }

  const header = JSON.parse(store.header!) as VaultHeader
  const key = await unlockVault(header, PASSWORD)
  const deletedRecord = await decryptValue<StoredEntity>(key, header.id, 'note:deleted-note', JSON.parse(store.rows.get('note:deleted-note')!) as CipherEnvelope)
  const imageRecord = await decryptValue<StoredEntity>(key, header.id, 'attachment:legacy-image', JSON.parse(store.rows.get('attachment:legacy-image')!) as CipherEnvelope)
  assert.equal(deletedRecord.type, 'note')
  if (deletedRecord.type === 'note') assert.equal(deletedRecord.value.deletedAt, DELETED_AT)
  assert.equal(imageRecord.type, 'attachment')
  if (imageRecord.type === 'attachment') assert.equal(imageRecord.value.dataBase64, IMAGE_BASE64)

  await instance.lock()
  await assert.rejects(instance.platform.repository.getNote('active-note'), /请先解锁/)
  await assert.rejects(instance.unlock('wrong password for this vault'), /口令错误或密钥库数据已损坏/)
  assert.equal(instance.state.locked, true)
})

test('a new workspace instance restores persisted records and sync metadata after unlock', async () => {
  const server = new MemorySyncServer()
  const group: NoteGroup = { id: 'persisted-group', name: 'Persisted group', parentId: null, createdAt: DELETED_AT, updatedAt: DELETED_AT }
  const note = legacyNote('persisted-note', 'Persisted note', { body: 'Persisted body' })
  note.groupId = group.id
  note.content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'image', attrs: { attachmentId: 'persisted-image' } }] }] }
  const legacy = emptyLegacy()
  legacy.groups = [group]
  legacy.notes = [note]
  legacy.attachments = [{ id: 'persisted-image', mimeType: 'image/png', originalName: 'persisted.png', byteLength: 11, dataBase64: IMAGE_BASE64 }]
  const store = createStore(legacy)
  const first = workspace(store, server)
  await first.initialize()
  await first.setup(PASSWORD)
  await first.configureSync(ENDPOINT)
  const mutationCount = server.mutations.length
  await first.lock()

  const restarted = workspace(store, server)
  await restarted.initialize()
  await restarted.unlock(PASSWORD)
  const loaded = await restarted.platform.repository.loadWorkspace()
  assert.deepEqual(loaded.groups.map(item => item.id), [group.id])
  assert.deepEqual(loaded.notes.map(item => item.id), [note.id])
  assert.equal((await restarted.platform.repository.getNote(note.id)).title, note.title)
  assert.equal(restarted.state.endpoint, ENDPOINT)

  await restarted.syncNow()
  assert.equal(server.mutations.length, mutationCount)
})

test('missing local entity rows after restart never turn remote receipts into deletes', async () => {
  const server = new MemorySyncServer()
  const group: NoteGroup = { id: 'retained-group', name: 'Retained group', parentId: null, createdAt: DELETED_AT, updatedAt: DELETED_AT }
  const note = legacyNote('retained-note', 'Retained note', { body: 'Retained body' })
  note.groupId = group.id
  note.content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'image', attrs: { attachmentId: 'retained-image' } }] }] }
  const legacy = emptyLegacy()
  legacy.groups = [group]
  legacy.notes = [note]
  legacy.attachments = [{ id: 'retained-image', mimeType: 'image/png', originalName: 'retained.png', byteLength: 11, dataBase64: IMAGE_BASE64 }]
  const store = createStore(legacy)
  const first = workspace(store, server)
  await first.initialize()
  await first.setup(PASSWORD)
  await first.configureSync(ENDPOINT)
  const mutationCount = server.mutations.length
  assert.equal(mutationCount, 3)
  await first.lock()

  for (const id of [...store.rows.keys()]) if (id !== '$meta') store.rows.delete(id)
  const restarted = workspace(store, server)
  await restarted.initialize()
  await restarted.unlock(PASSWORD)
  await restarted.syncNow()

  assert.equal(server.mutations.length, mutationCount)
  for (const id of ['note:retained-note', 'group:retained-group', 'attachment:retained-image']) {
    assert.equal(server.latest(restarted.state.spaceId, id)?.operation, 'put')
  }
  assert.deepEqual((await persistedMetadata(store)).deleteIntents, {})
})

test('a PIN vault joins a second device and protects private notes until sync is enabled', async () => {
  const pin = '048216'
  const server = new MemorySyncServer()
  const legacy = emptyLegacy()
  legacy.notes = [legacyNote('private-note', 'Private title', { privacy: 'private', syncPolicy: 'localOnly', body: 'Private body' })]
  const store = createStore(legacy)
  const source = workspace(store, server)
  await source.initialize()
  await source.setup(pin)
  await source.configureSync(ENDPOINT)

  assert.deepEqual((await source.platform.repository.loadWorkspace()).notes, [])
  assert.deepEqual((await persistedMetadata(store, pin)).deleteIntents, {})
  await assert.rejects(source.platform.repository.getNote('private-note'), /请先解锁隐私笔记/)
  assert.equal(server.mutations.some(mutation => mutation.entityId === 'note:private-note'), false)

  await source.revealPrivate(pin)
  await source.setNotePolicy('private-note', 'private', 'sync')
  source.hidePrivate()
  await source.syncNow()
  assert.equal(server.latest(source.state.spaceId, 'note:private-note')?.operation, 'put')

  const second = workspace(createStore(), server)
  await second.initialize()
  await second.setup(pin, source.state.connectionCode)
  assert.deepEqual((await second.platform.repository.loadWorkspace()).notes, [])
  await assert.rejects(second.platform.repository.getNote('private-note'), /请先解锁隐私笔记/)
  await assert.rejects(second.revealPrivate('048217'), /口令错误/)
  await second.revealPrivate(pin)
  assert.equal((await second.platform.repository.getNote('private-note')).title, 'Private title')
})

test('changing a synced note to localOnly sends a remote delete and keeps the local copy', async () => {
  const server = new MemorySyncServer()
  const store = createStore()
  const instance = workspace(store, server)
  await instance.initialize()
  await instance.setup(PASSWORD)
  const note = await instance.platform.repository.createNote(null)
  await instance.configureSync(ENDPOINT)
  assert.equal(server.latest(instance.state.spaceId, `note:${note.id}`)?.operation, 'put')

  await instance.setNotePolicy(note.id, 'normal', 'localOnly')
  await instance.syncNow()

  assert.equal(server.latest(instance.state.spaceId, `note:${note.id}`)?.operation, 'delete')
  assert.ok(store.rows.has(`note:${note.id}`))
  const local = await instance.platform.repository.getNote(note.id)
  assert.equal(local.syncPolicy, 'localOnly')
})

test('opting out atomically cancels an unconfirmed upload but keeps awaiting its remote result', async () => {
  const server = new MemorySyncServer()
  const store = createStore()
  const instance = workspace(store, server)
  await instance.initialize()
  await instance.setup(PASSWORD)
  await instance.configureSync(ENDPOINT)

  const note = await instance.platform.repository.createNote(null)
  server.pushOnline = false
  await assert.rejects(instance.syncNow(), /HTTP 503/)
  const attempted = await persistedMetadata(store)
  assert.equal(attempted.pending[`note:${note.id}`]?.inFlight, true)

  await instance.setNotePolicy(note.id, 'normal', 'localOnly')
  const optedOut = await persistedMetadata(store)
  assert.equal(optedOut.pending[`note:${note.id}`], undefined)
  assert.equal(optedOut.deleteIntents[`note:${note.id}`], 'awaiting')

  server.pushOnline = true
  await instance.syncNow()
  const settled = await persistedMetadata(store)
  assert.equal(settled.pending[`note:${note.id}`], undefined)
  assert.equal(settled.deleteIntents[`note:${note.id}`], 'awaiting')
  assert.equal(server.mutations.some(mutation => mutation.entityId === `note:${note.id}`), false)
  assert.equal(server.latest(instance.state.spaceId, `note:${note.id}`), undefined)
})

test('an awaiting opt-out survives an empty pull and deletes a late remote put on the next sync', async () => {
  const server = new MemorySyncServer()
  const store = createStore()
  const instance = workspace(store, server)
  await instance.initialize()
  await instance.setup(PASSWORD)
  await instance.configureSync(ENDPOINT)
  const note = await instance.platform.repository.createNote(null)

  server.captureRejectedPush = true
  server.pushOnline = false
  await assert.rejects(instance.syncNow(), /HTTP 503/)
  await instance.setNotePolicy(note.id, 'normal', 'localOnly')
  const rejected = server.rejectedPushes.shift()!
  assert.equal(rejected.mutation.entityId, `note:${note.id}`)
  assert.equal((await persistedMetadata(store)).deleteIntents[`note:${note.id}`], 'awaiting')

  server.pushOnline = true
  await instance.syncNow()
  assert.equal((await persistedMetadata(store)).deleteIntents[`note:${note.id}`], 'awaiting')
  assert.equal(server.latest(instance.state.spaceId, `note:${note.id}`), undefined)

  server.commitLatePush(rejected.spaceId, rejected.mutation)
  await instance.syncNow()
  assert.equal(server.latest(instance.state.spaceId, `note:${note.id}`)?.operation, 'delete')
  assert.equal((await persistedMetadata(store)).deleteIntents[`note:${note.id}`], undefined)
  const local = await instance.platform.repository.getNote(note.id)
  assert.equal(local.syncPolicy, 'localOnly')
})

test('an explicit delete during an in-flight first upload keeps its tombstone and deletes the late remote put', async () => {
  const server = new MemorySyncServer()
  const store = createStore()
  const instance = workspace(store, server)
  await instance.initialize()
  await instance.setup(PASSWORD)
  await instance.configureSync(ENDPOINT)
  const note = await instance.platform.repository.createNote(null)

  let signalStarted!: () => void
  let releasePush!: () => void
  const started = new Promise<void>(resolve => { signalStarted = resolve })
  const blocked = new Promise<void>(resolve => { releasePush = resolve })
  let blockFirstPush = true
  server.beforePush = async () => {
    if (!blockFirstPush) return
    blockFirstPush = false
    signalStarted()
    await blocked
  }
  const upload = instance.syncNow()
  await started
  await instance.platform.repository.deleteNote(note.id)
  assert.equal((await persistedMetadata(store)).deleteIntents[`note:${note.id}`], 'awaiting')
  releasePush()
  await upload

  assert.equal(server.latest(instance.state.spaceId, `note:${note.id}`)?.operation, 'delete')
  await assert.rejects(instance.platform.repository.getNote(note.id), /笔记不存在或已删除/)
})

test('explicit deletion revokes only unreferenced synced attachments and groups', async () => {
  const server = new MemorySyncServer()
  const group: NoteGroup = { id: 'explicit-group', name: 'Explicit group', parentId: null, createdAt: DELETED_AT, updatedAt: DELETED_AT }
  const first = legacyNote('first-shared-note', 'First note')
  const second = legacyNote('second-shared-note', 'Second note')
  for (const note of [first, second]) {
    note.groupId = group.id
    note.content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'image', attrs: { attachmentId: 'shared-image' } }] }] }
  }
  const legacy = emptyLegacy()
  legacy.groups = [group]
  legacy.notes = [first, second]
  legacy.attachments = [{ id: 'shared-image', mimeType: 'image/png', originalName: 'shared.png', byteLength: 11, dataBase64: IMAGE_BASE64 }]
  const instance = workspace(createStore(legacy), server)
  await instance.initialize()
  await instance.setup(PASSWORD)
  await instance.configureSync(ENDPOINT)

  await instance.platform.repository.deleteNote(first.id)
  await instance.syncNow()
  assert.equal(server.latest(instance.state.spaceId, `note:${first.id}`)?.operation, 'delete')
  assert.equal(server.latest(instance.state.spaceId, 'attachment:shared-image')?.operation, 'put')
  assert.equal(server.latest(instance.state.spaceId, `group:${group.id}`)?.operation, 'put')

  await instance.platform.repository.deleteNote(second.id)
  await instance.syncNow()
  assert.equal(server.latest(instance.state.spaceId, `note:${second.id}`)?.operation, 'delete')
  assert.equal(server.latest(instance.state.spaceId, 'attachment:shared-image')?.operation, 'delete')
  assert.equal(server.latest(instance.state.spaceId, `group:${group.id}`)?.operation, 'put')

  await instance.platform.repository.deleteGroup(group.id)
  await instance.syncNow()
  assert.equal(server.latest(instance.state.spaceId, `group:${group.id}`)?.operation, 'delete')
})

test('changing endpoints clears deletion intent tied to the previous server', async () => {
  const serverA = new MemorySyncServer()
  const serverB = new MemorySyncServer()
  const store = createStore()
  const instance = workspace(store, input => (new URL(input.url).hostname === new URL(ENDPOINT).hostname ? serverA : serverB).handle(input))
  await instance.initialize()
  await instance.setup(PASSWORD)
  const note = await instance.platform.repository.createNote(null)
  await instance.configureSync(ENDPOINT)
  await instance.setNotePolicy(note.id, 'normal', 'localOnly')
  assert.equal((await persistedMetadata(store)).deleteIntents[`note:${note.id}`], 'delete')

  await instance.configureSync(ENDPOINT_B)
  const metadata = await persistedMetadata(store)
  assert.deepEqual(metadata.receipts, {})
  assert.deepEqual(metadata.deleteIntents, {})
  assert.equal(serverA.latest(instance.state.spaceId, `note:${note.id}`)?.operation, 'put')
  assert.equal(serverB.latest(instance.state.spaceId, `note:${note.id}`), undefined)
})

test('switching sync endpoints reuploads eligible entities and keeps localOnly data private', async () => {
  const serverA = new MemorySyncServer()
  const serverB = new MemorySyncServer()
  const legacy = emptyLegacy()
  const group: NoteGroup = { id: 'eligible-group', name: 'Eligible group', parentId: null, createdAt: DELETED_AT, updatedAt: DELETED_AT }
  const eligibleNote = legacyNote('eligible-note', 'Eligible note', { body: 'Eligible body' })
  eligibleNote.groupId = group.id
  eligibleNote.content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'image', attrs: { attachmentId: 'eligible-image' } }] }] }
  const localOnlyNote = legacyNote('local-only-note', 'Local only note', { privacy: 'private', syncPolicy: 'localOnly', body: 'Do not upload' })
  legacy.groups = [group]
  legacy.notes = [eligibleNote, localOnlyNote]
  legacy.attachments = [{ id: 'eligible-image', mimeType: 'image/png', originalName: 'eligible.png', byteLength: 11, dataBase64: IMAGE_BASE64 }]
  const routedServer = (input: HttpInput) => (new URL(input.url).hostname === new URL(ENDPOINT).hostname ? serverA : serverB).handle(input)
  const instance = workspace(createStore(legacy), routedServer)
  await instance.initialize()
  await instance.setup(PASSWORD)
  await instance.configureSync(ENDPOINT)
  await instance.configureSync(ENDPOINT_B)

  assert.deepEqual(serverA.mutations.map(mutation => mutation.entityId).sort(), ['attachment:eligible-image', 'group:eligible-group', 'note:eligible-note'])
  assert.deepEqual(serverB.mutations.map(mutation => mutation.entityId).sort(), ['attachment:eligible-image', 'group:eligible-group', 'note:eligible-note'])
  for (const id of ['attachment:eligible-image', 'group:eligible-group', 'note:eligible-note']) {
    assert.equal(serverB.latest(instance.state.spaceId, id)?.operation, 'put')
  }
  assert.equal(serverB.latest(instance.state.spaceId, 'note:local-only-note'), undefined)

  const mutationCount = serverB.mutations.length
  await instance.configureSync('HTTPS://SYNC-B.EXAMPLE.TEST:443/')
  assert.equal(serverB.mutations.length, mutationCount)
})

test('offline edits on the same note preserve the losing edit as a local conflict copy', async () => {
  const server = new MemorySyncServer()
  const source = workspace(createStore(), server)
  await source.initialize()
  await source.setup(PASSWORD)
  const note = await source.platform.repository.createNote(null)
  await editNote(source, note.id, 'Shared baseline', 'baseline body')
  await source.configureSync(ENDPOINT)

  const second = workspace(createStore(), server)
  await second.initialize()
  await second.setup(PASSWORD, source.state.connectionCode)
  await editNote(source, note.id, 'Edited on device A', 'device A body')
  const losingEdit = await editNote(second, note.id, 'Edited on device B', 'device B body')

  server.online = false
  await assert.rejects(source.syncNow())
  await assert.rejects(second.syncNow())
  server.online = true
  await source.syncNow()
  await second.syncNow()

  assert.equal((await second.platform.repository.getNote(note.id)).title, 'Edited on device A')
  const summaries = await second.platform.repository.loadWorkspace()
  const conflict = summaries.notes.find(item => item.title === 'Edited on device B（冲突副本）')
  assert.ok(conflict)
  const localCopy = await second.platform.repository.getNote(conflict.id)
  assert.equal(localCopy.syncPolicy, 'localOnly')
  assert.deepEqual(localCopy.content, losingEdit.content)
})

test('blank-to-mindmap preserves identity, group and private sync policy across restart and sync', async () => {
  const server = new MemorySyncServer()
  const store = createStore()
  const source = workspace(store, server)
  await source.initialize()
  await source.setup(PASSWORD)
  const group = await source.platform.repository.createGroup('思考')
  const blank = await source.platform.repository.createNote(group.id)
  await source.platform.repository.saveNote({ id: blank.id, title: '计划', groupId: group.id, content: { type: 'doc', content: [{ type: 'paragraph' }] }, plainText: '' })
  await source.setNotePolicy(blank.id, 'private', 'localOnly')
  await source.revealPrivate(PASSWORD)
  const converted = await source.platform.repository.convertToMindMap(blank.id)
  assert.equal(converted.id, blank.id)
  assert.equal(converted.groupId, group.id)
  assert.equal(converted.title, '计划')
  assert.equal(converted.kind, 'mindmap')
  assert.equal(converted.privacy, 'private')
  assert.equal(converted.syncPolicy, 'localOnly')
  assert.equal((converted.content as { root: { text: string } }).root.text, '计划')
  await source.configureSync(ENDPOINT)
  assert.equal(server.latest(source.state.spaceId, 'note:' + blank.id), undefined)
  await source.setNotePolicy(blank.id, 'private', 'sync')
  await source.syncNow()
  const joined = workspace(createStore(), server)
  await joined.initialize()
  await joined.setup(PASSWORD, source.state.connectionCode)
  assert.equal((await joined.platform.repository.loadWorkspace()).notes.length, 0)
  await joined.revealPrivate(PASSWORD)
  assert.deepEqual((await joined.platform.repository.getNote(blank.id)).content, converted.content)
  const restarted = workspace(store, server)
  await restarted.initialize()
  await restarted.unlock(PASSWORD)
  await restarted.revealPrivate(PASSWORD)
  assert.equal((await restarted.platform.repository.getNote(blank.id)).kind, 'mindmap')
})

test('blank-to-mindmap refuses text and attachment-only notes without changing their content', async () => {
  const instance = workspace(createStore())
  await instance.initialize()
  await instance.setup(PASSWORD)
  for (const content of [
    document('正文'),
    { type: 'doc', content: [{ type: 'image', attrs: { attachmentId: 'keep-image' } }] },
  ]) {
    const blank = await instance.platform.repository.createNote(null)
    const saved = await instance.platform.repository.saveNote({ id: blank.id, title: blank.title, groupId: null, content, plainText: '' })
    await assert.rejects(instance.platform.repository.convertToMindMap(blank.id), /只有空白笔记/)
    assert.deepEqual(await instance.platform.repository.getNote(blank.id), saved)
  }
})

test('openLocal stores a high entropy secret before creating the vault and reopens normal notes without a password', async () => {
  const store = createStore()
  store.systemAuthAvailable = true
  const invoke = nativeInvoke(store)
  const calls: string[] = []
  const first = new EncryptedWorkspace(async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push(command)
    if (command === 'vault_commit') assert.equal(store.secrets.size, 1)
    return invoke<T>(command, args)
  }, 'windows')
  await first.initialize()
  assert.deepEqual(calls, ['vault_header'])
  await first.openLocal()
  assert.equal(first.state.systemAuthAvailable, true)
  assert.equal(first.state.privacyConfigured, false)
  assert.equal(first.state.migrationRequired, false)
  assert.equal(first.state.locked, false)
  const secret = store.secrets.get(`insp.vault.${first.state.spaceId}`)!
  assert.ok(secret.length >= 43)
  const note = await first.platform.repository.createNote(null)
  await editNote(first, note.id, 'Normal note', 'Local body')
  assert.equal(JSON.stringify({ header: store.header, rows: [...store.rows] }).includes(secret), false)
  await first.lock()

  const restarted = workspace(store)
  await restarted.initialize()
  await restarted.openLocal()
  assert.equal(restarted.state.locked, false)
  assert.equal(restarted.state.privateVisible, false)
  assert.equal(restarted.state.privacyConfigured, false)
  assert.equal((await restarted.platform.repository.getNote(note.id)).title, 'Normal note')
  await restarted.lock()
})

test('failure to store the device secret never creates a vault or purges legacy data', async () => {
  const legacy = emptyLegacy()
  legacy.notes = [legacyNote('keep-legacy', 'Keep legacy')]
  const store = createStore(legacy)
  const invoke = nativeInvoke(store)
  let fail = true
  const instance = new EncryptedWorkspace(async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    if (fail && command === 'device_secret_set') throw new Error('Secure storage unavailable')
    return invoke<T>(command, args)
  }, 'windows')
  await instance.initialize()
  await assert.rejects(instance.openLocal(), /Secure storage unavailable/)
  assert.equal(store.header, null)
  assert.equal(store.rows.size, 0)
  assert.deepEqual(store.legacy, legacy)
  assert.equal(instance.state.locked, true)
  fail = false
  await instance.openLocal()
  assert.equal((await instance.platform.repository.getNote('keep-legacy')).title, 'Keep legacy')
  await instance.lock()
})

test('legacy encrypted vaults require their original password once and preserve legacy private authentication after migration', async () => {
  const legacy = emptyLegacy()
  legacy.notes = [legacyNote('legacy-private', 'Keep private', { privacy: 'private' }), legacyNote('legacy-normal', 'Keep normal')]
  const store = createStore(legacy)
  const original = workspace(store)
  await original.initialize()
  await original.setup(PASSWORD)
  await original.lock()
  const originalHeader = store.header
  const originalNote = store.rows.get('note:legacy-private')

  const migrated = workspace(store)
  await migrated.initialize()
  await migrated.openLocal()
  assert.equal(migrated.state.locked, true)
  assert.equal(migrated.state.migrationRequired, true)
  await assert.rejects(migrated.unlock('wrong original password'), /口令错误/)
  assert.equal(store.secrets.size, 0)
  await migrated.unlock(PASSWORD)
  assert.equal(migrated.state.privacyConfigured, true)
  await assert.rejects(migrated.setPrivacyPassword('123456'), /先认证隐私区/)
  await assert.rejects(migrated.rememberLocalAccess('wrong original password'), /口令错误/)
  assert.equal(store.secrets.size, 0)
  await migrated.rememberLocalAccess(PASSWORD)
  assert.equal(migrated.state.migrationRequired, false)
  assert.equal(store.header, originalHeader)
  assert.equal(store.rows.get('note:legacy-private'), originalNote)
  await migrated.lock()

  const restarted = workspace(store)
  await restarted.initialize()
  await restarted.openLocal()
  assert.equal(restarted.state.migrationRequired, false)
  assert.equal(restarted.state.locked, false)
  assert.equal(restarted.state.privateVisible, false)
  assert.equal((await restarted.platform.repository.getNote('legacy-normal')).title, 'Keep normal')
  await assert.rejects(restarted.platform.repository.getNote('legacy-private'), /解锁隐私/)
  await restarted.revealPrivate(PASSWORD)
  assert.equal((await restarted.platform.repository.getNote('legacy-private')).title, 'Keep private')
  await restarted.setPrivacyPassword('123456')
  restarted.hidePrivate()
  await assert.rejects(restarted.revealPrivate(PASSWORD), /口令错误/)
  await restarted.revealPrivate('123456')
  assert.equal(store.header, originalHeader)
  assert.equal(store.rows.get('note:legacy-private'), originalNote)
  await restarted.lock()
})

test('private PINs are independent from automatic local access and changes require private authentication', async () => {
  const store = createStore()
  const instance = workspace(store)
  await instance.initialize()
  await instance.openLocal()
  const secret = store.secrets.get(`insp.vault.${instance.state.spaceId}`)!
  const note = await instance.platform.repository.createNote(null)
  await instance.setNotePolicy(note.id, 'private', 'localOnly')
  const header = store.header
  const encryptedNote = store.rows.get(`note:${note.id}`)
  await assert.rejects(instance.revealPrivate(secret), /先设置隐私/)
  await assert.rejects(instance.setPrivacyPassword('12345'), /6 位数字/)
  assert.equal(instance.state.privacyConfigured, false)
  await instance.setPrivacyPassword('135790')
  assert.equal(instance.state.privacyConfigured, true)
  assert.equal(instance.state.privateVisible, false)
  await assert.rejects(instance.revealPrivate(secret), /口令错误/)
  await instance.revealPrivate('135790')
  assert.equal((await instance.platform.repository.getNote(note.id)).privacy, 'private')
  instance.hidePrivate()
  await assert.rejects(instance.setPrivacyPassword('246802'), /先认证隐私区/)
  await instance.revealPrivate('135790')
  const passphrase = 'independent privacy passphrase'
  await instance.setPrivacyPassword(passphrase)
  instance.hidePrivate()
  await assert.rejects(instance.revealPrivate('135790'), /口令错误/)
  await instance.revealPrivate(passphrase)
  assert.equal(store.header, header)
  assert.equal(store.rows.get(`note:${note.id}`), encryptedNote)
  assert.deepEqual([...store.secrets.values()], [secret])
  const persisted = JSON.stringify({ header: store.header, rows: [...store.rows] })
  for (const credential of [secret, '135790', passphrase]) assert.equal(persisted.includes(credential), false)
  await instance.lock()

  const restarted = workspace(store)
  await restarted.initialize()
  await restarted.openLocal()
  assert.equal(restarted.state.privacyConfigured, true)
  assert.equal(restarted.state.privateVisible, false)
  await assert.rejects(restarted.revealPrivate(secret), /口令错误/)
  await restarted.revealPrivate(passphrase)
  assert.equal((await restarted.platform.repository.getNote(note.id)).privacy, 'private')
  await restarted.lock()
})

test('system authentication rejects failures, cancellation and late success after hiding or locking', async () => {
  const store = createStore()
  store.systemAuthAvailable = true
  const instance = workspace(store)
  await instance.initialize()
  await instance.openLocal()
  await assert.rejects(instance.revealPrivateWithSystem(), /未通过或已取消/)
  assert.equal(instance.state.privateVisible, false)
  store.authenticate = async () => { throw new Error('Authentication cancelled') }
  await assert.rejects(instance.revealPrivateWithSystem(), /Authentication cancelled/)
  assert.equal(instance.state.privateVisible, false)
  store.authenticate = async () => 1 as unknown as boolean
  await assert.rejects(instance.revealPrivateWithSystem(), /未通过或已取消/)
  assert.equal(instance.state.privateVisible, false)

  let finish!: (result: boolean) => void
  store.authenticate = () => new Promise<boolean>(resolve => { finish = resolve })
  const hidden = instance.revealPrivateWithSystem()
  instance.hidePrivate()
  finish(true)
  await assert.rejects(hidden, /隐私区已锁定/)
  assert.equal(instance.state.privateVisible, false)
  assert.equal(instance.state.locked, false)

  const locked = instance.revealPrivateWithSystem()
  await instance.lock()
  finish(true)
  await assert.rejects(locked, /隐私区已锁定/)
  assert.equal(instance.state.privateVisible, false)
  assert.equal(instance.state.locked, true)

  await instance.openLocal()
  store.authenticate = async () => true
  await instance.revealPrivateWithSystem()
  assert.equal(instance.state.privateVisible, true)
  instance.hidePrivate()
  assert.equal(instance.state.privateVisible, false)
  assert.equal(instance.state.locked, false)
  await instance.lock()
})

test('hiding privacy invalidates a pending PIN verification and prevents private image access while normal notes remain open', async () => {
  const legacy = emptyLegacy()
  const note = legacyNote('private-image-note', 'Private image', { privacy: 'private' })
  note.content = { type: 'doc', content: [{ type: 'image', attrs: { attachmentId: 'private-image' } }] }
  legacy.notes = [note]
  legacy.attachments = [{ id: 'private-image', mimeType: 'image/png', originalName: 'private.png', byteLength: 11, dataBase64: IMAGE_BASE64 }]
  const store = createStore(legacy)
  const instance = workspace(store)
  await instance.initialize()
  await instance.openLocal()
  await instance.setPrivacyPassword('864209')
  const pending = instance.revealPrivate('864209')
  instance.hidePrivate()
  await assert.rejects(pending, /隐私区已锁定/)
  await assert.rejects(instance.platform.attachments.resolveImage('private-image'), /解锁隐私/)
  await instance.revealPrivate('864209')
  assert.match(await instance.platform.attachments.resolveImage('private-image'), /^blob:/)
  instance.hidePrivate()
  await assert.rejects(instance.platform.attachments.resolveImage('private-image'), /解锁隐私/)
  assert.equal(instance.state.locked, false)
  await instance.platform.repository.createNote(null)
  await instance.lock()
})

test('insp2 pairing joins an empty automatic vault without a password and never sends the unlock secret to the server', async () => {
  const server = new MemorySyncServer()
  const sourceStore = createStore()
  let secret = ''
  const transport = (input: HttpInput) => {
    assert.equal(JSON.stringify(input).includes(secret), false)
    return server.handle(input)
  }
  const source = workspace(sourceStore, transport)
  await source.initialize()
  await source.openLocal()
  secret = sourceStore.secrets.get(`insp.vault.${source.state.spaceId}`)!
  await source.setPrivacyPassword('918273')
  const note = await source.platform.repository.createNote(null)
  await editNote(source, note.id, 'Paired normal note', 'Pairing body')
  const privateNote = await source.platform.repository.createNote(null)
  await source.setNotePolicy(privateNote.id, 'private', 'localOnly')
  await source.configureSync(ENDPOINT)
  assert.match(source.state.connectionCode, /^insp2\./)
  assert.equal(server.latest(source.state.spaceId, `note:${privateNote.id}`), undefined)
  assert.equal(server.mutations.some(mutation => mutation.entityId === '$meta'), false)

  const targetStore = createStore()
  const target = workspace(targetStore, transport)
  await target.initialize()
  await target.openLocal()
  const previousSpace = target.state.spaceId
  const previousSecret = targetStore.secrets.get(`insp.vault.${previousSpace}`)
  await target.joinWorkspace(source.state.connectionCode)
  assert.equal(target.state.spaceId, source.state.spaceId)
  assert.equal(target.state.privacyConfigured, false)
  assert.equal(target.state.privateVisible, false)
  assert.equal((await target.platform.repository.getNote(note.id)).title, 'Paired normal note')
  assert.equal(targetStore.secrets.get(`insp.vault.${previousSpace}`), previousSecret)
  assert.equal(targetStore.secrets.get(`insp.vault.${source.state.spaceId}`), secret)
  await target.setPrivacyPassword('192837')

  await source.revealPrivate('918273')
  await source.setNotePolicy(privateNote.id, 'private', 'sync')
  source.hidePrivate()
  await source.syncNow()
  await target.syncNow()
  await assert.rejects(target.platform.repository.getNote(privateNote.id), /解锁隐私/)
  await assert.rejects(target.revealPrivate('918273'), /口令错误/)
  await target.revealPrivate('192837')
  assert.equal((await target.platform.repository.getNote(privateNote.id)).privacy, 'private')
  target.hidePrivate()
  await target.syncNow()
  assert.equal(server.latest(source.state.spaceId, `note:${privateNote.id}`)?.operation, 'put')
  await target.lock()

  const restarted = workspace(targetStore, transport)
  await restarted.initialize()
  await restarted.openLocal()
  assert.equal(restarted.state.locked, false)
  assert.equal(restarted.state.privateVisible, false)
  assert.equal((await restarted.platform.repository.getNote(note.id)).title, 'Paired normal note')
  await restarted.lock()
  await source.lock()
})

test('insp1 joins require the original password and preserve the empty vault on authentication failure', async () => {
  const server = new MemorySyncServer()
  const source = workspace(createStore(), server)
  await source.initialize()
  await source.setup(PASSWORD)
  const note = await source.platform.repository.createNote(null)
  await source.configureSync(ENDPOINT)
  assert.match(source.state.connectionCode, /^insp1\./)
  const store = createStore()
  const target = workspace(store, server)
  await target.initialize()
  await target.openLocal()
  const header = store.header
  const rows = [...store.rows]
  const secrets = [...store.secrets]
  await assert.rejects(target.joinWorkspace(source.state.connectionCode), /需要原空间口令/)
  await assert.rejects(target.joinWorkspace(source.state.connectionCode, 'wrong joining password'), /口令错误/)
  assert.equal(store.header, header)
  assert.deepEqual([...store.rows], rows)
  assert.deepEqual([...store.secrets], secrets)
  await target.joinWorkspace(source.state.connectionCode, PASSWORD)
  assert.equal(target.state.privacyConfigured, true)
  assert.equal((await target.platform.repository.getNote(note.id)).id, note.id)
  await target.lock()
  const restarted = workspace(store, server)
  await restarted.initialize()
  await restarted.openLocal()
  assert.equal(restarted.state.migrationRequired, false)
  assert.equal((await restarted.platform.repository.getNote(note.id)).id, note.id)
  await restarted.lock()
  await source.lock()
})

test('joinWorkspace rejects all nonempty local data including tombstones, groups and unattached images', async () => {
  const group: NoteGroup = { id: 'keep-group', name: 'Keep group', parentId: null, createdAt: DELETED_AT, updatedAt: DELETED_AT }
  const attachment: LegacyAttachment = { id: 'keep-image', mimeType: 'image/png', originalName: 'keep.png', byteLength: 11, dataBase64: IMAGE_BASE64 }
  const fixtures: Legacy[] = [
    { ...emptyLegacy(), notes: [legacyNote('keep-note', 'Keep note')] },
    { ...emptyLegacy(), notes: [legacyNote('keep-deleted', 'Keep deleted', { deletedAt: DELETED_AT })] },
    { ...emptyLegacy(), groups: [group] },
    { ...emptyLegacy(), attachments: [attachment] },
  ]
  for (const legacy of fixtures) {
    const store = createStore(legacy)
    const target = workspace(store)
    await target.initialize()
    await assert.rejects(target.joinWorkspace('unused'), /完全空白/)
    assert.deepEqual(store.legacy, legacy)
    await target.openLocal()
    const header = store.header
    const rows = [...store.rows]
    const secrets = [...store.secrets]
    await assert.rejects(target.joinWorkspace('unused'), /完全空白/)
    assert.equal(store.header, header)
    assert.deepEqual([...store.rows], rows)
    assert.deepEqual([...store.secrets], secrets)
    await target.lock()
  }

  const store = createStore()
  const target = workspace(store)
  await target.initialize()
  await target.openLocal()
  const removed = await target.platform.repository.createGroup('Removed group')
  await target.platform.repository.deleteGroup(removed.id)
  assert.equal([...store.rows.keys()].some(id => id !== '$meta'), false)
  await assert.rejects(target.joinWorkspace('unused'), /完全空白/)
  await target.lock()
})
