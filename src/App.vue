<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { JSONContent } from '@tiptap/core'
import type { Note, NoteContent, NoteGroup, NoteKind, NoteSummary, NoteWrite, PrivacyMode, SyncPolicy, WorkspaceSnapshot } from './domain/models'
import { mindMapPreview, mindMapText, type MindMapDocument } from './domain/mindmap'
import { platform, registerCloseGuard, vault } from './platform'
import VaultPanel from './components/VaultPanel.vue'
import ThemeSelect from './components/ThemeSelect.vue'
import MindMapCardPreview from './components/MindMapCardPreview.vue'
import { isEmptyRichText } from './domain/note-content'
import inspLogo from './assets/insp-logo.png'
const RichTextEditor = defineAsyncComponent(() => import('./components/RichTextEditor.vue'))
const MindMapEditor = defineAsyncComponent(() => import('./components/MindMapEditor.vue'))
import {
  Archive,
  ArrowLeft,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  FilePlus2,
  FileText,
  Folder,
  FolderPlus,
  Inbox,
  KeyRound,
  LockKeyhole,
  Menu,
  Pencil,
  Search,
  Settings2,
  Shield,
  ShieldCheck,
  Trash2,
  Workflow,
  X,
} from 'lucide-vue-next'

type SaveState = 'saved' | 'unsaved' | 'saving' | 'error'
type GroupDialog = { mode: 'create' } | { mode: 'rename'; groupId: string }
type RichTextEditorHandle = { awaitPendingImports(): Promise<void>; finishEditing(): void }

const snapshot = ref<WorkspaceSnapshot | null>(null)
const activeNote = ref<Note | null>(null)
const isLoading = ref(true)
const isTransitioning = ref(false)
const filterKey = ref('all')
const searchQuery = ref('')
const groupDialog = ref<GroupDialog | null>(null)
const groupName = ref('')
const groupNameInput = ref<HTMLInputElement | null>(null)
const richEditor = ref<RichTextEditorHandle | null>(null)
const saveState = ref<SaveState>('saved')
const actionError = ref('')
const showError = ref(true)
const vaultPanelMode = ref<'privacy' | 'sync' | null>(null)
const vaultInitError = ref('')
const draftPlainText = ref('')
const mobilePane = ref<'list' | 'editor'>('list')
const sidebarOpen = ref(false)
const mobileEditing = ref(false)
const canCreateMindNote = computed(() => activeNote.value?.kind === 'richtext' && isEmptyRichText(activeNote.value.content))
const noteSettingsOpen = ref(false)
const mobileLayout = ref(window.matchMedia('(max-width: 760px)').matches)
const viewportHeight = ref(window.visualViewport?.height ?? window.innerHeight)
let fullViewportHeight = viewportHeight.value
let viewportWidth = window.innerWidth
let keyboardWasOpen = false
function updateViewport() {
  mobileLayout.value = window.matchMedia('(max-width: 760px)').matches
  const height = window.visualViewport?.height ?? window.innerHeight
  if (viewportWidth !== window.innerWidth) {
    fullViewportHeight = height
    viewportWidth = window.innerWidth
    keyboardWasOpen = false
  }
  fullViewportHeight = Math.max(fullViewportHeight, height)
  const keyboardOpen = fullViewportHeight - height > 120
  if (mobileLayout.value && keyboardWasOpen && !keyboardOpen && mobileEditing.value) finishMobileEditing()
  keyboardWasOpen = keyboardOpen
  viewportHeight.value = height
}
function onMindmapFocus(event: FocusEvent) {
  if ((event.target as HTMLElement).matches('textarea')) mobileEditing.value = true
}
function finishMobileEditing() {
  richEditor.value?.finishEditing()
  ;(document.activeElement as HTMLElement | null)?.blur()
  mobileEditing.value = false
  void flushSaves().catch(reportError)
}

let draftVersion = 0
let persistedVersion = 0
let queuedVersion = 0
let failedVersion: number | null = null
let lastSaveError: unknown = null
let saveFailureNoteId: string | null = null
let saveTimer: ReturnType<typeof setTimeout> | undefined
let saveQueue: Promise<void> = Promise.resolve()
let closeGuardUnlisten: (() => void) | undefined
let transitionWork: Promise<boolean> | null = null
let remoteRefreshTimer: ReturnType<typeof setInterval> | undefined
const workspaceAvailable = computed(() => vault.state.ready && vault.state.initialized && !vault.state.locked)

const groups = computed(() => snapshot.value?.groups ?? [])
const allNotes = computed(() => [...(snapshot.value?.notes ?? [])]
  .filter((note) => note.privacy === (filterKey.value === 'private' ? 'private' : 'normal'))
  .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))
const ungroupedCount = computed(() => (snapshot.value?.notes ?? []).filter((note) => note.groupId === null).length)
const filteredNotes = computed(() => {
  const query = searchQuery.value.trim().toLocaleLowerCase('zh-CN')
  return allNotes.value.filter((note) => {
    if (filterKey.value === 'private' && note.privacy !== 'private') return false
    if (filterKey.value === 'ungrouped' && note.groupId !== null) return false
    if (filterKey.value.startsWith('group:') && note.groupId !== filterKey.value.slice(6)) return false
    return !query || `${note.title}\n${note.preview}`.toLocaleLowerCase('zh-CN').includes(query)
  })
})
const currentFilterName = computed(() => {
  if (filterKey.value === 'private') return '隐私笔记'
  if (filterKey.value === 'ungrouped') return '未分组'
  if (filterKey.value.startsWith('group:')) return groups.value.find((group) => group.id === filterKey.value.slice(6))?.name ?? '分组'
  return '全部笔记'
})
const activeGroupName = computed(() => groups.value.find((group) => group.id === activeNote.value?.groupId)?.name ?? '未分组')
const saveLabel = computed(() => {
  if (saveState.value === 'saving') return '正在保存…'
  if (saveState.value === 'unsaved') return '待保存'
  if (saveState.value === 'error') return '保存失败'
  return '已保存到本机'
})

