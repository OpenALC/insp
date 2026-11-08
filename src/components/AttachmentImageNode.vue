<script setup lang="ts">
import { ref, watch } from 'vue'
import { NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import { platform } from '../platform'

const props = defineProps(nodeViewProps)
const source = ref('')
const failure = ref('')
const imageFailed = ref(false)
let requestId = 0

watch(
  () => props.node.attrs.attachmentId as string | null,
  async (attachmentId) => {
    const currentRequest = ++requestId
    source.value = ''
    failure.value = ''
    imageFailed.value = false
    if (!attachmentId) {
      failure.value = '图片附件标识缺失'
      return
    }
    try {
      const resolved = await platform.attachments.resolveImage(attachmentId)
      if (currentRequest === requestId) source.value = resolved
    } catch (error) {
      if (currentRequest !== requestId) return
      failure.value = error instanceof Error ? error.message : String(error)
    }
  },
  { immediate: true },
)

function onImageError() {
  imageFailed.value = true
  failure.value = '图片文件无法显示'
}
</script>

<template>
  <NodeViewWrapper as="figure" class="attachment-image" contenteditable="false">
    <img v-if="source && !imageFailed" :src="source" :alt="String(node.attrs.alt || '')" draggable="false" @error="onImageError" />
    <span v-else-if="failure" class="attachment-image-error" role="img" :aria-label="`图片加载失败：${failure}`">
      <span class="attachment-image-error-mark" aria-hidden="true">!</span>
      <span>图片加载失败：{{ failure }}</span>
    </span>
    <span v-else class="attachment-image-loading" role="status">
      <span class="attachment-image-loading-mark" aria-hidden="true"></span>
      <span>正在读取图片…</span>
    </span>
  </NodeViewWrapper>
</template>
