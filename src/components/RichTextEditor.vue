<script setup lang="ts">
import { computed, ref, toRaw, watch } from 'vue'
import { Mark, type JSONContent } from '@tiptap/core'
import { EditorContent, useEditor } from '@tiptap/vue-3'
import { TextSelection, type SelectionBookmark } from '@tiptap/pm/state'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import TextAlign from '@tiptap/extension-text-align'
import {
  Bold,
  Heading1,
  Heading2,
  Heading3,
  AlignCenter,
  AlignLeft,
  AlignRight,
  IndentIncrease,
  IndentDecrease,
  Minus,
  Highlighter,
  ImagePlus,
  Italic,
  Link,
  List,
  ListOrdered,
  ListTodo,
  Quote,
  Redo2,
  Strikethrough,
  Underline,
  Undo2,
} from 'lucide-vue-next'
import { platform } from '../platform'
import { AttachmentImage } from './attachment-image'
import { useContentZoom } from '../content-zoom'
import { ParagraphLayout } from './paragraph-layout'

const props = defineProps<{
  content: JSONContent
  editable: boolean
  reading?: boolean
  autofocus?: boolean
}>()

const emit = defineEmits<{
  'update:document': [content: JSONContent, plainText: string]
  'io-error': [error: unknown]
  edit: []
}>()

const Highlight = Mark.create({
  name: 'highlight',
  parseHTML: () => [{ tag: 'mark' }],
  renderHTML: () => ['mark', {}, 0],
})

type TrackedBookmark = { selection: SelectionBookmark }

const formatOpen = ref(false)
const linkOpen = ref(false)
const linkHref = ref('')
const linkText = ref('')
const linkExisting = ref(false)
const bookmarks = new Set<TrackedBookmark>()
let imageBookmark: TrackedBookmark | undefined
let linkBookmark: TrackedBookmark | undefined
const imagePicker = ref<HTMLInputElement | null>(null)
const transactionTick = ref(0)
let lastEmittedContent: JSONContent | undefined
const pendingImports = new Set<Promise<void>>()
const contentViewport = ref<HTMLElement>()
const contentSurface = ref<HTMLElement>()
const { extentStyle, surfaceStyle } = useContentZoom(contentViewport, contentSurface, undefined, { fillHeight: true })

const editor = useEditor({
  content: props.content,
  editable: props.editable && !props.reading,
  extensions: [
    StarterKit.configure({ link: { openOnClick: false } }),
    Placeholder.configure({ placeholder: '从这里开始记录……' }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TextAlign.configure({ types: ['paragraph', 'heading'] }),
    ParagraphLayout,
    AttachmentImage,
    Highlight,
  ],
  editorProps: {
    attributes: {
      class: 'rich-editor-content',
      spellcheck: 'true',
      'aria-label': '笔记正文',
    },
    transformPastedHTML(html) {
      const document = new DOMParser().parseFromString(html, 'text/html')
      document.querySelectorAll('img').forEach((image) => {
        if (image.hasAttribute('data-note-image') && image.hasAttribute('data-attachment-id')) {
          image.removeAttribute('src')
          image.removeAttribute('srcset')
        } else {
          image.remove()
        }
      })
      return document.body.innerHTML
    },
    handlePaste(_view, event) {
      const images = Array.from(event.clipboardData?.items ?? [])
        .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null)
      if (images.length === 0) return false
      event.preventDefault()
      startImport(images)
      return true
    },
    handleDrop(view, event) {
      const images = Array.from(event.dataTransfer?.files ?? []).filter((file) => file.type.startsWith('image/'))
      if (images.length === 0) return false
      event.preventDefault()
      const point = view.posAtCoords({ left: event.clientX, top: event.clientY })
      const bookmark = point ? TextSelection.near(view.state.doc.resolve(point.pos)).getBookmark() : undefined
      startImport(images, bookmark)
      return true
    },
  },
  onUpdate({ editor: currentEditor }) {
    lastEmittedContent = currentEditor.getJSON()
    emit('update:document', lastEmittedContent, currentEditor.getText({ blockSeparator: '\n' }))
  },
  onTransaction({ transaction, appendedTransactions }) {
    for (const change of [transaction, ...appendedTransactions]) {
      if (!change.docChanged) continue
      for (const bookmark of bookmarks) {
        bookmark.selection = bookmark.selection.map(change.mapping)
      }
    }
    transactionTick.value += 1
  },
})

