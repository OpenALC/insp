<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { JSONContent } from '@tiptap/core'
import type { Note, NoteContent, NoteGroup, NoteKind, NoteSummary, NoteWrite, PrivacyMode, SyncPolicy, WorkspaceSnapshot } from './domain/models'
import { mindMapPreview, mindMapText, UNTITLED_MIND_MAP, type MindMapDocument } from './domain/mindmap'
import { platform, registerCloseGuard, vault, getDeviceInsets, setDeviceAppearance, shareNoteText, shareNoteImage, saveNoteExport } from './platform'
import { exportNote } from './export'
import type { ExportFile } from './export'
import VaultPanel from './components/VaultPanel.vue'
import SettingsPage from './components/SettingsPage.vue'
import MindMapCardPreview from './components/MindMapCardPreview.vue'
import { isEmptyRichText } from './domain/note-content'
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
  Plus,
  LayoutGrid,
  List,
  ListTree,
  Network,
  MoreHorizontal,
  Undo2,
  Redo2,
  Pencil,
  Search,
  Share2,
  Image as ImageIcon,
  Copy,
  FileDown,
  Settings2,
  Shield,
  ShieldCheck,
  Trash2,
  Workflow,
  X,
} from 'lucide-vue-next'

type SaveState = 'saved' | 'unsaved' | 'saving' | 'error'
type GroupDialog = { mode: 'create' } | { mode: 'rename'; groupId: string }
type RichTextEditorHandle = { awaitPendingImports(): Promise<void>; finishEditing(): void; focusEditor(): void; undo(): void; redo(): void; canUndo: boolean; canRedo: boolean }