function errorText(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') return error.message
  return String(error)
}

function reportError(error: unknown) {
  actionError.value = errorText(error)
  showError.value = true
}

function documentText(node: JSONContent): string {
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'hardBreak') return '\n'
  const parts = (node.content ?? []).map(documentText)
  if (['doc', 'bulletList', 'orderedList', 'taskList', 'blockquote'].includes(node.type ?? '')) return parts.join('\n')
  return parts.join('')
}

function summaryFromNote(note: Note, plainText = note.preview): NoteSummary {
  const { content: _content, schemaVersion: _schemaVersion, ...summary } = note
  return { ...summary, mindMapPreview: note.kind === 'mindmap' ? mindMapPreview(note.content as MindMapDocument) : undefined, preview: plainText.trim().replace(/\s+/g, ' ').slice(0, 180) }
}

function replaceSummary(summary: NoteSummary) {
  if (!snapshot.value) return
  snapshot.value = {
    ...snapshot.value,
    notes: snapshot.value.notes.map((note) => note.id === summary.id ? summary : note),
  }
}

function captureWrite(note: Note): NoteWrite {
  return {
    id: note.id,
    title: note.title,
    groupId: note.groupId,
    content: JSON.parse(JSON.stringify(note.content)) as NoteContent,
    plainText: draftPlainText.value,
  }
}

function enqueueSave(input: NoteWrite, version: number): Promise<void> {
  queuedVersion = Math.max(queuedVersion, version)
  const operation = saveQueue.then(async () => {
    if (version <= persistedVersion) return
    if (activeNote.value?.id === input.id) saveState.value = 'saving'
    try {
      const saved = await platform.repository.saveNote(input)
      persistedVersion = Math.max(persistedVersion, version)
      lastSaveError = null
      if (failedVersion !== null && failedVersion <= version) failedVersion = null
      const current = activeNote.value
      if (current?.id === input.id) {
        if (draftVersion === version) {
          const normalized: Note = {
            ...current,
            title: saved.title,
            groupId: saved.groupId,
            updatedAt: saved.updatedAt,
            revision: saved.revision,
            preview: saved.preview,
          }
          activeNote.value = normalized
          replaceSummary(summaryFromNote(normalized, draftPlainText.value))
          saveState.value = 'saved'
        } else {
          activeNote.value = { ...current, revision: saved.revision }
          saveState.value = 'unsaved'
        }
      } else {
        replaceSummary(summaryFromNote(saved))
      }
      if (saveFailureNoteId === input.id && (failedVersion === null || failedVersion <= version)) {
        saveFailureNoteId = null
        actionError.value = ''
      }
    } catch (error) {
      lastSaveError = error
      failedVersion = version
      saveFailureNoteId = input.id
      if (activeNote.value?.id === input.id) saveState.value = 'error'
      reportError(error)
      throw error
    }
  })
  saveQueue = operation.catch(() => undefined)
  return operation
}

function markDraftChanged() {
  draftVersion += 1
  saveState.value = 'unsaved'
  if (activeNote.value) {
    const current = { ...activeNote.value, updatedAt: new Date().toISOString() }
    activeNote.value = current
    replaceSummary(summaryFromNote(current, draftPlainText.value))
  }
  if (saveTimer !== undefined) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = undefined
    const current = activeNote.value
    if (current) void enqueueSave(captureWrite(current), draftVersion).catch(() => undefined)
  }, platform.capabilities.platform === 'windows' ? 450 : 150)
}

async function flushSaves() {
  if (saveTimer !== undefined) {
    clearTimeout(saveTimer)
    saveTimer = undefined
  }
  const noteId = activeNote.value?.id
  if (!noteId) {
    await saveQueue
    return
  }
  while (activeNote.value?.id === noteId) {
    const version = draftVersion
    if (version <= persistedVersion) {
      await saveQueue
      if (draftVersion <= persistedVersion) return
      continue
    }
    const current = activeNote.value
    if (queuedVersion < version || failedVersion === version) {
      await enqueueSave(captureWrite(current), version)
    } else {
      await saveQueue
      if (persistedVersion < version) {
        if (failedVersion === version) await enqueueSave(captureWrite(current), version)
        else if (lastSaveError) throw lastSaveError
      }
    }
    if (persistedVersion >= draftVersion) return
  }
}

async function flushBeforeTransition() {
  await nextTick()
  await richEditor.value?.awaitPendingImports()
  await flushSaves()
}

async function runTransition(action: () => Promise<void>): Promise<boolean> {
  if (transitionWork) return false
  const work = (async () => {
    isTransitioning.value = true
    try {
      await flushBeforeTransition()
      await action()
      return true
    } catch (error) {
      reportError(error)
      return false
    } finally {
      isTransitioning.value = false
    }
  })()
  transitionWork = work
  const result = await work
  if (transitionWork === work) transitionWork = null
  return result
}

async function flushBeforeClose() {
  if (transitionWork) await transitionWork
  isTransitioning.value = true
  try {
    await flushBeforeTransition()
  } finally {
    isTransitioning.value = false
  }
}

