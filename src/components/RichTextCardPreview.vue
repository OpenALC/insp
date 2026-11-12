<script lang="ts">
import { defineComponent, h, onBeforeUnmount, onMounted, reactive, ref, type PropType, type VNodeChild } from 'vue'
import type { JSONContent } from '@tiptap/core'
import { platform } from '../platform'

function renderNode(node: JSONContent, images: Record<string, string>): VNodeChild {
  if (node.type === 'text') {
    let text: VNodeChild = node.text ?? ''
    for (const mark of node.marks ?? []) {
      const tag = { bold: 'strong', italic: 'em', underline: 'u', strike: 's', highlight: 'mark', code: 'code', link: 'span' }[mark.type] ?? 'span'
      text = h(tag, mark.type === 'link' ? { class: 'card-link' } : {}, [text])
    }
    return text
  }
  if (node.type === 'hardBreak') return h('br')
  if (node.type === 'horizontalRule') return h('hr')
  if (node.type === 'image') {
    const id = String(node.attrs?.attachmentId ?? '')
    const alt = String(node.attrs?.alt ?? '')
    return images[id] ? h('img', { src: images[id], alt, loading: 'lazy', 'data-attachment-id': id }) : h('span', { class: 'card-image-placeholder' }, alt || '图片')
  }
  const children = (node.content ?? []).map(child => renderNode(child, images))
  const layout = { textAlign: node.attrs?.textAlign, marginLeft: node.attrs?.indent ? `${Number(node.attrs.indent) * 1.75}em` : undefined }
  switch (node.type) {
    case 'heading': return h(`h${Math.min(3, Number(node.attrs?.level) || 1)}`, { style: layout }, children)
    case 'paragraph': return h('p', { style: layout }, children)
    case 'bulletList': return h('ul', children)
    case 'orderedList': return h('ol', children)
    case 'taskList': return h('ul', { class: 'card-task-list' }, children)
    case 'listItem': return h('li', children)
    case 'taskItem': return h('li', { class: 'card-task-item', 'data-checked': node.attrs?.checked ? 'true' : 'false' }, [h('span', { class: 'card-task-box' }, node.attrs?.checked ? '✓' : ''), ...children])
    case 'blockquote': return h('blockquote', children)
    case 'codeBlock': return h('pre', children)
    default: return h('div', children)
  }
}

export default defineComponent({
  name: 'RichTextCardPreview',
  props: {
    content: { type: Object as PropType<JSONContent>, required: true },
    fallback: { type: String, required: true },
  },
  setup(props) {
    const root = ref<HTMLElement>()
    const images = reactive<Record<string, string>>({})
    let observer: IntersectionObserver | undefined
    onMounted(() => {
      const ids: string[] = []
      const visit = (node: JSONContent) => {
        if (node.type === 'image' && node.attrs?.attachmentId) ids.push(String(node.attrs.attachmentId))
        for (const child of node.content ?? []) visit(child)
      }
      visit(props.content)
      if (!ids.length) return
      observer = new IntersectionObserver(entries => {
        if (!entries[0].isIntersecting) return
        observer?.disconnect()
        for (const id of ids) void platform.attachments.resolveImage(id).then(url => { images[id] = url }).catch(() => {})
      }, { root: root.value!.closest('.note-list-pane'), rootMargin: '160px' })
      observer.observe(root.value!)
    })
    onBeforeUnmount(() => observer?.disconnect())
    return () => h('div', { ref: root, class: 'rich-card-preview' },
      props.content.content?.some(node => node.type !== 'paragraph' || node.content?.length)
        ? props.content.content.map(node => renderNode(node, images))
        : props.fallback)
  },
})
</script>