let autofocusDone = false
watch(
  () => [editor.value, props.editable, props.reading, props.autofocus] as const,
  ([currentEditor, editable, reading, autofocus]) => {
    currentEditor?.setEditable(editable && !reading, false)
    if (currentEditor && editable && !reading && autofocus && !autofocusDone) {
      autofocusDone = true
      currentEditor.commands.focus('end')
    }
  },
  { flush: 'post' },
)

watch(() => props.content, content => {
  const currentEditor = editor.value
  if (toRaw(content) === lastEmittedContent) { lastEmittedContent = undefined; return }
  if (currentEditor) {
    const { from, to } = currentEditor.state.selection
    currentEditor.commands.setContent(content, { emitUpdate: false })
    const size = currentEditor.state.doc.content.size
    currentEditor.commands.setTextSelection({ from: Math.min(from, size), to: Math.min(to, size) })
  }
})

function openImagePicker() {
  if (!editor.value || !props.editable) return
  releaseImageBookmark()
  imageBookmark = trackBookmark(editor.value.state.selection.getBookmark())
  imagePicker.value?.click()
}

function trackBookmark(selection: SelectionBookmark): TrackedBookmark {
  const bookmark = { selection }
  bookmarks.add(bookmark)
  return bookmark
}

function releaseImageBookmark() {
  if (imageBookmark) bookmarks.delete(imageBookmark)
  imageBookmark = undefined
}

async function importImages(files: File[], bookmark: TrackedBookmark) {
  try {
    const imported: Array<{ attachmentId: string; alt: string }> = []
    for (const file of files) {
      const attachment = await platform.attachments.importImage(file)
      imported.push({ attachmentId: attachment.id, alt: file.name })
    }
    const currentEditor = editor.value
    if (!currentEditor || currentEditor.isDestroyed) return
    const selection = bookmark.selection.resolve(currentEditor.state.doc)
    currentEditor.commands.insertContentAt(
      { from: selection.from, to: selection.to },
      imported.map((image) => ({ type: 'image', attrs: image })),
      { updateSelection: false },
    )
  } catch (error) {
    emit('io-error', error)
  } finally {
    bookmarks.delete(bookmark)
  }
}

function startImport(files: File[], selection?: SelectionBookmark) {
  if (!editor.value || !props.editable) return
  const bookmark = trackBookmark(selection ?? editor.value.state.selection.getBookmark())
  queueImport(files, bookmark)
}

function queueImport(files: File[], bookmark: TrackedBookmark) {
  let pending!: Promise<void>
  pending = importImages(files, bookmark).finally(() => pendingImports.delete(pending))
  pendingImports.add(pending)
}

async function awaitPendingImports() {
  while (pendingImports.size > 0) await Promise.all(Array.from(pendingImports))
}

function onImagePickerChange(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (files.length > 0) {
    emit('edit')
    if (imageBookmark) {
      queueImport(files, imageBookmark)
      imageBookmark = undefined
    } else {
      startImport(files)
    }
  } else {
    releaseImageBookmark()
  }
}

function run(command: () => void) {
  if (editor.value && props.editable) command()
}

function openLinkDialog() {
  const current = editor.value
  if (!current) return
  linkExisting.value = current.isActive('link')
  if (linkExisting.value && current.state.selection.empty) current.commands.extendMarkRange('link')
  linkBookmark = trackBookmark(current.state.selection.getBookmark())
  const { from, to } = current.state.selection
  linkText.value = current.state.doc.textBetween(from, to)
  linkHref.value = (current.getAttributes('link').href as string | undefined) ?? 'https://'
  linkOpen.value = true
}

function closeLinkDialog() {
  linkOpen.value = false
  if (linkBookmark) bookmarks.delete(linkBookmark)
  linkBookmark = undefined
}

function applyLink() {
  const current = editor.value
  if (!current || !linkBookmark) return
  const href = linkHref.value.trim()
  const selection = linkBookmark.selection.resolve(current.state.doc)
  const chain = current.chain().focus().setTextSelection({ from: selection.from, to: selection.to })
  if (href) {
    if (selection.empty) chain.insertContent({ type: 'text', text: linkText.value || href, marks: [{ type: 'link', attrs: { href } }] }).run()
    else chain.setLink({ href }).run()
  } else if (!selection.empty) chain.unsetLink().run()
  closeLinkDialog()
}

function removeLink() {
  const current = editor.value
  if (!current || !linkBookmark) return
  const selection = linkBookmark.selection.resolve(current.state.doc)
  current.chain().focus().setTextSelection({ from: selection.from, to: selection.to }).unsetLink().run()
  closeLinkDialog()
}