function resetDraftState(note: Note) {
  activeNote.value = note
  mobileEditing.value = false
  noteSettingsOpen.value = false
  draftPlainText.value = note.kind === 'mindmap' ? mindMapText(note.content as MindMapDocument) : documentText(note.content as JSONContent)
  draftVersion = 0
  persistedVersion = 0
  queuedVersion = 0
  failedVersion = null
  lastSaveError = null
  saveFailureNoteId = null
  saveState.value = 'saved'
}

function clearActiveNote() {
  activeNote.value = null
  draftPlainText.value = ''
  draftVersion = 0
  persistedVersion = 0
  queuedVersion = 0
  failedVersion = null
  lastSaveError = null
  saveFailureNoteId = null
  saveState.value = 'saved'
}

function clearWorkspaceState() {
  if (saveTimer !== undefined) clearTimeout(saveTimer)
  saveTimer = undefined
  snapshot.value = null
  clearActiveNote()
  searchQuery.value = ''
  filterKey.value = 'all'
  mobilePane.value = 'list'
  sidebarOpen.value = false
  groupDialog.value = null
  vaultPanelMode.value = null
  actionError.value = ''
}

async function refreshWorkspace(privateOnly = filterKey.value === 'private') {
  if (!workspaceAvailable.value) return null
  if (privateOnly && !vault.state.privateVisible) {
    clearActiveNote()
    snapshot.value = null
    filterKey.value = 'all'
    searchQuery.value = ''
    vault.hidePrivate()
    privateOnly = false
  }
  const loaded = await platform.repository.loadWorkspace()
  if (!workspaceAvailable.value) {
    clearWorkspaceState()
    return null
  }
  if (privateOnly && !vault.state.privateVisible) {
    clearActiveNote()
    snapshot.value = null
    filterKey.value = 'all'
    searchQuery.value = ''
    vault.hidePrivate()
    return refreshWorkspace(false)
  }
  const notes = loaded.notes.filter((note) => note.privacy === (privateOnly ? 'private' : 'normal'))
  const refreshed = { ...loaded, notes }
  snapshot.value = refreshed
  return refreshed
}