function mindNoteTitle(title: string) {
  return !title || title === '未命名的思维笔记' ? UNTITLED_MIND_MAP : title
}
function withMindNoteTitle(note: Note): Note {
  if (note.kind !== 'mindmap') return note
  const map = note.content as MindMapDocument
  const title = mindNoteTitle(map.root.text)
  return { ...note, title, content: { ...map, root: { ...map.root, text: title } } }
}

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
const mindEditor = ref<InstanceType<typeof MindMapEditor>>()
const nextMindView = computed(() => mindEditor.value?.viewMode === 'tree' ? 'outline' : 'tree')
const saveState = ref<SaveState>('saved')
const actionError = ref('')
const showError = ref(true)
const vaultPanelMode = ref<'privacy' | null>(null)
const vaultInitError = ref('')
const draftPlainText = ref('')
const mobilePane = ref<'list' | 'editor'>('list')
const sidebarOpen = ref(false)
const mobileEditing = ref(false)
const canCreateMindNote = computed(() => activeNote.value?.kind === 'richtext' && isEmptyRichText(activeNote.value.content))
const noteSettingsOpen = ref(false)
const optionsPanel = ref<HTMLElement>()
const optionsRestingHeight = ref(0)
const settingsOpen = ref(false)
const settingsPrivacy = ref(false)
const listLayout = ref(localStorage.getItem('insp.noteLayout') === 'list' ? 'list' : 'grid')
const listScrolled = ref(false)
const listScrolling = ref(false)
const selectionMode = ref(false)
const selectedNoteIds = ref(new Set<string>())
const batchGroupOpen = ref(false)
const noteChoice = ref<'group' | 'privacy' | 'sync' | 'export' | null>(null)
const exportBusy = ref(false)
const exportStatus = ref('')
const listMenuOpen = ref(false)
const newNoteFocus = ref(false)
const privacyCovered = ref(false)
const keyboardVisible = ref(false)
let scrollStopTimer: ReturnType<typeof setTimeout> | undefined
let longPressTimer: ReturnType<typeof setTimeout> | undefined
let longPressOrigin: { x: number; y: number } | undefined
let suppressNoteClick: string | null = null
function onListScroll(event: Event) {
  listScrolled.value = (event.target as HTMLElement).scrollTop > 70
  listScrolling.value = true
  clearTimeout(scrollStopTimer)
  scrollStopTimer = setTimeout(() => { listScrolling.value = false }, 180)
}
function clearSelection() {
  selectionMode.value = false
  selectedNoteIds.value = new Set()
  batchGroupOpen.value = false
}
watch(searchQuery, () => { if (selectionMode.value) clearSelection() })
function toggleNoteSelection(id: string) {
  const next = new Set(selectedNoteIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selectedNoteIds.value = next
}
function startNoteSelection(id: string) {
  selectionMode.value = true
  if (!selectedNoteIds.value.has(id)) toggleNoteSelection(id)
  suppressNoteClick = id
}
function notePointerDown(event: PointerEvent, id: string) {
  if (!mobileLayout.value || selectionMode.value || event.button !== 0) return
  longPressOrigin = { x: event.clientX, y: event.clientY }
  clearTimeout(longPressTimer)
  longPressTimer = setTimeout(() => startNoteSelection(id), 450)
}
function notePointerMove(event: PointerEvent) {
  if (longPressOrigin && Math.hypot(event.clientX - longPressOrigin.x, event.clientY - longPressOrigin.y) > 9) clearTimeout(longPressTimer)
}
function notePointerEnd() {
  clearTimeout(longPressTimer)
  longPressOrigin = undefined
  const id = suppressNoteClick
  if (id) setTimeout(() => { if (suppressNoteClick === id) suppressNoteClick = null }, 200)
}
function noteCardClick(id: string) {
  if (suppressNoteClick === id) { suppressNoteClick = null; return }
  if (selectionMode.value) toggleNoteSelection(id)
  else void openNote(id)
}
function noteContextMenu(event: MouseEvent, id: string) {
  if (!mobileLayout.value) return
  event.preventDefault()
  startNoteSelection(id)
}
function onButtonPointerDown(event: PointerEvent) {
  if (!mobileLayout.value || event.button !== 0) return
  const button = (event.target as HTMLElement).closest('button')
  if (!button || button.disabled || button.classList.contains('note-card') || button.classList.contains('sidebar-scrim')) return
  const rect = button.getBoundingClientRect()
  if (getComputedStyle(button).position === 'static') button.style.position = 'relative'
  button.style.overflow = 'hidden'
  const size = Math.max(rect.width, rect.height) * 1.6
  const ripple = document.createElement('span')
  ripple.className = 'tap-ripple'
  ripple.style.width = `${size}px`
  ripple.style.height = `${size}px`
  ripple.style.left = `${rect.width / 2 - size / 2}px`
  ripple.style.top = `${rect.height / 2 - size / 2}px`
  ripple.addEventListener('animationend', () => ripple.remove(), { once: true })
  button.append(ripple)
}
function setListLayout(value: string) {
  listLayout.value = value === 'list' ? 'list' : 'grid'
  localStorage.setItem('insp.noteLayout', listLayout.value)
}
function applyInsets(event: Event) {
  const insets = (event as CustomEvent).detail as { top: number; bottom: number; left: number; right: number }
  for (const side of ['top', 'bottom', 'left', 'right'] as const) document.documentElement.style.setProperty('--native-inset-' + side, insets[side] + 'px')
}
function updateNativeTheme() {
  void setDeviceAppearance(document.documentElement.dataset.theme === 'dark').catch(reportError)
}
async function loadInsets() {
  const insets = await getDeviceInsets()
  applyInsets(new CustomEvent('insp:insets', { detail: insets }))
}
async function openSettings() {
  await runTransition(async () => { sidebarOpen.value = false; settingsOpen.value = true })
}
function authenticateSettings() {
  settingsPrivacy.value = true
  vaultPanelMode.value = 'privacy'
}
function closePrivacyPanel() {
  vaultPanelMode.value = null
  settingsPrivacy.value = false
  privacyCovered.value = filterKey.value === 'private'
  vault.hidePrivate()
}
async function handleRevealed() {
  if (settingsPrivacy.value || privacyCovered.value) { vaultPanelMode.value = null; settingsPrivacy.value = false; privacyCovered.value = false; return }
  await enterPrivateArea()
}
async function handleVisibility() {
  if (document.visibilityState === 'hidden' && vault.state.privateVisible) {
    privacyCovered.value = true
    if (filterKey.value === 'private') await leavePrivateArea()
    vault.hidePrivate()
  }
  if (document.visibilityState === 'visible') {
    privacyCovered.value = filterKey.value === 'private' && !vault.state.privateVisible
    refreshRemoteWhenVisible()
  }
}

const mobileLayout = ref(window.matchMedia('(max-width: 760px)').matches)
const viewportHeight = ref(window.innerHeight)
let fullViewportHeight = viewportHeight.value
let viewportWidth = window.innerWidth
function updateViewport() {
  mobileLayout.value = window.matchMedia('(max-width: 760px)').matches
  const height = window.innerHeight
  if (viewportWidth !== window.innerWidth) {
    optionsRestingHeight.value = 0
    fullViewportHeight = height
    viewportWidth = window.innerWidth
  }
  fullViewportHeight = Math.max(fullViewportHeight, height)
  const keyboardOpen = fullViewportHeight - height > 120
  keyboardVisible.value = keyboardOpen
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

async function openNoteOptions() {
  optionsRestingHeight.value = mobileLayout.value && keyboardVisible.value ? fullViewportHeight : 0
  noteChoice.value = null
  exportStatus.value = ''
  noteSettingsOpen.value = true
  await nextTick()
  optionsPanel.value?.focus({ preventScroll: true })
}

async function exportCurrentNote(format: 'png' | 'plaintext' | 'markdown' | 'docx' | 'pdf') {
  if (exportBusy.value) return
  exportBusy.value = true
  exportStatus.value = ''
  try {
    await richEditor.value?.awaitPendingImports()
    await nextTick()
    const note = activeNote.value
    if (!note) return
    if (note.privacy === 'private' && !vault.state.privateVisible) throw new Error('请先解锁隐私笔记。')
    const resolveAttachment = (id: string) => platform.attachments.resolveImage(id)
    if (format === 'plaintext') {
      const content = await exportNote(note, 'plaintext', resolveAttachment)
      const result = await shareNoteText(content, note.title)
      exportStatus.value = result === 'shared' ? '已复制正文并打开系统分享' : '已复制正文'
    } else {
      const file: ExportFile = await exportNote(note, format, resolveAttachment)
      if (format === 'png') {
        const result = await shareNoteImage(file)
        exportStatus.value = result === 'shared' ? '已打开系统图片分享' : '图片已复制到剪贴板'
      } else if (await saveNoteExport(file)) exportStatus.value = `已导出 ${file.filename}`
    }
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'AbortError')) reportError(error)
  } finally {
    exportBusy.value = false
  }
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
const workspaceAvailable = computed(() => vault.state.ready && vault.state.initialized && !vault.state.locked && !vault.state.migrationRequired)

const groups = computed(() => snapshot.value?.groups ?? [])
const visibleGroupFilters = computed(() => [
  { key: 'all', name: '全部' },
  { key: 'ungrouped', name: '未分组' },
  ...groups.value.map(group => ({ key: `group:${group.id}`, name: group.name })),
])
const groupFiltersElement = ref<HTMLElement>()
watch(filterKey, async () => {
  await nextTick()
  if (!mobileLayout.value || selectionMode.value) return
  const strip = groupFiltersElement.value
  const active = strip?.querySelector<HTMLElement>('.active')
  if (!strip || !active) return
  const left = active.offsetLeft
  if (left < strip.scrollLeft) strip.scrollLeft = left
  else if (left + active.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = left + active.offsetWidth - strip.clientWidth
})
const canSwipeGroups = computed(() => mobileLayout.value && mobilePane.value === 'list'
  && !isLoading.value && !isTransitioning.value && !selectionMode.value && !sidebarOpen.value
  && !settingsOpen.value && !groupDialog.value && !vaultPanelMode.value && !privacyCovered.value
  && !noteSettingsOpen.value && !batchGroupOpen.value && !listMenuOpen.value && !keyboardVisible.value
  && visibleGroupFilters.value.some(filter => filter.key === filterKey.value))
let groupSwipe: { id: number; x: number; y: number; started: number; filter: string; horizontal: boolean } | undefined
let suppressHomeClickUntil = 0
function onHomeTouchStart(event: TouchEvent) {
  groupSwipe = undefined
  if (!canSwipeGroups.value || event.touches.length !== 1) return
  const target = event.target as HTMLElement
  if (target.closest('.search-box, .mobile-group-filters, input, textarea, select, [contenteditable], a, button:not(.note-card)')) return
  const touch = event.touches[0]!
  // Leave both screen edges available to sidebar and system navigation gestures.
  if (touch.clientX <= 32 || touch.clientX >= window.innerWidth - 32) return
  groupSwipe = { id: touch.identifier, x: touch.clientX, y: touch.clientY, started: performance.now(), filter: filterKey.value, horizontal: false }
}
function onHomeTouchMove(event: TouchEvent) {
  const swipe = groupSwipe
  if (!swipe) return
  if (!canSwipeGroups.value || event.touches.length !== 1 || swipe.filter !== filterKey.value) {
    groupSwipe = undefined
    return
  }
  const touch = event.touches[0]!
  const dx = Math.abs(touch.clientX - swipe.x)
  const dy = Math.abs(touch.clientY - swipe.y)
  if (!swipe.horizontal) {
    if (Math.max(dx, dy) < 10) return
    clearTimeout(longPressTimer)
    if (dx <= dy * 1.5) { groupSwipe = undefined; return }
    swipe.horizontal = true
  }
  suppressHomeClickUntil = performance.now() + 600
  if (event.cancelable) event.preventDefault()
}
function onHomeTouchEnd(event: TouchEvent) {
  const swipe = groupSwipe
  groupSwipe = undefined
  if (!swipe?.horizontal) return
  suppressHomeClickUntil = performance.now() + 400
  const touch = Array.from(event.changedTouches).find(touch => touch.identifier === swipe.id)
  if (!touch || event.touches.length || !canSwipeGroups.value || filterKey.value !== swipe.filter) return
  const dx = touch.clientX - swipe.x
  const dy = touch.clientY - swipe.y
  if (Math.abs(dx) < 56 || Math.abs(dx) <= Math.abs(dy) * 1.5 || performance.now() - swipe.started > 900) return
  const index = visibleGroupFilters.value.findIndex(filter => filter.key === swipe.filter)
  const next = visibleGroupFilters.value[index + (dx < 0 ? 1 : -1)]
  if (next) chooseFilter(next.key)
}
function onHomeClick(event: MouseEvent) {
  if (performance.now() < suppressHomeClickUntil) {
    event.preventDefault()
    event.stopPropagation()
  }
}
const allNotes = computed(() => [...(snapshot.value?.notes ?? [])]
  .map(note => note.kind === 'mindmap' ? { ...note, title: mindNoteTitle(note.title) } : note)
  .filter((note) => note.privacy === (filterKey.value === 'private' ? 'private' : 'normal'))
  .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))
const ungroupedCount = computed(() => allNotes.value.filter((note) => note.groupId === null).length)
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
  actionError.value = errorText(error).replaceAll('思维笔记', '灵感笔记')
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

function resetDraftState(note: Note, preserveEditing = false) {
  note = withMindNoteTitle(note)
  activeNote.value = note
  if (!preserveEditing) {
    mobileEditing.value = false
    newNoteFocus.value = false
    noteSettingsOpen.value = false
  }
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
  clearSelection()
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
    await vault.openLocal()
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
      resetDraftState(latest, true)
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
  clearSelection()
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
    if (kind === 'mindmap') {
      note = withMindNoteTitle(note)
      note = await platform.repository.saveNote({ id: note.id, title: note.title, groupId: note.groupId, content: note.content, plainText: mindMapText(note.content as MindMapDocument) })
    }
    if (snapshot.value) snapshot.value = { ...snapshot.value, notes: [summaryFromNote(note), ...snapshot.value.notes] }
    resetDraftState(note)
    mobileEditing.value = mobileLayout.value && kind === 'richtext'
    newNoteFocus.value = mobileEditing.value
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
    noteSettingsOpen.value = false
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
    let note = withMindNoteTitle(await platform.repository.convertToMindMap(id))
    note = await platform.repository.saveNote({ id: note.id, title: note.title, groupId: note.groupId, content: note.content, plainText: mindMapText(note.content as MindMapDocument) })
    replaceSummary(summaryFromNote(note))
    resetDraftState(note)
  })
}