function isActive(name: string, attributes?: Record<string, unknown>) {
  void transactionTick.value
  return editor.value?.isActive(name, attributes) ?? false
}
function adjustIndent(delta: number) {
  const current = editor.value
  if (!current) return
  if (current.isActive('listItem')) {
    if (delta > 0) current.chain().focus().sinkListItem('listItem').run()
    else current.chain().focus().liftListItem('listItem').run()
    return
  }
  if (current.isActive('taskItem')) {
    if (delta > 0) current.chain().focus().sinkListItem('taskItem').run()
    else current.chain().focus().liftListItem('taskItem').run()
    return
  }
  const type = current.isActive('heading') ? 'heading' : 'paragraph'
  const indent = Math.max(0, Math.min(4, Number(current.getAttributes(type).indent || 0) + delta))
  current.chain().focus().updateAttributes(type, { indent }).run()
}

function finishEditing() {
  formatOpen.value = false
  editor.value?.commands.blur()
}
function beginEditing(event: MouseEvent) {
  const currentEditor = editor.value
  if (!props.reading || !props.editable || !currentEditor) return
  if ((event.target as Element).closest('a, button, input, label, select, textarea')) return
  const position = currentEditor.view.posAtCoords({ left: event.clientX, top: event.clientY })
  emit('edit')
  currentEditor.setEditable(true, false)
  currentEditor.commands.focus(position?.pos ?? 'end')
}
const canUndo = computed(() => { void transactionTick.value; return editor.value?.can().undo() ?? false })
const canRedo = computed(() => { void transactionTick.value; return editor.value?.can().redo() ?? false })
function focusEditor() { editor.value?.commands.focus('end') }
function undo() { run(() => editor.value?.chain().focus().undo().run()) }
function redo() { run(() => editor.value?.chain().focus().redo().run()) }
defineExpose({ awaitPendingImports, finishEditing, focusEditor, undo, redo, canUndo, canRedo })
</script>

