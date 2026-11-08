<script setup lang="ts">
import { ref, watch } from 'vue'
import type { JSONContent } from '@tiptap/core'
import { EditorContent, useEditor } from '@tiptap/vue-3'
import { TextSelection, type SelectionBookmark } from '@tiptap/pm/state'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import {
  Bold,
  Heading1,
  Heading2,
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

const props = defineProps<{
  content: JSONContent
  editable: boolean
}>()

const emit = defineEmits<{
  'update:document': [content: JSONContent, plainText: string]
  'io-error': [error: unknown]
}>()

const imagePicker = ref<HTMLInputElement | null>(null)
const transactionTick = ref(0)
const pendingImports = new Set<Promise<void>>()

const editor = useEditor({
  content: props.content,
  editable: props.editable,
  extensions: [
    StarterKit.configure({ link: { openOnClick: false } }),
    Placeholder.configure({ placeholder: '从这里开始记录……' }),
    TaskList,
    TaskItem.configure({ nested: true }),
    AttachmentImage,
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
    emit('update:document', currentEditor.getJSON(), currentEditor.getText({ blockSeparator: '\n' }))
  },
  onTransaction() {
    transactionTick.value += 1
  },
})

watch(
  () => props.editable,
  (editable) => editor.value?.setEditable(editable, false),
)

function openImagePicker() {
  if (!editor.value || !props.editable) return
  editor.value.commands.focus()
  imagePicker.value?.click()
}

async function importImages(files: File[], bookmark?: SelectionBookmark) {
  if (!editor.value || !props.editable) return
  try {
    const imported: Array<{ attachmentId: string; alt: string }> = []
    for (const file of files) {
      const attachment = await platform.attachments.importImage(file)
      imported.push({ attachmentId: attachment.id, alt: file.name })
    }
    const currentEditor = editor.value
    if (!currentEditor || currentEditor.isDestroyed) return
    if (bookmark) {
      const transaction = currentEditor.state.tr.setSelection(bookmark.resolve(currentEditor.state.doc))
      currentEditor.view.dispatch(transaction)
    }
    for (const image of imported) {
      currentEditor
        .chain()
        .focus()
        .insertContent({ type: 'image', attrs: image })
        .run()
    }
  } catch (error) {
    emit('io-error', error)
  }
}

function startImport(files: File[], bookmark?: SelectionBookmark) {
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
  if (files.length > 0) startImport(files)
}

function run(command: () => void) {
  if (editor.value && props.editable) command()
}

function setLink() {
  const currentHref = editor.value?.getAttributes('link').href as string | undefined
  const href = window.prompt('输入链接地址', currentHref ?? 'https://')
  if (href === null || !editor.value) return
  if (href.trim() === '') {
    editor.value.chain().focus().unsetLink().run()
    return
  }
  editor.value.chain().focus().setLink({ href: href.trim() }).run()
}

function isActive(name: string, attributes?: Record<string, unknown>) {
  void transactionTick.value
  return editor.value?.isActive(name, attributes) ?? false
}

defineExpose({ awaitPendingImports })
</script>

<template>
  <section class="editor-surface" :class="{ 'editor-surface-disabled': !editable }" aria-label="富文本编辑器">
    <div class="format-toolbar" role="toolbar" aria-label="文字格式">
      <div class="toolbar-group">
        <button type="button" class="tool-button" :class="{ active: isActive('bold') }" aria-label="加粗" title="加粗" :disabled="!editable" @mousedown.prevent @click="run(() => editor?.chain().focus().toggleBold().run())"><Bold :size="17" /></button>
        <button type="button" class="tool-button" :class="{ active: isActive('italic') }" aria-label="斜体" title="斜体" :disabled="!editable" @mousedown.prevent @click="run(() => editor?.chain().focus().toggleItalic().run())"><Italic :size="17" /></button>
        <button type="button" class="tool-button" :class="{ active: isActive('underline') }" aria-label="下划线" title="下划线" :disabled="!editable" @mousedown.prevent @click="run(() => editor?.chain().focus().toggleUnderline().run())"><Underline :size="17" /></button>
        <button type="button" class="tool-button" :class="{ active: isActive('strike') }" aria-label="删除线" title="删除线" :disabled="!editable" @mousedown.prevent @click="run(() => editor?.chain().focus().toggleStrike().run())"><Strikethrough :size="17" /></button>
      </div>
      <span class="toolbar-divider" aria-hidden="true"></span>
      <div class="toolbar-group">
        <button type="button" class="tool-button" :class="{ active: isActive('heading', { level: 1 }) }" aria-label="一级标题" title="一级标题" :disabled="!editable" @mousedown.prevent @click="run(() => editor?.chain().focus().toggleHeading({ level: 1 }).run())"><Heading1 :size="18" /></button>
        <button type="button" class="tool-button" :class="{ active: isActive('heading', { level: 2 }) }" aria-label="二级标题" title="二级标题" :disabled="!editable" @mousedown.prevent @click="run(() => editor?.chain().focus().toggleHeading({ level: 2 }).run())"><Heading2 :size="18" /></button>
        <button type="button" class="tool-button" :class="{ active: isActive('bulletList') }" aria-label="无序列表" title="无序列表" :disabled="!editable" @mousedown.prevent @click="run(() => editor?.chain().focus().toggleBulletList().run())"><List :size="18" /></button>
        <button type="button" class="tool-button" :class="{ active: isActive('orderedList') }" aria-label="有序列表" title="有序列表" :disabled="!editable" @mousedown.prevent @click="run(() => editor?.chain().focus().toggleOrderedList().run())"><ListOrdered :size="18" /></button>
        <button type="button" class="tool-button" :class="{ active: isActive('taskList') }" aria-label="待办列表" title="待办列表" :disabled="!editable" @mousedown.prevent @click="run(() => editor?.chain().focus().toggleTaskList().run())"><ListTodo :size="18" /></button>
        <button type="button" class="tool-button" :class="{ active: isActive('blockquote') }" aria-label="引用" title="引用" :disabled="!editable" @mousedown.prevent @click="run(() => editor?.chain().focus().toggleBlockquote().run())"><Quote :size="17" /></button>
      </div>
      <span class="toolbar-divider" aria-hidden="true"></span>
      <div class="toolbar-group">
        <button type="button" class="tool-button" :class="{ active: isActive('link') }" aria-label="插入链接" title="插入链接" :disabled="!editable" @mousedown.prevent @click="setLink"><Link :size="17" /></button>
        <button type="button" class="tool-button" aria-label="插入图片" title="插入图片" :disabled="!editable" @mousedown.prevent @click="openImagePicker"><ImagePlus :size="18" /></button>
      </div>
      <span class="toolbar-spacer"></span>
      <div class="toolbar-group history-tools">
        <button type="button" class="tool-button" aria-label="撤销" title="撤销" :disabled="!editable || !editor?.can().undo()" @mousedown.prevent @click="run(() => editor?.chain().focus().undo().run())"><Undo2 :size="17" /></button>
        <button type="button" class="tool-button" aria-label="重做" title="重做" :disabled="!editable || !editor?.can().redo()" @mousedown.prevent @click="run(() => editor?.chain().focus().redo().run())"><Redo2 :size="17" /></button>
      </div>
    </div>
    <input ref="imagePicker" class="visually-hidden" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple aria-label="选择要插入的图片" @change="onImagePickerChange" />
    <EditorContent v-if="editor" :editor="editor" class="editor-content-shell" />
  </section>
</template>
