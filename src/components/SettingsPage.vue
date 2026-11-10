<script setup lang="ts">
import { computed, ref } from 'vue'
import appInfo from '../../package.json'
import type { VaultController } from '../security/types'
import ThemeSelect from './ThemeSelect.vue'
import { ArrowLeft, ChevronRight, Cloud, Copy, Download, Fingerprint, Github, Info, LockKeyhole, ShieldCheck } from 'lucide-vue-next'
const props = defineProps<{ vault: VaultController; layout: string; importStatus?: string }>()
const emit = defineEmits<{ close: []; privacy: []; sync: []; joined: []; layout: [value: string]; import: [files: File[]] }>()
const view = ref<'main' | 'sync' | 'privacy' | 'devices' | 'about' | 'import'>('main')
const pageTitle = computed(() => ({ main: '设置', sync: '跨端同步', privacy: '隐私设置', devices: '连接已有空间', about: '关于拾页', import: '导入笔记' })[view.value])
function back() { if (view.value === 'main') emit('close'); else view.value = 'main' }
const endpoint = ref(props.vault.state.endpoint)
const connection = ref('')
const legacyPassword = ref('')
const privatePassword = ref('')
const confirmPassword = ref('')
const error = ref('')
const busy = ref(false)
const copied = ref(false)
const importPicker = ref<HTMLInputElement>()
const releaseVersion = ref('')
const updateStatus = ref('')
const checkingUpdate = ref(false)
async function checkUpdate() {
  checkingUpdate.value = true
  updateStatus.value = ''
  try {
    const response = await fetch('https://api.github.com/repos/OpenALC/insp/releases/latest', { headers: { Accept: 'application/vnd.github+json' } })
    if (response.status === 404) { updateStatus.value = '尚未发布正式版本'; return }
    if (!response.ok) throw new Error(`检查失败（HTTP ${response.status}）`)
    const release = await response.json() as { tag_name: string }
    releaseVersion.value = release.tag_name
    updateStatus.value = release.tag_name.replace(/^v/, '') === appInfo.version ? '已是最新版本' : '发现新版本，可前往 GitHub 下载'
  } catch (error) { updateStatus.value = error instanceof Error ? error.message : '暂时无法检查更新' }
  finally { checkingUpdate.value = false }
}
function pickImport(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  if (files.length) emit('import', files)
  input.value = ''
}
async function action(work: () => Promise<void>) {
  busy.value = true
  error.value = ''
  try { await work() } catch (e) { error.value = e instanceof Error ? e.message : String(e) }
  finally { busy.value = false }
}
function saveEndpoint() { void action(() => props.vault.configureSync(endpoint.value.trim())) }
function join() { void action(async () => { await props.vault.joinWorkspace(connection.value.trim(), legacyPassword.value || undefined); connection.value = ''; legacyPassword.value = ''; emit('joined') }) }
function changePrivatePassword() { void action(async () => { if (privatePassword.value !== confirmPassword.value) throw new Error('两次输入的密码不一致。'); await props.vault.setPrivacyPassword(privatePassword.value); privatePassword.value = ''; confirmPassword.value = '' }) }
async function copy() {
  await action(async () => { await navigator.clipboard.writeText(props.vault.state.connectionCode); copied.value = true })
}
</script>