<template>
  <section class="editor-surface" :class="{ 'editor-surface-disabled': !editable, 'editor-reading': reading, 'format-open': formatOpen }" aria-label="富文本编辑器" @click="beginEditing">
    <div class="format-toolbar" role="toolbar" aria-label="文字格式" @pointerdown.prevent @mousedown.prevent @click.stop>
      <div class="toolbar-group format-commands">
        <button type="button" class="tool-button" :class="{ active: isActive('bold') }" aria-label="加粗" title="加粗" :disabled="!editable" @mousedown.prevent @click="run(() => editor?.chain().focus().toggleBold().run())"><Bold :size="17" /></button>
        <button type="button" class="tool-button" :class="{ active: isActive('italic') }" aria-label="斜体" title="斜体" :disabled="!editable" @mousedown.prevent @click="run(() => editor?.chain().focus().toggleItalic().run())"><Italic :size="17" /></button>
        <button type="button" class="tool-button" :class="{ active: isActive('underline') }" aria-label="下划线" title="下划线" :disabled="!editable" @mousedown.prevent @click="run(() => editor?.chain().focus().toggleUnderline().run())"><Underline :size="17" /></button>
        <button type="button" class="tool-button" :class="{ active: isActive('strike') }" aria-label="删除线" title="删除线" :disabled="!editable" @mousedown.prevent @click="run(() => editor?.chain().focus().toggleStrike().run())"><Strikethrough :size="17" /></button>
        <button type="button" class="tool-button" :class="{ active: isActive('highlight') }" :aria-pressed="isActive('highlight')" aria-label="高亮" title="高亮" :disabled="!editable" @click="run(() => editor?.chain().focus().toggleMark('highlight').run())"><Highlighter :size="17" /></button>
      </div>
      <span class="toolbar-divider format-commands" aria-hidden="true"></span>
      <div class="toolbar-group format-commands">
        <button type="button" class="tool-button" :class="{ active: isActive('heading', { level: 1 }) }" aria-label="一级标题" title="一级标题" :disabled="!editable" @mousedown.prevent @click="run(() => editor?.chain().focus().toggleHeading({ level: 1 }).run())"><Heading1 :size="18" /></button>
        <button type="button" class="tool-button" :class="{ active: isActive('heading', { level: 2 }) }" aria-label="二级标题" title="二级标题" :disabled="!editable" @mousedown.prevent @click="run(() => editor?.chain().focus().toggleHeading({ level: 2 }).run())"><Heading2 :size="18" /></button>
        <button type="button" class="tool-button" :class="{ active: isActive('heading', { level: 3 }) }" :aria-pressed="isActive('heading', { level: 3 })" aria-label="三级标题" title="三级标题" :disabled="!editable" @click="run(() => editor?.chain().focus().toggleHeading({ level: 3 }).run())"><Heading3 :size="18" /></button>
        <button type="button" class="tool-button" :class="{ active: isActive('bulletList') }" aria-label="无序列表" title="无序列表" :disabled="!editable" @mousedown.prevent @click="run(() => editor?.chain().focus().toggleBulletList().run())"><List :size="18" /></button>
        <button type="button" class="tool-button" :class="{ active: isActive('orderedList') }" aria-label="有序列表" title="有序列表" :disabled="!editable" @mousedown.prevent @click="run(() => editor?.chain().focus().toggleOrderedList().run())"><ListOrdered :size="18" /></button>
        <button type="button" class="tool-button" :class="{ active: isActive('taskList') }" aria-label="待办列表" title="待办列表" :disabled="!editable" @mousedown.prevent @click="run(() => editor?.chain().focus().toggleTaskList().run())"><ListTodo :size="18" /></button>
        <button type="button" class="tool-button" :class="{ active: isActive('blockquote') }" aria-label="引用" title="引用" :disabled="!editable" @mousedown.prevent @click="run(() => editor?.chain().focus().toggleBlockquote().run())"><Quote :size="17" /></button>
        <button type="button" class="tool-button" aria-label="分割线" title="分割线" :disabled="!editable" @mousedown.prevent @click="run(() => editor?.chain().focus().setHorizontalRule().run())"><Minus :size="18" /></button>
      </div>
      <span class="toolbar-divider format-commands" aria-hidden="true"></span>
      <div class="toolbar-group format-commands">
        <button type="button" class="tool-button" :class="{ active: isActive('paragraph', { textAlign: 'left' }) }" aria-label="左对齐" title="左对齐" :disabled="!editable" @mousedown.prevent @click="run(() => editor?.chain().focus().setTextAlign('left').run())"><AlignLeft :size="18" /></button>
        <button type="button" class="tool-button" :class="{ active: isActive('paragraph', { textAlign: 'center' }) }" aria-label="居中" title="居中" :disabled="!editable" @mousedown.prevent @click="run(() => editor?.chain().focus().setTextAlign('center').run())"><AlignCenter :size="18" /></button>
        <button type="button" class="tool-button" :class="{ active: isActive('paragraph', { textAlign: 'right' }) }" aria-label="右对齐" title="右对齐" :disabled="!editable" @mousedown.prevent @click="run(() => editor?.chain().focus().setTextAlign('right').run())"><AlignRight :size="18" /></button>
        <button type="button" class="tool-button" aria-label="增加缩进" title="增加缩进" :disabled="!editable" @mousedown.prevent @click="adjustIndent(1)"><IndentIncrease :size="18" /></button>
        <button type="button" class="tool-button" aria-label="减少缩进" title="减少缩进" :disabled="!editable" @mousedown.prevent @click="adjustIndent(-1)"><IndentDecrease :size="18" /></button>
      </div>
      <span class="toolbar-divider format-commands" aria-hidden="true"></span>
      <div class="toolbar-group format-commands">
        <button type="button" class="tool-button" :class="{ active: isActive('link') }" aria-label="插入链接" title="插入链接" :disabled="!editable" @mousedown.prevent @click="openLinkDialog"><Link :size="17" /></button>
        <button type="button" class="tool-button" aria-label="插入图片" title="插入图片" :disabled="!editable" @mousedown.prevent @click="openImagePicker"><ImagePlus :size="18" /></button>
      </div>
      <span class="toolbar-spacer format-commands"></span>
      <div class="toolbar-group history-tools format-commands">
        <button type="button" class="tool-button" aria-label="撤销" title="撤销" :disabled="!editable || !editor?.can().undo()" @mousedown.prevent @click="run(() => editor?.chain().focus().undo().run())"><Undo2 :size="17" /></button>
        <button type="button" class="tool-button" aria-label="重做" title="重做" :disabled="!editable || !editor?.can().redo()" @mousedown.prevent @click="run(() => editor?.chain().focus().redo().run())"><Redo2 :size="17" /></button>
      </div>
    </div>
    <div class="mobile-editor-tools" role="toolbar" aria-label="编辑工具" @pointerdown.prevent @mousedown.prevent @click.stop>
      <button type="button" :disabled="!editable" @click="openImagePicker"><ImagePlus :size="20" /><span>图片</span></button>
      <button type="button" :disabled="!editable" :aria-pressed="isActive('taskList')" @click="run(() => editor?.chain().focus().toggleTaskList().run())"><ListTodo :size="20" /><span>待办</span></button>
      <button type="button" :disabled="!editable" :aria-expanded="formatOpen" @click="formatOpen = !formatOpen"><Bold :size="20" /><span>{{ formatOpen ? '收起格式' : '格式' }}</span></button>
      <button type="button" :disabled="!editable || !editor?.can().undo()" aria-label="撤销" @click="run(() => editor?.chain().focus().undo().run())"><Undo2 :size="20" /></button>
      <button type="button" :disabled="!editable || !editor?.can().redo()" aria-label="重做" @click="run(() => editor?.chain().focus().redo().run())"><Redo2 :size="20" /></button>
    </div>
    <input ref="imagePicker" class="visually-hidden" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple aria-label="选择要插入的图片" @change="onImagePickerChange" @cancel="releaseImageBookmark" />
    <Teleport to="body">
      <div v-if="linkOpen" class="link-dialog-backdrop" @click.self="closeLinkDialog">
        <form class="link-dialog" role="dialog" aria-modal="true" aria-label="插入链接" @submit.prevent="applyLink">
          <div class="link-dialog-heading"><span class="link-dialog-icon"><Link :size="20" /></span><div><h2>插入链接</h2><p>为选中的文字添加网页地址</p></div></div>
          <label v-if="!linkText" class="link-dialog-field">显示文字<input v-model="linkText" type="text" placeholder="链接文字" /></label>
          <label class="link-dialog-field">链接地址<input v-model="linkHref" type="url" placeholder="https://example.com" required autofocus /></label>
          <div class="link-dialog-actions"><button v-if="linkExisting" class="link-dialog-remove" type="button" @click="removeLink">移除链接</button><button type="button" @click="closeLinkDialog">取消</button><button class="link-dialog-primary" type="submit">完成</button></div>
        </form>
      </div>
    </Teleport>
    <div ref="contentViewport" class="editor-content-shell content-zoom-viewport">
      <div class="content-zoom-extent" :style="extentStyle">
        <div ref="contentSurface" class="content-zoom-surface" :style="surfaceStyle">
          <EditorContent v-if="editor" :editor="editor" />
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.editor-surface {
  --highlight-bg: #fff0a6;
}