async function loadInitialWorkspace() {
  clearActiveNote()
  filterKey.value = 'all'
  searchQuery.value = ''
  const loaded = await refreshWorkspace(false)
  if (!loaded || !workspaceAvailable.value) return
  const first = [...loaded.notes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  if (!first) return
  const note = await platform.repository.getNote(first.id)
  if (workspaceAvailable.value) resetDraftState(note)
}

async function loadWorkspaceAfterVaultOpen() {
  vaultPanelMode.value = null
  vaultInitError.value = ''
  if (!workspaceAvailable.value) return
  isLoading.value = true
  try {
    await loadInitialWorkspace()
  } catch (error) {
    reportError(error)
  } finally {
    isLoading.value = false
  }
}

async function retryInitialize() {
  vaultInitError.value = ''
  isLoading.value = true
  try {
    await vault.initialize()
    vault.hidePrivate()
    if (workspaceAvailable.value) await loadWorkspaceAfterVaultOpen()
  } catch (error) {
    vaultInitError.value = errorText(error)
  } finally {
    isLoading.value = false
  }
}

async function openPrivateArea() {
  if (filterKey.value === 'private' || isTransitioning.value) return
  sidebarOpen.value = false
  await runTransition(async () => {
    mobilePane.value = 'list'
    vaultPanelMode.value = 'privacy'
  })
}

async function enterPrivateArea() {
  vaultPanelMode.value = null
  filterKey.value = 'private'
  searchQuery.value = ''
  mobilePane.value = 'list'
  clearActiveNote()
  snapshot.value = null
  isLoading.value = true
  try {
    await refreshWorkspace(true)
  } catch (error) {
    reportError(error)
  } finally {
    isLoading.value = false
  }
}

async function leavePrivateArea(nextFilter = 'all') {
  if (filterKey.value !== 'private') return
  await runTransition(async () => {
    clearActiveNote()
    snapshot.value = null
    filterKey.value = nextFilter
    searchQuery.value = ''
    mobilePane.value = 'list'
    sidebarOpen.value = false
    vault.hidePrivate()
    isLoading.value = true
    try {
      await refreshWorkspace(false)
    } finally {
      isLoading.value = false
    }
  })
}

function openSyncSettings() {
  if (isTransitioning.value || !workspaceAvailable.value) return
  sidebarOpen.value = false
  vaultPanelMode.value = 'sync'
}

async function syncWorkspace() {
  if (!workspaceAvailable.value || isTransitioning.value || transitionWork) return
  const activeId = activeNote.value?.id
  isTransitioning.value = true
  try {
    await flushBeforeTransition()
    await vault.syncNow()
    isTransitioning.value = true
    const loaded = await refreshWorkspace(filterKey.value === 'private')
    const summary = loaded?.notes.find((note) => note.id === activeId)
    if (summary && activeId) {
      try {
        const note = await platform.repository.getNote(activeId)
        if (workspaceAvailable.value) resetDraftState(note)
      } catch (error) {
        clearActiveNote()
        await refreshWorkspace(filterKey.value === 'private')
        reportError(error)
      }
    } else if (activeId) {
      clearActiveNote()
    }
  } catch (error) {
    reportError(error)
  } finally {
    isTransitioning.value = false
  }
}

async function handleOnline() {
  if (!workspaceAvailable.value || !vault.state.endpoint || vault.state.syncing || isTransitioning.value) return
  await syncWorkspace()
}

function refreshRemoteWhenVisible() {
  if (document.visibilityState !== 'visible' || !workspaceAvailable.value || !vault.state.endpoint || vault.state.syncing || isTransitioning.value || transitionWork) return
  void vault.syncNow().catch(() => undefined)
}

async function beforeSyncApply() {
  await flushBeforeClose()
  isTransitioning.value = true
}

async function afterSyncApply() {
  try {
    if (!workspaceAvailable.value) {
      clearWorkspaceState()
      return
    }
    let privateOnly = filterKey.value === 'private'
    if (privateOnly && !vault.state.privateVisible) {
      clearActiveNote()
      snapshot.value = null
      filterKey.value = 'all'
      searchQuery.value = ''
      privateOnly = false
    }
    const activeId = activeNote.value?.id
    const loaded = await refreshWorkspace(privateOnly)
    const summary = loaded?.notes.find((note) => note.id === activeId)
    if (!activeId || !summary) {
      clearActiveNote()
      mobilePane.value = 'list'
      return
    }
    try {
      const latest = await platform.repository.getNote(activeId)
      const expectedPrivacy = privateOnly ? 'private' : 'normal'
      if (!workspaceAvailable.value || latest.privacy !== expectedPrivacy) {
        clearActiveNote()
        mobilePane.value = 'list'
        return
      }
      resetDraftState(latest)
    } catch (error) {
      clearActiveNote()
      mobilePane.value = 'list'
      await refreshWorkspace(privateOnly)
      reportError(error)
    }
  } catch (error) {
    clearActiveNote()
    reportError(error)
  } finally {
    isTransitioning.value = false
  }
}

async function lockWorkspace() {
  if (!workspaceAvailable.value || isTransitioning.value || vault.state.syncing) return
  await runTransition(async () => {
    clearWorkspaceState()
    vault.hidePrivate()
    try {
      await vault.lock()
    } catch (error) {
      if (workspaceAvailable.value) await loadWorkspaceAfterVaultOpen()
      throw error
    }
  })
}

watch(() => vault.state.locked, (locked) => {
  if (locked) clearWorkspaceState()
}, { immediate: true })

watch(workspaceAvailable, (available, wasAvailable) => {
  if (available && !wasAvailable) void loadWorkspaceAfterVaultOpen()
})

async function openNote(noteId: string) {
  if (!workspaceAvailable.value) return
  if (activeNote.value?.id === noteId) {
    mobilePane.value = 'editor'
    return
  }
  await runTransition(async () => {
    const summary = snapshot.value?.notes.find((item) => item.id === noteId)
    if (!summary || summary.privacy !== (filterKey.value === 'private' ? 'private' : 'normal')) return
    const note = await platform.repository.getNote(noteId)
    if (!workspaceAvailable.value || note.privacy !== summary.privacy) return
    resetDraftState(note)
    mobilePane.value = 'editor'
  })
}

async function createNote(kind: NoteKind = 'richtext') {
  if (!workspaceAvailable.value) return
  await runTransition(async () => {
    const groupId = filterKey.value.startsWith('group:') ? filterKey.value.slice(6) : null
    let note = await platform.repository.createNote(filterKey.value === 'private' ? null : groupId, kind)
    if (filterKey.value === 'private') note = await vault.setNotePolicy(note.id, 'private', 'localOnly')
    if (snapshot.value) snapshot.value = { ...snapshot.value, notes: [summaryFromNote(note), ...snapshot.value.notes] }
    resetDraftState(note)
    mobilePane.value = 'editor'
  })
}

async function deleteActiveNote() {
  const note = activeNote.value
  if (!note) return
  await runTransition(async () => {
    await platform.repository.deleteNote(note.id)
    if (snapshot.value) snapshot.value = { ...snapshot.value, notes: snapshot.value.notes.filter((item) => item.id !== note.id) }
    activeNote.value = null
    mobilePane.value = 'list'
    draftPlainText.value = ''
    draftVersion = 0
    persistedVersion = 0
    queuedVersion = 0
    failedVersion = null
    saveState.value = 'saved'
  })
}

async function createMindNoteFromBlank() {
  const id = activeNote.value?.id
  if (!id || !canCreateMindNote.value) return
  await runTransition(async () => {
    const note = await platform.repository.convertToMindMap(id)
    replaceSummary(summaryFromNote(note))
    resetDraftState(note)
  })
}

function updateDocument(content: NoteContent, plainText: string) {
  if (!activeNote.value) return
  activeNote.value = { ...activeNote.value, content }
  draftPlainText.value = plainText
  markDraftChanged()
}

function updateTitle(event: Event) {
  if (!activeNote.value) return
  activeNote.value = { ...activeNote.value, title: (event.target as HTMLInputElement).value }
  markDraftChanged()
}

async function changeNoteGroup(event: Event) {
  const select = event.target as HTMLSelectElement
  const groupId = select.value || null
  const success = await runTransition(async () => {
    if (!activeNote.value) return
    activeNote.value = { ...activeNote.value, groupId }
    replaceSummary(summaryFromNote(activeNote.value, draftPlainText.value))
    markDraftChanged()
  })
  if (!success && activeNote.value) select.value = activeNote.value.groupId ?? ''
}

async function changeNotePolicy(privacy: PrivacyMode, syncPolicy: SyncPolicy, select?: HTMLSelectElement) {
  const original = activeNote.value
  if (!original) return
  const success = await runTransition(async () => {
    await flushSaves()
    const updated = await vault.setNotePolicy(original.id, privacy, syncPolicy)
    const visiblePrivacy = filterKey.value === 'private' ? 'private' : 'normal'
    const remainsVisible = updated.privacy === visiblePrivacy
    snapshot.value = null
    if (remainsVisible) resetDraftState(updated)
    else {
      clearActiveNote()
      mobilePane.value = 'list'
    }
    const loaded = await refreshWorkspace(filterKey.value === 'private')
    const summary = loaded?.notes.find((item) => item.id === original.id)
    if (!remainsVisible || !summary || summary.privacy !== privacy) {
      clearActiveNote()
      mobilePane.value = 'list'
      return
    }
    resetDraftState(updated)
  })
  if (!success && select && activeNote.value) {
    select.value = select.dataset.policy === 'privacy' ? activeNote.value.privacy : activeNote.value.syncPolicy
  }
}

function changePrivacy(event: Event) {
  const select = event.target as HTMLSelectElement
  const note = activeNote.value
  if (!note) return
  const privacy = select.value as PrivacyMode
  const syncPolicy = privacy === 'private' && note.privacy === 'normal' ? 'localOnly' : note.syncPolicy
  void changeNotePolicy(privacy, syncPolicy, select)
}

function changeSyncPolicy(event: Event) {
  const select = event.target as HTMLSelectElement
  const note = activeNote.value
  if (note) void changeNotePolicy(note.privacy, select.value as SyncPolicy, select)
}

function chooseFilter(key: string) {
  if (filterKey.value === 'private' && key !== 'private') {
    void leavePrivateArea(key)
    return
  }
  filterKey.value = key
  sidebarOpen.value = false
  mobilePane.value = 'list'
}

async function showNoteList() {
  await runTransition(async () => { mobilePane.value = 'list' })
}

function navigateBack(event: Event) {
  if (vaultPanelMode.value) {
    event.preventDefault()
    vaultPanelMode.value = null
  } else if (groupDialog.value) {
    event.preventDefault()
    groupDialog.value = null
  } else if (sidebarOpen.value) {
    event.preventDefault()
    sidebarOpen.value = false
  } else if (mobileLayout.value && mobileEditing.value) {
    event.preventDefault()
    finishMobileEditing()
  } else if (mobilePane.value === 'editor') {
    event.preventDefault()
    void showNoteList()
  }
}

async function showGroupDialog(dialog: GroupDialog) {
  groupDialog.value = dialog
  groupName.value = dialog.mode === 'rename'
    ? groups.value.find((group) => group.id === dialog.groupId)?.name ?? ''
    : ''
  await nextTick()
  groupNameInput.value?.focus()
  groupNameInput.value?.select()
}

async function saveGroupDialog() {
  const name = groupName.value.trim()
  if (!name || !groupDialog.value) return
  const dialog = groupDialog.value
  await runTransition(async () => {
    if (dialog.mode === 'create') {
      const group = await platform.repository.createGroup(name)
      if (snapshot.value) snapshot.value = { ...snapshot.value, groups: [group, ...snapshot.value.groups] }
    } else {
      const group = await platform.repository.renameGroup(dialog.groupId, name)
      if (snapshot.value) {
        snapshot.value = {
          ...snapshot.value,
          groups: snapshot.value.groups.map((item) => item.id === group.id ? group : item),
        }
      }
    }
    groupDialog.value = null
  })
}

async function deleteGroup(group: NoteGroup) {
  await runTransition(async () => {
    await platform.repository.deleteGroup(group.id)
    if (filterKey.value === `group:${group.id}`) filterKey.value = 'all'
    if (snapshot.value) {
      snapshot.value = {
        ...snapshot.value,
        groups: snapshot.value.groups.filter((item) => item.id !== group.id),
        notes: snapshot.value.notes.map((note) => note.groupId === group.id ? { ...note, groupId: null } : note),
      }
    }
    if (activeNote.value?.groupId === group.id) activeNote.value = { ...activeNote.value, groupId: null }
    const refreshed = await refreshWorkspace(filterKey.value === 'private')
    if (refreshed && activeNote.value) {
      const summary = refreshed.notes.find((note) => note.id === activeNote.value?.id)
      if (summary) activeNote.value = { ...activeNote.value, ...summary, content: activeNote.value.content }
      else clearActiveNote()
    }
  })
}

function countInGroup(groupId: string) {
  return (snapshot.value?.notes ?? []).filter((note) => note.groupId === groupId).length
}

function formatDate(value: string) {
  const date = new Date(value)
  const now = new Date()
  if (date.toDateString() === now.toDateString()) {
    return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(date)
  }
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(date)
}

onMounted(async () => {
  window.addEventListener('resize', updateViewport)
  window.visualViewport?.addEventListener('resize', updateViewport)
  window.addEventListener('insp:back', navigateBack)
  window.addEventListener('online', handleOnline)
  document.addEventListener('visibilitychange', refreshRemoteWhenVisible)
  remoteRefreshTimer = setInterval(refreshRemoteWhenVisible, 30_000)
  vault.setSyncHooks(beforeSyncApply, afterSyncApply)
  try {
    await vault.initialize()
    vault.hidePrivate()
  } catch (error) {
    vaultInitError.value = errorText(error)
  }
  try {
    closeGuardUnlisten = await registerCloseGuard(flushBeforeClose, reportError)
  } catch (error) {
    reportError(error)
  }
  if (workspaceAvailable.value) {
    try {
      await loadInitialWorkspace()
    } catch (error) {
      reportError(error)
    }
  }
  isLoading.value = false
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', updateViewport)
  window.visualViewport?.removeEventListener('resize', updateViewport)
  window.removeEventListener('insp:back', navigateBack)
  window.removeEventListener('online', handleOnline)
  document.removeEventListener('visibilitychange', refreshRemoteWhenVisible)
  if (remoteRefreshTimer) clearInterval(remoteRefreshTimer)
  vault.setSyncHooks(async () => {}, async () => {})
  if (saveTimer !== undefined) clearTimeout(saveTimer)
  closeGuardUnlisten?.()
})
</script>

<template>
  <VaultPanel
    v-if="!workspaceAvailable"
    :vault="vault"
    mode="gate"
    :error="vaultInitError"
    @retry="retryInitialize"
  />
  <div v-else class="notes-app" :style="mobileLayout ? { height: viewportHeight + 'px' } : undefined" :class="{ 'mobile-editor-open': mobilePane === 'editor', 'sidebar-open': sidebarOpen, 'mobile-writing': mobileEditing, 'note-settings-open': noteSettingsOpen }">
    <header class="mobile-header">
      <button class="icon-button" type="button" aria-label="打开分组导航" @click="sidebarOpen = !sidebarOpen"><Menu :size="21" /></button>
      <strong>{{ currentFilterName }}</strong>
      <div class="mobile-security-actions">
        <button class="vault-mobile-button" type="button" aria-label="同步设置" title="同步设置" :disabled="isTransitioning || isLoading" @click="openSyncSettings"><Settings2 :size="19" /></button>
        <button class="vault-mobile-button" type="button" aria-label="锁定空间" title="锁定空间" :disabled="isTransitioning || isLoading || vault.state.syncing" @click="lockWorkspace"><LockKeyhole :size="19" /></button>
      </div>
    </header>
    <button v-if="sidebarOpen" class="sidebar-scrim" type="button" aria-label="关闭分组导航" @click="sidebarOpen = false"></button>
    <aside class="sidebar" aria-label="笔记导航">
      <div class="brand-lockup">
        <div class="brand-mark"><img :src="inspLogo" alt="" /></div>
        <div class="brand-copy"><strong>拾页</strong><span>把想法，收进一页</span></div>
      </div>

      <div class="sidebar-section-label">笔记空间</div>
      <nav class="primary-nav" aria-label="笔记筛选">
        <button class="nav-item" :class="{ selected: filterKey === 'all' }" :disabled="isTransitioning" @click="chooseFilter('all')">
          <Inbox :size="17" /><span>全部笔记</span><span class="nav-count">{{ allNotes.length }}</span>
        </button>
        <button class="nav-item" :class="{ selected: filterKey === 'ungrouped' }" :disabled="isTransitioning" @click="chooseFilter('ungrouped')">
          <Archive :size="17" /><span>未分组</span><span class="nav-count">{{ ungroupedCount }}</span>
        </button>
        <button class="nav-item" :class="{ selected: filterKey === 'private' }" :disabled="isTransitioning" @click="openPrivateArea">
          <Shield :size="17" /><span>隐私笔记</span><span class="nav-count"><KeyRound :size="12" /></span>
        </button>
      </nav>

      <div class="sidebar-group-heading">
        <span class="sidebar-section-label">分组</span>
        <button class="icon-button sidebar-add" type="button" aria-label="新建分组" title="新建分组" :disabled="isTransitioning" @click="showGroupDialog({ mode: 'create' })"><FolderPlus :size="16" /></button>
      </div>
      <nav class="group-nav" aria-label="笔记分组">
        <div v-for="group in groups" :key="group.id" class="group-row" :class="{ selected: filterKey === `group:${group.id}` }">
          <button class="group-select" :disabled="isTransitioning" @click="chooseFilter(`group:${group.id}`)">
            <Folder :size="16" /><span class="group-name">{{ group.name }}</span><span class="nav-count">{{ countInGroup(group.id) }}</span>
          </button>
          <div class="group-actions">
            <button class="group-action" type="button" :aria-label="`重命名分组 ${group.name}`" title="重命名分组" :disabled="isTransitioning" @click="showGroupDialog({ mode: 'rename', groupId: group.id })"><Pencil :size="13" /></button>
            <button class="group-action danger" type="button" :aria-label="`删除分组 ${group.name}，笔记移至未分组`" title="删除分组，笔记移至未分组" :disabled="isTransitioning" @click="deleteGroup(group)"><Trash2 :size="13" /></button>
          </div>
        </div>
        <div v-if="groups.length === 0" class="groups-empty">分组让笔记更好找</div>
      </nav>

      <ThemeSelect class="sidebar-theme" />
      <div class="sidebar-bottom">
        <div class="local-status-icon"><ShieldCheck :size="16" /></div>
        <div class="local-status-copy"><strong>本地加密</strong><span>口令保护 · 离线可用</span></div>
        <span class="local-dot" aria-label="本地工作区"></span>
        <div class="vault-sidebar-actions">
          <button class="vault-sidebar-action" type="button" aria-label="同步设置" title="同步设置" :disabled="isTransitioning" @click="openSyncSettings"><Settings2 :size="16" /></button>
          <button class="vault-sidebar-action" type="button" aria-label="锁定空间" title="锁定空间" :disabled="isTransitioning || isLoading || vault.state.syncing" @click="lockWorkspace"><LockKeyhole :size="16" /></button>
        </div>
      </div>
    </aside>

    <section class="note-list-pane" aria-label="笔记列表">
      <header class="list-pane-header">
        <div>
          <div class="eyebrow">拾页 / NOTES</div>
          <h1>{{ currentFilterName }}</h1>
        </div>
        <div class="create-actions">
          <button class="create-note-button" type="button" aria-label="新建笔记" title="新建笔记" :disabled="isLoading || isTransitioning" @click="createNote('richtext')"><FilePlus2 :size="17" /><span>笔记</span></button>
          <button class="create-note-button create-map-button" type="button" aria-label="新建思维导图" title="新建思维导图" :disabled="isLoading || isTransitioning" @click="createNote('mindmap')"><Workflow :size="17" /><span>导图</span></button>
        </div>
      </header>

      <label class="search-box">
        <Search :size="17" aria-hidden="true" />
        <input v-model="searchQuery" type="search" placeholder="搜索标题和正文摘要" aria-label="搜索笔记标题和正文摘要" />
      </label>

      <nav class="mobile-group-filters" aria-label="笔记分组">
        <button :class="{ active: filterKey === 'all' }" @click="chooseFilter('all')">全部</button>
        <button :class="{ active: filterKey === 'ungrouped' }" @click="chooseFilter('ungrouped')">未分组</button>
        <button v-for="group in groups" :key="group.id" :class="{ active: filterKey === 'group:' + group.id }" @click="chooseFilter('group:' + group.id)">{{ group.name }}</button>
      </nav>
      <div class="list-meta"><span>{{ searchQuery ? `找到 ${filteredNotes.length} 篇` : `${filteredNotes.length} 篇笔记` }}</span><span class="sort-label"><Clock3 :size="13" />最近编辑</span></div>

      <div v-if="isLoading" class="list-loading" role="status"><span class="loading-orbit"></span><span>正在打开本地笔记…</span></div>
      <div v-else-if="filteredNotes.length" class="note-list">
        <button v-for="note in filteredNotes" :key="note.id" class="note-card" :class="{ selected: activeNote?.id === note.id }" :disabled="isTransitioning" @click="openNote(note.id)">
          <span class="note-card-icon"><Workflow v-if="note.kind === 'mindmap'" :size="17" /><FileText v-else :size="17" /></span>
          <span class="note-card-content">
            <span class="note-card-topline"><strong>{{ note.title || '未命名笔记' }}</strong><time>{{ formatDate(note.updatedAt) }}</time></span>
            <MindMapCardPreview v-if="note.kind === 'mindmap' && note.mindMapPreview" :preview="note.mindMapPreview" />
            <span v-else class="note-preview">{{ note.preview || '还没有正文，点开继续记录。' }}</span>
            <span class="note-card-foot"><span v-if="note.groupId" class="note-group-tag"><Folder :size="11" />{{ groups.find((item) => item.id === note.groupId)?.name ?? '分组' }}</span><span v-else class="note-group-tag muted">未分组</span></span>
          </span>
          <ChevronRight class="note-card-chevron" :size="15" />
        </button>
      </div>
      <div v-else class="list-empty">
        <div class="empty-illustration"><FileText :size="25" /></div>
        <template v-if="searchQuery">
          <strong>没有找到匹配的笔记</strong>
          <span>试试其他关键词，或清空搜索。</span>
          <button class="text-action" type="button" @click="searchQuery = ''">清空搜索</button>
        </template>
        <template v-else>
          <strong>{{ filterKey === 'all' ? '这里还空着' : `「${currentFilterName}」还没有笔记` }}</strong>
          <span>先记下一个想法，之后再慢慢整理。</span>
          <button class="empty-create-button" type="button" :disabled="isTransitioning" @click="createNote('richtext')"><FilePlus2 :size="16" />新建笔记</button>
        </template>
      </div>

      <footer class="list-footer"><span class="tiny-leaf"></span><span>今天也给自己留一页空白</span></footer>
    </section>

    <main class="editor-pane">
      <div v-if="actionError && showError" class="error-banner" role="alert">
        <CircleAlert :size="17" />
        <span>{{ actionError }}</span>
        <button type="button" aria-label="关闭错误提示" @click="showError = false"><X :size="16" /></button>
      </div>
      <template v-if="activeNote">
        <header class="editor-topbar">
          <button class="icon-button mobile-back" type="button" :aria-label="mobileEditing ? '结束编辑' : '返回笔记列表'" :disabled="isTransitioning" @click="mobileEditing ? finishMobileEditing() : showNoteList()"><ArrowLeft :size="20" /></button>
          <div class="breadcrumb"><span>拾页</span><ChevronRight :size="14" /><span>{{ activeGroupName }}</span><ChevronRight :size="14" /><span class="breadcrumb-current">笔记</span></div>
          <button v-if="mobileEditing" class="mobile-done" @click="finishMobileEditing">完成</button>
          <button class="mobile-note-settings icon-button" type="button" aria-label="笔记设置" :aria-expanded="noteSettingsOpen" @click="noteSettingsOpen = !noteSettingsOpen"><Settings2 :size="20" /></button>
          <div class="editor-top-actions">
            <label class="group-picker-label" for="note-group-picker">移动到</label>
            <select id="note-group-picker" class="group-picker" :value="activeNote.groupId ?? ''" :disabled="isTransitioning" aria-label="选择笔记分组" @change="changeNoteGroup">
              <option value="">未分组</option>
              <option v-for="group in groups" :key="group.id" :value="group.id">{{ group.name }}</option>
            </select>
            <button class="icon-button delete-note-button" type="button" aria-label="删除当前笔记" title="删除当前笔记" :disabled="isTransitioning" @click="deleteActiveNote"><Trash2 :size="17" /></button>
          </div>
        </header>

        <div class="document-heading">
          <div class="document-kicker"><span class="document-kind-dot"></span>{{ activeNote.kind === 'mindmap' ? '思维导图' : '随手记' }} <span class="kicker-separator">·</span> {{ formatDate(activeNote.updatedAt) }}</div>
          <input class="document-title" :value="activeNote.title" placeholder="未命名笔记" aria-label="笔记标题" :disabled="isTransitioning" @focus="mobileEditing = true" @input="updateTitle" />
          <div class="note-policy-controls">
            <label class="note-policy-control">
              <span>隐私</span>
              <select :value="activeNote.privacy" data-policy="privacy" :disabled="isTransitioning" aria-label="笔记隐私设置" @change="changePrivacy">
                <option value="normal">普通笔记</option>
                <option value="private">隐私笔记</option>
              </select>
            </label>
            <label class="note-policy-control">
              <span>同步</span>
              <select :value="activeNote.syncPolicy" data-policy="sync" :disabled="isTransitioning" aria-label="笔记同步设置" @change="changeSyncPolicy">
                <option value="localOnly">仅本机</option>
                <option value="sync">同步此笔记</option>
              </select>
            </label>
          </div>
          <p v-if="activeNote.privacy === 'private' && activeNote.syncPolicy === 'sync'" class="private-sync-note">此隐私笔记已明确启用同步。</p>
        </div>

        <button v-if="canCreateMindNote" type="button" class="blank-mind-note" :disabled="isTransitioning" @pointerdown.prevent @click="createMindNoteFromBlank"><Workflow :size="17" />创建思维笔记<span>用层级整理想法</span></button>
        <RichTextEditor
          v-if="activeNote.kind === 'richtext'"
          :key="activeNote.id"
          ref="richEditor"
          :reading="mobileLayout && !mobileEditing"
          @edit="mobileEditing = true"
          :content="activeNote.content as JSONContent"
          :editable="!isTransitioning"
          @update:document="updateDocument"
          @io-error="reportError"
        />
        <MindMapEditor
          v-else
          @focusin="onMindmapFocus"
          :key="activeNote.id"
          :content="activeNote.content as MindMapDocument"
          :editable="!isTransitioning"
          @update:document="updateDocument"
        />

        <footer class="editor-footer">
          <div class="save-status" :class="`save-${saveState}`" role="status">
            <span v-if="saveState === 'saved'" class="save-indicator"><Check :size="12" /></span>
            <span v-else-if="saveState === 'saving'" class="save-spinner"></span>
            <span v-else-if="saveState === 'error'" class="save-error-dot"><CircleAlert :size="13" /></span>
            <span v-else class="save-pending-dot"></span>
            {{ saveLabel }}
          </div>
          <div class="footer-note"><span>字数 {{ draftPlainText.length }}</span><span class="footer-divider"></span><span>拾页 · Insp</span></div>
        </footer>
      </template>

      <div v-else-if="isLoading" class="editor-empty loading-editor" role="status">
        <span class="loading-orbit large"></span><span>正在准备你的笔记空间…</span>
      </div>
      <div v-else class="editor-empty welcome-empty">
        <div class="welcome-art" aria-hidden="true"><div class="welcome-paper"><span></span><span></span><span></span><i></i></div><div class="welcome-spark spark-one">✳</div><div class="welcome-spark spark-two">✦</div></div>
        <div class="welcome-eyebrow">A LITTLE SPACE FOR YOUR THOUGHTS</div>
        <h2>给想法，留一页空白。</h2>
        <p>写下此刻想到的事。你的笔记会自动保存在这台设备上。</p>
        <button class="welcome-create-button" type="button" :disabled="isTransitioning" @click="createNote('richtext')"><FilePlus2 :size="17" />创建第一篇笔记</button>
        <div class="welcome-local"><ShieldCheck :size="15" />本地加密 · 口令保护</div>
      </div>
    </main>

    <VaultPanel
      v-if="vaultPanelMode"
      :vault="vault"
      :mode="vaultPanelMode"
      @close="vaultPanelMode = null"
      @revealed="enterPrivateArea"
      @sync="syncWorkspace"
    />

    <div v-if="groupDialog" class="modal-backdrop" @click.self="groupDialog = null">
      <form class="group-dialog" role="dialog" aria-modal="true" :aria-labelledby="'group-dialog-title'" @submit.prevent="saveGroupDialog">
        <div class="dialog-icon"><FolderPlus v-if="groupDialog.mode === 'create'" :size="20" /><Pencil v-else :size="19" /></div>
        <button class="dialog-close" type="button" aria-label="关闭" @click="groupDialog = null"><X :size="17" /></button>
        <h2 id="group-dialog-title">{{ groupDialog.mode === 'create' ? '新建分组' : '重命名分组' }}</h2>
        <p>给这组笔记一个容易记住的名字。</p>
        <input ref="groupNameInput" v-model="groupName" class="group-name-input" type="text" maxlength="80" required :placeholder="'例如：灵感、工作、读书'" aria-label="分组名称" />
        <div class="dialog-actions">
          <button class="dialog-cancel" type="button" :disabled="isTransitioning" @click="groupDialog = null">取消</button>
          <button class="dialog-submit" type="submit" :disabled="isTransitioning || !groupName.trim()">{{ isTransitioning ? '正在保存…' : '保存分组' }}</button>
        </div>
      </form>
    </div>
  </div>
</template>