function updateDocument(content: NoteContent, plainText: string) {
  if (!activeNote.value) return
  if (activeNote.value.kind === 'mindmap') {
    const map = content as MindMapDocument
    content = { ...map, root: { ...map.root, text: mindNoteTitle(map.root.text) } }
    plainText = mindMapText(content as MindMapDocument)
  }
  const title = activeNote.value.kind === 'mindmap' ? (content as MindMapDocument).root.text : activeNote.value.title
  activeNote.value = { ...activeNote.value, title, content }
  draftPlainText.value = plainText
  markDraftChanged()
}

const titlePlaceholder = computed(() => activeNote.value?.kind === 'mindmap' ? UNTITLED_MIND_MAP : '未命名笔记')
const editorTitle = computed({
  get: () => activeNote.value?.title === titlePlaceholder.value ? '' : activeNote.value?.title ?? '',
  set: (text: string) => {
    const note = activeNote.value
    if (!note) return
    const title = text || titlePlaceholder.value
    if (note.kind === 'mindmap') {
      const map = note.content as MindMapDocument
      const next = { ...map, root: { ...map.root, text: title } }
      updateDocument(next, mindMapText(next))
    } else {
      activeNote.value = { ...note, title }
      markDraftChanged()
    }
  },
})

async function changeNoteGroup(groupId: string | null) {
  noteChoice.value = null
  await runTransition(async () => {
    if (!activeNote.value) return
    activeNote.value = { ...activeNote.value, groupId }
    replaceSummary(summaryFromNote(activeNote.value, draftPlainText.value))
    markDraftChanged()
  })
}