.editor-content-shell {
  min-width: 0;
  overflow: auto;
}

.content-zoom-surface :deep(.rich-editor-content) {
  min-height: var(--content-zoom-min-height);
}

:global(:root[data-theme='dark'] .editor-surface) {
  --highlight-bg: #51451c;
}

.editor-surface :deep(.rich-editor-content mark) {
  color: var(--ink);
  background-color: var(--highlight-bg);
  border-radius: 2px;
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
}
</style>

<style>
.link-dialog-backdrop { position: fixed; z-index: 200; inset: 0; display: grid; place-items: center; padding: 24px; background: var(--overlay); animation: veil-in .2s ease both; }
.link-dialog { width: min(100%, 400px); padding: 24px; border: 1px solid var(--line); border-radius: 24px; color: var(--ink); background: var(--paper); box-shadow: 0 24px 70px rgba(var(--shadow-rgb), .2); animation: dialog-in .25s var(--motion-out) both; }
.link-dialog-heading { display: flex; align-items: center; gap: 13px; margin-bottom: 24px; }
.link-dialog-icon { display: grid; width: 44px; height: 44px; flex: 0 0 auto; place-items: center; border-radius: 15px; background: var(--brand-soft); }
.link-dialog h2 { margin: 0; font-size: 19px; }
.link-dialog p { margin: 4px 0 0; font-size: 12px; opacity: .65; }
.link-dialog-field { display: grid; gap: 9px; margin: 14px 0; font-size: 13px; }
.link-dialog-field input { width: 100%; min-height: 48px; padding: 0 14px; border: 1px solid var(--line); border-radius: 13px; outline: none; color: var(--ink); background: var(--surface-soft); font: inherit; font-size: 15px; }
.link-dialog-field input:focus { border-color: var(--brand); box-shadow: 0 0 0 3px rgba(var(--brand-rgb), .12); }
.link-dialog-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 24px; }
.link-dialog-actions button { min-width: 78px; min-height: 42px; border: 0; border-radius: 13px; color: var(--ink); background: var(--surface-soft); }
.link-dialog-actions .link-dialog-remove { margin-right: auto; color: var(--danger); background: transparent; }
.link-dialog-actions .link-dialog-primary { background: var(--brand-soft); font-weight: 600; }
</style>
