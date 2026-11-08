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
  return { header: null as string | null, rows: new Map<string, string | null>(), legacy: structuredClone(legacy) }
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

async function persistedMetadata(store: ReturnType<typeof createStore>) {
  const header = JSON.parse(store.header!) as VaultHeader
  const key = await unlockVault(header, PASSWORD)
  return decryptValue<{ receipts: Record<string, unknown>; pending: Record<string, { operation?: string; inFlight?: boolean }>; deleteIntents: Record<string, string> }>(
    key, header.id, '$meta', JSON.parse(store.rows.get('$meta')!) as CipherEnvelope,
  )
}

async function editNote(instance: EncryptedWorkspace, id: string, title: string, body: string) {
  const previous = await instance.platform.repository.getNote(id)
  return instance.platform.repository.saveNote({ id, title, groupId: previous.groupId, content: document(body), plainText: body })
}

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

test('private notes stay hidden; localOnly is not pushed until changed to sync', async () => {
  const server = new MemorySyncServer()
  const legacy = emptyLegacy()
  legacy.notes = [legacyNote('private-note', 'Private title', { privacy: 'private', syncPolicy: 'localOnly', body: 'Private body' })]
  const store = createStore(legacy)
  const source = workspace(store, server)
  await source.initialize()
  await source.setup(PASSWORD)
  await source.configureSync(ENDPOINT)

  assert.deepEqual((await source.platform.repository.loadWorkspace()).notes, [])
  assert.deepEqual((await persistedMetadata(store)).deleteIntents, {})
  await assert.rejects(source.platform.repository.getNote('private-note'), /请先解锁隐私笔记/)
  assert.equal(server.mutations.some(mutation => mutation.entityId === 'note:private-note'), false)

  await source.revealPrivate(PASSWORD)
  await source.setNotePolicy('private-note', 'private', 'sync')
  source.hidePrivate()
  await source.syncNow()
  assert.equal(server.latest(source.state.spaceId, 'note:private-note')?.operation, 'put')

  const second = workspace(createStore(), server)
  await second.initialize()
  await second.setup(PASSWORD, source.state.connectionCode)
  assert.deepEqual((await second.platform.repository.loadWorkspace()).notes, [])
  await assert.rejects(second.platform.repository.getNote('private-note'), /请先解锁隐私笔记/)
  await second.revealPrivate(PASSWORD)
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
