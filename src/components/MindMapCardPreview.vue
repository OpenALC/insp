<script setup lang="ts">
import type { MindMapPreview } from '../domain/mindmap'
defineProps<{ preview: MindMapPreview }>()
</script>

<template>
  <span class="map-card-preview" role="img" :aria-label="'思维笔记：' + preview.root + '；' + preview.branches.join('；')">
    <span class="map-preview-root">{{ preview.root || '中心主题' }}</span>
    <span v-if="preview.branches.length" class="map-preview-branches">
      <span v-for="(branch, index) in preview.branches" :key="index" class="map-preview-branch">{{ branch || '新主题' }}</span>
      <span v-if="preview.remaining" class="map-preview-more">另有 {{ preview.remaining }} 个分支</span>
    </span>
    <span v-else class="map-preview-more">添加分支，展开想法</span>
  </span>
</template>
