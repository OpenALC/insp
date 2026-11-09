<script setup lang="ts">
import type { MindMapPreview } from '../domain/mindmap'

defineProps<{ preview: MindMapPreview }>()
</script>

<template>
  <span class="mindmap-card-summary" role="img" :aria-label="'思维笔记：' + (preview.root || '中心主题') + '；' + preview.branches.join('；') + (preview.remaining ? `；另有 ${preview.remaining} 个分支` : '')">
    <span class="mindmap-card-root">{{ preview.root || '中心主题' }}</span>
    <span v-if="preview.branches.length" class="mindmap-card-branches">
      <span v-for="(branch, index) in preview.branches" :key="index" class="mindmap-card-branch">{{ branch || '新主题' }}</span>
    </span>
    <span v-if="preview.remaining" class="mindmap-card-more">+{{ preview.remaining }} 个分支</span>
    <span v-else-if="!preview.branches.length" class="mindmap-card-more">添加分支，展开想法</span>
  </span>
</template>

<style scoped>
.mindmap-card-summary { display: flex; min-width: 0; flex-direction: column; gap: 9px; padding: 6px 0; color: var(--ink); text-align: left; }
.mindmap-card-root { display: -webkit-box; overflow: hidden; padding-left: 9px; border-left: 3px solid var(--brand); font-size: 14px; font-weight: 650; line-height: 1.5; overflow-wrap: anywhere; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.mindmap-card-branches { display: flex; min-width: 0; flex-direction: column; gap: 6px; margin-left: 10px; }
.mindmap-card-branch { position: relative; display: -webkit-box; overflow: hidden; padding-left: 14px; font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.mindmap-card-branch::before { position: absolute; top: 0; left: 0; width: 9px; height: .85em; border-bottom: 1px solid var(--brand-line); border-left: 1px solid var(--brand-line); border-bottom-left-radius: 5px; content: ''; }
.mindmap-card-more { padding-left: 10px; font-size: 12px; line-height: 1.5; }
@media (max-width: 760px) {
  .mindmap-card-summary { padding: 2px 0 4px; }
  .mindmap-card-root { font-size: 14px; }
}
</style>