<template>
  <section class="settings-page" aria-label="设置">
    <header class="settings-header"><button class="icon-button" aria-label="返回" @click="back"><ArrowLeft :size="25" /></button><h1>{{ pageTitle }}</h1></header>
    <div :key="view" class="settings-scroll settings-content-in">
      <template v-if="view === 'main'">
        <h2>外观</h2>
        <div class="settings-section"><ThemeSelect /><label class="settings-row"><span>笔记布局</span><select aria-label="笔记布局" :value="layout" @change="emit('layout', ($event.target as HTMLSelectElement).value)"><option value="grid">宫格</option><option value="list">列表</option></select></label></div>
        <h2>安全与隐私</h2>
        <div class="settings-section">
          <div class="settings-row"><ShieldCheck :size="20" /><span>普通笔记</span><span class="settings-value">直接打开 · 本地加密</span></div>
          <button class="settings-row" @click="view = 'privacy'"><LockKeyhole :size="20" /><span>隐私笔记</span><span class="settings-value">{{ vault.state.systemAuthAvailable ? '支持系统验证' : '独立密码' }}</span><ChevronRight :size="17" /></button>
        </div>
        <h2>同步与设备</h2>
        <div class="settings-section">
          <button class="settings-row" @click="view = 'sync'"><Cloud :size="20" /><span>跨端同步</span><span class="settings-value">{{ vault.state.syncing ? '正在同步' : vault.state.endpoint ? '已配置' : '未配置' }}</span><ChevronRight :size="17" /></button>
          <button class="settings-row" @click="view = 'devices'"><Copy :size="20" /><span>连接已有空间</span><ChevronRight :size="17" /></button>
        </div>
        <h2>数据</h2>
        <div class="settings-section"><button class="settings-row" @click="view = 'import'"><Download :size="20" /><span>导入笔记</span><ChevronRight :size="17" /></button></div>
        <h2>其他</h2>
        <div class="settings-section"><button class="settings-row" @click="view = 'about'"><Info :size="20" /><span>关于拾页</span><ChevronRight :size="17" /></button></div>
        <div class="settings-about"><strong>拾页</strong><span>给想法，留一页空白。</span><small>OpenALC · MIT</small></div>
      </template>
      <template v-else-if="view === 'about'">
        <div class="settings-about settings-about-detail"><strong>拾页 · Inspiration</strong><span>给想法，留一页空白。</span><small>by OpenALC</small></div>
        <h2>应用信息</h2>
        <div class="settings-section">
          <div class="settings-row"><span>当前版本</span><span class="settings-value">v{{ appInfo.version }}</span></div>
          <button class="settings-row" :disabled="checkingUpdate" @click="checkUpdate"><Download :size="20" /><span>{{ checkingUpdate ? '正在检查…' : '获取更新' }}</span><span v-if="releaseVersion" class="settings-value">{{ releaseVersion }}</span><ChevronRight :size="17" /></button>
          <a class="settings-row" href="https://github.com/OpenALC/insp" target="_blank" rel="noopener noreferrer"><Github :size="20" /><span>GitHub 仓库</span><span class="settings-value">github.com/OpenALC/insp</span><ChevronRight :size="17" /></a>
          <a class="settings-row" href="https://github.com/OpenALC/insp/blob/main/LICENSE" target="_blank" rel="noopener noreferrer"><ShieldCheck :size="20" /><span>开源协议</span><span class="settings-value">MIT</span><ChevronRight :size="17" /></a>
        </div>
        <p v-if="updateStatus" class="settings-page-description" role="status">{{ updateStatus }}</p>
        <p class="settings-page-description">拾页基于 Vue、Tiptap、Tauri 等开源项目构建，完整源码、许可证及更新记录请见 GitHub 仓库。</p>
      </template>
      <template v-else-if="view === 'import'">
        <p class="settings-page-description">选择 Markdown、纯文本、小米笔记“导出为副本”的 ZIP，或图片。笔记和图片会加入本机加密空间。</p>
        <div class="settings-section"><button class="settings-row" @click="importPicker?.click()"><Download :size="20" /><span>选择文件</span><span class="settings-value">可多选</span><ChevronRight :size="17" /></button></div>
        <input ref="importPicker" class="visually-hidden" type="file" accept=".md,.markdown,.txt,.zip,image/png,image/jpeg,image/gif,image/webp,text/plain,text/markdown,application/zip" multiple aria-label="选择要导入的笔记" @change="pickImport" />
        <p v-if="importStatus" class="settings-page-description" role="status">{{ importStatus }}</p>
        <p class="settings-page-description">小米灵感笔记若仅能导出为图片，可作为图片保留，无法恢复可编辑的节点层级。</p>
      </template>
      <template v-else-if="view === 'privacy'">
        <p class="settings-page-description">普通笔记直接打开。只有进入隐私笔记时，才会要求你验证身份。</p>
        <div class="settings-section">
          <button class="settings-row" @click="emit('privacy')"><Fingerprint :size="22" /><span>验证隐私身份</span><ChevronRight :size="17" /></button>
          <p class="settings-hint">{{ vault.state.systemAuthAvailable ? '可使用系统锁屏密码或生物识别，也可设置独立隐私密码。' : '这台设备暂未提供系统验证，可使用独立的 6 位数字或复杂口令。' }}</p>
          <form v-if="!vault.state.privacyConfigured || vault.state.privateVisible" class="settings-inline-form" @submit.prevent="changePrivatePassword">
            <label>独立隐私密码<input v-model="privatePassword" type="password" autocomplete="new-password" placeholder="6 位数字，或至少 12 个字符" required /></label>
            <input v-model="confirmPassword" type="password" autocomplete="new-password" placeholder="再次输入" aria-label="再次输入隐私密码" required />
            <button class="action-secondary" :disabled="busy || !privatePassword">保存隐私密码</button>
          </form>
          <button v-else class="settings-text-action" @click="emit('privacy')">验证身份后修改隐私密码<ChevronRight :size="16" /></button>
        </div>
        <p class="settings-page-description">退出隐私区或切到后台后，隐私内容会隐藏。隐私笔记默认仅本机保存，可逐篇选择是否同步。</p>
      </template>
      <template v-else-if="view === 'sync'">
        <p class="settings-page-description">将加密笔记同步到自己的服务。口令与解密密钥不会发送给服务器。</p>
        <div class="settings-section">
          <form class="settings-inline-form settings-form-spaced" @submit.prevent="saveEndpoint"><label>同步服务地址<input v-model="endpoint" type="url" autocomplete="url" placeholder="https://sync.example.com" required /></label><button class="action-secondary" :disabled="busy || !endpoint.trim()">保存</button></form>
          <button class="settings-row" :disabled="!vault.state.endpoint || busy || vault.state.syncing" @click="emit('sync')"><span>立即同步</span><span class="settings-value">{{ vault.state.lastSync || '尚未同步' }}</span><ChevronRight :size="17" /></button>
          <button v-if="vault.state.connectionCode" class="settings-row" @click="copy"><Copy :size="19" /><span>{{ copied ? '连接码已复制' : '复制设备连接码' }}</span><ChevronRight :size="17" /></button>
          <p v-if="vault.state.connectionCode" class="settings-hint">连接码可让新设备读取此空间，请仅在受信任的设备之间传递。</p>
        </div>
        <p v-if="vault.state.syncError" class="vault-error">{{ vault.state.syncError }}</p>
      </template>
      <template v-else-if="view === 'devices'">
        <p class="settings-page-description">粘贴另一台设备的连接码，即可加入同一个空间。当前空间必须完全空白，已有笔记不会被覆盖。</p>
        <form class="settings-section settings-inline-form settings-form-spaced" @submit.prevent="join"><textarea v-model="connection" placeholder="设备连接码" aria-label="设备连接码" required></textarea><input v-model="legacyPassword" type="password" autocomplete="current-password" placeholder="旧连接码需输入原空间口令" aria-label="旧空间口令" /><button class="action-secondary" :disabled="busy || !connection.trim()">连接</button></form>
      </template>
      <p v-if="error" class="vault-error settings-error" role="alert">{{ error }}</p>
    </div>
  </section>
</template>