async function changeNotePolicy(privacy: PrivacyMode, syncPolicy: SyncPolicy) {
  const original = activeNote.value
  if (!original) return
  noteChoice.value = null
  await runTransition(async () => {
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
}

function changePrivacy(privacy: PrivacyMode) {
  const note = activeNote.value
  if (!note) return
  const syncPolicy = privacy === 'private' && note.privacy === 'normal' ? 'localOnly' : note.syncPolicy
  void changeNotePolicy(privacy, syncPolicy)
}

function changeSyncPolicy(syncPolicy: SyncPolicy) {
  const note = activeNote.value
  if (note) void changeNotePolicy(note.privacy, syncPolicy)
}

async function moveSelectedNotes(groupId: string | null) {
  await runTransition(async () => {
    for (const id of selectedNoteIds.value) {
      const note = await platform.repository.getNote(id)
      const saved = await platform.repository.saveNote({
        id, title: note.title, groupId, content: note.content,
        plainText: note.kind === 'mindmap' ? mindMapText(note.content as MindMapDocument) : documentText(note.content as JSONContent),
      })
      replaceSummary(summaryFromNote(saved))
      if (activeNote.value?.id === id) activeNote.value = saved
    }
    clearSelection()
  })
}

async function deleteSelectedNotes() {
  await runTransition(async () => {
    for (const id of selectedNoteIds.value) await platform.repository.deleteNote(id)
    if (snapshot.value) snapshot.value = { ...snapshot.value, notes: snapshot.value.notes.filter((note) => !selectedNoteIds.value.has(note.id)) }
    if (activeNote.value && selectedNoteIds.value.has(activeNote.value.id)) clearActiveNote()
    clearSelection()
  })
}

function chooseFilter(key: string) {
  clearSelection()
  if (filterKey.value === 'private' && key !== 'private') {
    void leavePrivateArea(key)
    return
  }
  filterKey.value = key
  sidebarOpen.value = false
  mobilePane.value = 'list'
}

async function showNoteList() {
  await runTransition(async () => { mobilePane.value = 'list'; noteSettingsOpen.value = false })
}

function navigateBack(event: Event) {
  if (batchGroupOpen.value) {
    event.preventDefault()
    batchGroupOpen.value = false
  } else if (selectionMode.value) {
    event.preventDefault()
    clearSelection()
  } else if (noteChoice.value) {
    event.preventDefault()
    noteChoice.value = null
  } else if (noteSettingsOpen.value) {
    event.preventDefault()
    noteSettingsOpen.value = false
  } else if (listMenuOpen.value) {
    event.preventDefault()
    listMenuOpen.value = false
  } else if (vaultPanelMode.value) {
    event.preventDefault()
    closePrivacyPanel()
  } else if (settingsOpen.value) {
    event.preventDefault()
    settingsOpen.value = false
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
  sidebarOpen.value = false
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
  return allNotes.value.filter((note) => note.groupId === groupId).length
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
  window.addEventListener('insp:back', navigateBack)
  window.addEventListener('online', handleOnline)
  document.addEventListener('visibilitychange', handleVisibility)
  window.addEventListener('insp:insets', applyInsets)
  window.addEventListener('insp:theme', updateNativeTheme)
  updateNativeTheme()
  void loadInsets().catch(reportError)
  remoteRefreshTimer = setInterval(refreshRemoteWhenVisible, 30_000)
  vault.setSyncHooks(beforeSyncApply, afterSyncApply)
  try {
    await vault.initialize()
    await vault.openLocal()
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
  clearTimeout(scrollStopTimer)
  clearTimeout(longPressTimer)
  window.removeEventListener('resize', updateViewport)
  window.removeEventListener('insp:back', navigateBack)
  window.removeEventListener('online', handleOnline)
  document.removeEventListener('visibilitychange', handleVisibility)
  window.removeEventListener('insp:insets', applyInsets)
  window.removeEventListener('insp:theme', updateNativeTheme)
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
  <div v-else class="notes-app" :class="{ 'mobile-editor-open': mobilePane === 'editor', 'sidebar-open': sidebarOpen, 'mobile-writing': mobileEditing, 'note-settings-open': noteSettingsOpen, 'keyboard-open': keyboardVisible, 'selecting-notes': selectionMode }" @pointerdown="onButtonPointerDown">
    <header class="mobile-header">
      <template v-if="selectionMode">
        <button class="icon-button" type="button" aria-label="退出多选" @click="clearSelection"><X :size="24" /></button>
        <strong class="selection-count">已选 {{ selectedNoteIds.size }} 项</strong>
        <button class="select-all-button" type="button" @click="selectedNoteIds = selectedNoteIds.size === filteredNotes.length ? new Set() : new Set(filteredNotes.map((note) => note.id))">{{ selectedNoteIds.size === filteredNotes.length ? '取消全选' : '全选' }}</button>
      </template>
      <template v-else>
        <button class="icon-button" type="button" aria-label="打开分组导航" @click="sidebarOpen = true"><Menu :size="25" /></button>
        <strong :class="{ visible: listScrolled }">{{ currentFilterName === '全部笔记' ? '笔记' : currentFilterName }}</strong>
        <button class="icon-button" type="button" :aria-label="listLayout === 'grid' ? '切换列表' : '切换宫格'" @click="setListLayout(listLayout === 'grid' ? 'list' : 'grid')"><List v-if="listLayout === 'grid'" :size="23" /><LayoutGrid v-else :size="22" /></button>
        <button class="icon-button" aria-label="更多操作" @click="listMenuOpen = true"><MoreHorizontal :size="25" /></button>
      </template>
    </header>
    <button v-if="sidebarOpen" class="sidebar-scrim" type="button" aria-label="关闭分组导航" @click="sidebarOpen = false"></button>
    <aside class="sidebar" aria-label="笔记导航">
      <div class="brand-lockup">
        <div class="brand-copy"><strong>拾页 · Inspiration</strong><span>by OpenALC</span></div>
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

      <div class="sidebar-bottom"><button class="sidebar-settings" type="button" @click="openSettings"><Settings2 :size="22" /><span>设置</span></button></div>
    </aside>

    <section class="note-list-pane" :class="{ 'layout-list': listLayout === 'list' }" aria-label="笔记列表" @scroll="onListScroll" @touchstart.passive="onHomeTouchStart" @touchmove="onHomeTouchMove" @touchend="onHomeTouchEnd" @touchcancel="groupSwipe = undefined" @click.capture="onHomeClick">
      <header class="list-pane-header">
        <div>
          <div class="eyebrow">拾页 / NOTES</div>
          <h1>{{ currentFilterName === '全部笔记' ? '笔记' : currentFilterName }}</h1>
        </div>
        <div class="create-actions">
          <button class="create-note-button" type="button" aria-label="新建笔记" title="新建笔记" :disabled="isLoading || isTransitioning" @click="createNote('richtext')"><FilePlus2 :size="17" /><span>笔记</span></button>
          <button class="create-note-button create-map-button" type="button" aria-label="新建灵感笔记" title="新建灵感笔记" :disabled="isLoading || isTransitioning" @click="createNote('mindmap')"><Workflow :size="17" /><span>灵感笔记</span></button>
        </div>
      </header>

      <label class="search-box">
        <Search :size="17" aria-hidden="true" />
        <input v-model="searchQuery" type="search" placeholder="搜索笔记" aria-label="搜索笔记标题和正文摘要" />
      </label>

      <nav ref="groupFiltersElement" class="mobile-group-filters" aria-label="笔记分组">
        <button v-for="filter in visibleGroupFilters" :key="filter.key" :class="{ active: filterKey === filter.key }" :aria-current="filterKey === filter.key ? 'true' : undefined" :disabled="isTransitioning" @click="chooseFilter(filter.key)">{{ filter.name }}</button>
      </nav>
      <div class="list-meta"><span>{{ searchQuery ? `找到 ${filteredNotes.length} 篇` : `${filteredNotes.length} 篇笔记` }}</span><span class="sort-label"><Clock3 :size="13" />最近编辑</span></div>

      <div v-if="isLoading" class="list-loading" role="status"><span class="loading-orbit"></span><span>正在打开本地笔记…</span></div>
      <div v-else-if="filteredNotes.length" class="note-list">
        <button v-for="note in filteredNotes" :key="note.id" class="note-card" :class="{ selected: !selectionMode && activeNote?.id === note.id, 'multi-selected': selectedNoteIds.has(note.id) }" :aria-pressed="selectionMode ? selectedNoteIds.has(note.id) : undefined" :disabled="isTransitioning" @pointerdown="notePointerDown($event, note.id)" @pointermove="notePointerMove" @pointerup="notePointerEnd" @pointercancel="notePointerEnd" @contextmenu="noteContextMenu($event, note.id)" @click="noteCardClick(note.id)">
          <span v-if="selectionMode" class="note-selection-mark"><Check v-if="selectedNoteIds.has(note.id)" :size="16" /></span>
          <span class="note-card-icon"><Workflow v-if="note.kind === 'mindmap'" :size="17" /><FileText v-else :size="17" /></span>
          <span class="note-card-content">
            <span class="note-card-topline"><strong>{{ note.title || (note.kind === 'mindmap' ? UNTITLED_MIND_MAP : '未命名笔记') }}</strong></span>
            <MindMapCardPreview v-if="note.kind === 'mindmap' && note.mindMapPreview" :preview="note.mindMapPreview" />
            <span v-else class="note-preview">{{ note.preview || '还没有正文，点开继续记录。' }}</span>
            <span class="note-card-foot"><time>{{ formatDate(note.updatedAt) }}</time><span v-if="note.groupId" class="note-group-tag">{{ groups.find((item) => item.id === note.groupId)?.name ?? '分组' }}</span><Workflow v-if="note.kind === 'mindmap'" :size="15" aria-label="灵感笔记" /></span>
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

    </section>
    <div class="floating-compose" :class="{ compact: listScrolling }" aria-label="创建笔记"><button class="compose-main" aria-label="新建普通笔记" :disabled="isTransitioning" @click="createNote('richtext')"><Plus :size="27" /><span>笔记</span></button><span class="compose-separator"></span><button aria-label="新建灵感笔记" :disabled="isTransitioning" @click="createNote('mindmap')"><Workflow :size="24" /><span>灵感笔记</span></button></div>
    <div v-if="selectionMode" class="batch-actions" role="toolbar" aria-label="多选笔记操作"><button :disabled="!selectedNoteIds.size || isTransitioning" @click="batchGroupOpen = true"><Folder :size="21" />移动到</button><button class="danger" :disabled="!selectedNoteIds.size || isTransitioning" @click="deleteSelectedNotes"><Trash2 :size="21" />删除</button></div>

    <main class="editor-pane">
      <div v-if="actionError && showError" class="error-banner" role="alert">
        <CircleAlert :size="17" />
        <span>{{ actionError }}</span>
        <button type="button" aria-label="关闭错误提示" @click="showError = false"><X :size="16" /></button>
      </div>
      <template v-if="activeNote">
        <header class="editor-topbar">
          <button class="icon-button mobile-back" type="button" :aria-label="mobileEditing ? '结束编辑' : '返回笔记列表'" :disabled="isTransitioning" @click="mobileEditing ? finishMobileEditing() : showNoteList()"><ArrowLeft :size="20" /></button>
          <input v-if="mobileLayout" v-model="editorTitle" class="topbar-note-title" :placeholder="titlePlaceholder" aria-label="笔记标题" :disabled="isTransitioning" @focus="mobileEditing = true" />
          <div v-else class="breadcrumb"><span>拾页</span><ChevronRight :size="14" /><span>{{ activeGroupName }}</span><ChevronRight :size="14" /><span class="breadcrumb-current">笔记</span></div>
          <div v-if="mobileEditing && activeNote.kind === 'richtext'" class="mobile-history"><button class="icon-button" aria-label="撤销编辑" :disabled="!richEditor?.canUndo" @pointerdown.prevent @click="richEditor?.undo()"><Undo2 :size="22" /></button><button class="icon-button" aria-label="重做编辑" :disabled="!richEditor?.canRedo" @pointerdown.prevent @click="richEditor?.redo()"><Redo2 :size="22" /></button></div>
          <button v-if="mobileEditing" class="mobile-done" @click="finishMobileEditing">完成</button>
          <button v-if="activeNote.kind === 'mindmap'" class="icon-button mind-view-toggle" type="button" :disabled="!mindEditor" :aria-label="nextMindView === 'tree' ? '切换到思维树' : '切换到列表'" :title="nextMindView === 'tree' ? '切换到思维树' : '切换到列表'" @pointerdown.prevent @click="mindEditor?.switchView(nextMindView)"><Network v-if="nextMindView === 'tree'" :size="21" /><ListTree v-else :size="21" /></button>
          <button class="mobile-note-settings icon-button" type="button" aria-label="笔记设置" :aria-expanded="noteSettingsOpen" @pointerdown.prevent @click="openNoteOptions"><Settings2 :size="20" /></button>
        </header>

        <div v-if="activeNote.kind === 'richtext'" class="document-heading">
          <div class="document-kicker">{{ formatDate(activeNote.updatedAt) }}<span>｜</span>{{ draftPlainText.length }} 字</div>
          <input v-if="!mobileLayout" v-model="editorTitle" class="document-title" :placeholder="titlePlaceholder" aria-label="笔记标题" :disabled="isTransitioning" @focus="mobileEditing = true" />
        </div>

        <button v-if="canCreateMindNote" type="button" class="blank-mind-note" :disabled="isTransitioning" @pointerdown.prevent @click="createMindNoteFromBlank"><Workflow :size="17" />创建灵感笔记<span>用层级整理想法</span></button>
        <RichTextEditor
          v-if="activeNote.kind === 'richtext'"
          :key="activeNote.id"
          ref="richEditor"
          :autofocus="newNoteFocus"
          :reading="mobileLayout && !mobileEditing"
          @edit="mobileEditing = true"
          :content="activeNote.content as JSONContent"
          :editable="!isTransitioning"
          @update:document="updateDocument"
          @io-error="reportError"
        />
        <MindMapEditor
          v-else
          aria-label="灵感笔记编辑器"
          ref="mindEditor"
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

    <Transition name="settings-slide"><SettingsPage v-if="settingsOpen" :vault="vault" :layout="listLayout" @close="settingsOpen = false" @privacy="authenticateSettings" @sync="syncWorkspace" @joined="retryInitialize" @layout="setListLayout" /></Transition>
    <div v-if="privacyCovered" class="privacy-cover"><LockKeyhole :size="34" /><span>隐私笔记已隐藏</span><button class="action-secondary" @click="vaultPanelMode = 'privacy'">验证后继续</button></div>
    <div v-if="listMenuOpen" class="sheet-backdrop" @click.self="listMenuOpen = false"><section class="bottom-sheet" role="dialog" aria-modal="true" aria-label="笔记操作"><div class="sheet-grabber"></div><button class="sheet-action" @click="listMenuOpen = false; showGroupDialog({ mode: 'create' })"><FolderPlus :size="22" />新建分组</button><button class="sheet-action" @click="listMenuOpen = false; openPrivateArea()"><LockKeyhole :size="22" />隐私笔记</button><button class="sheet-cancel" @click="listMenuOpen = false">取消</button></section></div>
    <div v-if="batchGroupOpen" class="sheet-backdrop" @click.self="batchGroupOpen = false"><section class="bottom-sheet" role="dialog" aria-modal="true" aria-label="移动所选笔记到分组"><div class="sheet-grabber"></div><h2>移动到</h2><button class="sheet-action" :disabled="isTransitioning" @click="moveSelectedNotes(null)"><Inbox :size="21" />未分组</button><button v-for="group in groups" :key="group.id" class="sheet-action" :disabled="isTransitioning" @click="moveSelectedNotes(group.id)"><Folder :size="21" />{{ group.name }}</button><button class="sheet-cancel" @click="batchGroupOpen = false">取消</button></section></div>
    <div v-if="noteSettingsOpen && activeNote" class="sheet-backdrop note-options-backdrop" :class="{ 'dismissing-keyboard': optionsRestingHeight > 0 }" :style="viewportHeight < optionsRestingHeight ? { height: optionsRestingHeight + 'px' } : undefined" @click.self="noteSettingsOpen = false"><section ref="optionsPanel" class="bottom-sheet note-options" tabindex="-1" role="dialog" aria-modal="true" aria-label="笔记设置"><div class="sheet-grabber"></div><h2 v-if="noteChoice === null">笔记选项</h2>
          <template v-if="noteChoice === null">
            <button class="sheet-action choice-trigger" :disabled="isTransitioning" @click="noteChoice = 'group'"><Folder :size="21" /><span>移动到</span><span class="choice-value">{{ activeGroupName }}</span><ChevronRight :size="18" /></button>
            <button class="sheet-action choice-trigger" :disabled="isTransitioning" @click="noteChoice = 'privacy'"><Shield :size="21" /><span>隐私</span><span class="choice-value">{{ activeNote.privacy === 'private' ? '隐私笔记' : '普通笔记' }}</span><ChevronRight :size="18" /></button>
            <button class="sheet-action choice-trigger" :disabled="isTransitioning" @click="noteChoice = 'sync'"><Network :size="21" /><span>同步</span><span class="choice-value">{{ activeNote.syncPolicy === 'sync' ? '同步此笔记' : '仅本机' }}</span><ChevronRight :size="18" /></button>
            <button class="sheet-action choice-trigger" :disabled="isTransitioning" @click="noteChoice = 'export'"><Share2 :size="21" /><span>分享与导出</span><span class="choice-value"></span><ChevronRight :size="18" /></button>
            <p v-if="activeNote.privacy === 'private' && activeNote.syncPolicy === 'sync'" class="private-sync-note">此隐私笔记已明确启用同步。</p>
            <button class="sheet-action destructive-action" :disabled="isTransitioning" @click="deleteActiveNote"><Trash2 :size="21" />删除笔记</button>
            <button class="sheet-cancel" @click="noteSettingsOpen = false">完成</button>
          </template>
          <template v-else>
            <button class="choice-back" @click="noteChoice = null"><ArrowLeft :size="19" />{{ noteChoice === 'group' ? '选择分组' : noteChoice === 'privacy' ? '隐私设置' : noteChoice === 'sync' ? '同步设置' : '分享与导出' }}</button>
            <template v-if="noteChoice === 'group'"><button class="sheet-action" @click="changeNoteGroup(null)"><Inbox :size="21" />未分组<Check v-if="!activeNote.groupId" class="choice-check" :size="20" /></button><button v-for="group in groups" :key="group.id" class="sheet-action" @click="changeNoteGroup(group.id)"><Folder :size="21" />{{ group.name }}<Check v-if="activeNote.groupId === group.id" class="choice-check" :size="20" /></button></template>
            <template v-else-if="noteChoice === 'privacy'"><button class="sheet-action" @click="changePrivacy('normal')"><FileText :size="21" />普通笔记<Check v-if="activeNote.privacy === 'normal'" class="choice-check" :size="20" /></button><button class="sheet-action" @click="changePrivacy('private')"><LockKeyhole :size="21" />隐私笔记<Check v-if="activeNote.privacy === 'private'" class="choice-check" :size="20" /></button></template>
            <template v-else-if="noteChoice === 'sync'"><button class="sheet-action" @click="changeSyncPolicy('localOnly')"><Shield :size="21" />仅本机<Check v-if="activeNote.syncPolicy === 'localOnly'" class="choice-check" :size="20" /></button><button class="sheet-action" @click="changeSyncPolicy('sync')"><Network :size="21" />同步此笔记<Check v-if="activeNote.syncPolicy === 'sync'" class="choice-check" :size="20" /></button></template>
            <template v-else>
              <button class="sheet-action" :disabled="exportBusy" @click="exportCurrentNote('png')"><ImageIcon :size="21" />以图片分享</button>
              <button class="sheet-action" :disabled="exportBusy" @click="exportCurrentNote('plaintext')"><Copy :size="21" />以纯文本分享</button>
              <button class="sheet-action" :disabled="exportBusy" @click="exportCurrentNote('markdown')"><FileDown :size="21" />导出 Markdown</button>
              <button class="sheet-action" :disabled="exportBusy" @click="exportCurrentNote('docx')"><FileDown :size="21" />导出 Word</button>
              <button class="sheet-action" :disabled="exportBusy" @click="exportCurrentNote('pdf')"><FileDown :size="21" />导出 PDF</button>
              <p class="export-note">纯文本分享会自动复制正文。导出文件由系统选择保存位置。</p>
              <p v-if="exportBusy || exportStatus" class="export-status" role="status">{{ exportBusy ? '正在准备文件…' : exportStatus }}</p>
            </template>
          </template>
        </section></div>
    <VaultPanel
      v-if="vaultPanelMode"
      :vault="vault"
      :mode="vaultPanelMode"
      @close="closePrivacyPanel"
      @revealed="handleRevealed"
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
