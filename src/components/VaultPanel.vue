<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { vaultPasswordKind } from '../security/crypto'
import type { VaultController } from '../security/types'
import ThemeSelect from './ThemeSelect.vue'
import inspLogo from '../assets/insp-logo.png'
import { Cloud, Copy, KeyRound, LockKeyhole, ShieldCheck, X } from 'lucide-vue-next'

const props = defineProps<{
  vault: VaultController
  mode: 'gate' | 'privacy' | 'sync'
  error?: string
}>()

const emit = defineEmits<{
  opened: []
  revealed: []
  close: []
  retry: []
  sync: []
}>()

const password = ref('')
const connectionCode = ref('')
const setupMode = ref<'create' | 'connect'>('create')
const passwordMode = ref<'pin' | 'passphrase'>('pin')
const endpoint = ref(props.vault.state.endpoint)
const actionError = ref('')
const busy = ref(false)
const copied = ref(false)
const isSetup = computed(() => !props.vault.state.initialized)
const isCreating = computed(() => isSetup.value && setupMode.value === 'create')
const isCreatingPin = computed(() => isCreating.value && passwordMode.value === 'pin')
const canSubmitPassword = computed(() => isCreating.value
  ? vaultPasswordKind(password.value) === passwordMode.value
  : password.value.length > 0)

watch([setupMode, passwordMode], () => {
  password.value = ''
  actionError.value = ''
})

watch(() => props.mode, () => {
  password.value = ''
  connectionCode.value = ''
  actionError.value = ''
  copied.value = false
  endpoint.value = props.vault.state.endpoint
})

watch(() => props.vault.state.endpoint, (value) => {
  endpoint.value = value
})

function messageOf(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return String(error)
}

async function submitGate() {
  if (!props.vault.state.ready) {
    emit('retry')
    return
  }
  if (!canSubmitPassword.value) return
  if (isSetup.value && setupMode.value === 'connect' && !connectionCode.value.trim()) {
    actionError.value = '请输入已有空间的连接码。'
    return
  }

  busy.value = true
  actionError.value = ''
  try {
    if (isSetup.value) {
      const code = setupMode.value === 'connect' ? connectionCode.value.trim() : undefined
      await props.vault.setup(password.value, code)
    } else {
      await props.vault.unlock(password.value)
    }
    password.value = ''
    connectionCode.value = ''
    emit('opened')
  } catch (error) {
    actionError.value = messageOf(error)
  } finally {
    busy.value = false
  }
}

async function revealPrivate() {
  busy.value = true
  actionError.value = ''
  try {
    await props.vault.revealPrivate(password.value)
    password.value = ''
    emit('revealed')
  } catch (error) {
    actionError.value = messageOf(error)
  } finally {
    busy.value = false
  }
}

async function configureSync() {
  busy.value = true
  actionError.value = ''
  copied.value = false
  try {
    await props.vault.configureSync(endpoint.value.trim())
  } catch (error) {
    actionError.value = messageOf(error)
  } finally {
    busy.value = false
  }
}

async function copyConnectionCode() {
  const code = props.vault.state.connectionCode
  await navigator.clipboard.writeText(code)
  copied.value = true
}

function selectConnectionCode(event: FocusEvent) {
  (event.target as HTMLInputElement).select()
}
</script>

<template>
  <main v-if="mode === 'gate'" class="vault-gate">
    <section class="vault-gate-card" aria-labelledby="vault-gate-title">
      <ThemeSelect class="vault-theme-switch" />
      <div class="vault-brand-mark"><img :src="inspLogo" alt="拾页 Logo" width="54" height="54" /></div>
      <div class="vault-eyebrow">INSP · 安全笔记空间</div>
      <h1 id="vault-gate-title">
        {{ !vault.state.ready ? '正在准备安全空间' : isSetup ? '创建或连接空间' : '解锁你的空间' }}
      </h1>
      <p class="vault-intro">
        {{ !vault.state.ready
          ? '正在检查本机加密空间。'
          : isSetup
            ? '空间口令用于保护这台设备上的笔记，请妥善保存。'
            : '输入空间口令后继续访问本机笔记。' }}
      </p>

      <form v-if="vault.state.ready" class="vault-form" @submit.prevent="submitGate">
        <template v-if="isSetup">
          <div class="vault-mode-tabs" aria-label="空间设置方式">
            <button type="button" :class="{ selected: setupMode === 'create' }" @click="setupMode = 'create'; actionError = ''">创建新空间</button>
            <button type="button" :class="{ selected: setupMode === 'connect' }" @click="setupMode = 'connect'; actionError = ''">连接已有空间</button>
          </div>
          <label v-if="setupMode === 'connect'" class="vault-field">
            <span>空间连接码</span>
            <input v-model="connectionCode" type="text" autocomplete="off" required placeholder="粘贴另一台设备生成的连接码" />
          </label>
          <p v-if="setupMode === 'connect'" class="vault-help">仅可在新设备首次设置时连接。已有空间不会被覆盖。</p>
        </template>

        <div v-if="isCreating" class="vault-mode-tabs" role="group" aria-label="新空间口令类型">
          <button type="button" :class="{ selected: passwordMode === 'pin' }" :aria-pressed="passwordMode === 'pin'" @click="passwordMode = 'pin'">6 位数字</button>
          <button type="button" :class="{ selected: passwordMode === 'passphrase' }" :aria-pressed="passwordMode === 'passphrase'" @click="passwordMode = 'passphrase'">复杂口令</button>
        </div>
        <label class="vault-field">
          <span>空间口令</span>
          <input
            v-model="password"
            type="password"
            :autocomplete="isCreating ? 'new-password' : 'current-password'"
            :inputmode="isCreatingPin ? 'numeric' : 'text'"
            :pattern="isCreatingPin ? '[0-9]{6}' : undefined"
            autocapitalize="none"
            :spellcheck="false"
            required
            :placeholder="isCreatingPin ? '设置 6 位数字，可用 0 开头' : isCreating ? '至少 12 个字符，可含文字、数字和符号' : '输入已有空间的口令'"
          />
        </label>
        <p v-if="isCreating" class="vault-help">请保存好口令，忘记后无法恢复笔记。需要更强保护时，建议使用复杂口令。</p>
        <p v-if="error || actionError" class="vault-error" role="alert">{{ actionError || error }}</p>
        <button class="vault-primary-button" type="submit" :disabled="busy || vault.state.busy || !canSubmitPassword">
          <span v-if="busy || vault.state.busy" class="vault-spinner"></span>
          {{ busy || vault.state.busy ? '正在处理…' : isSetup ? (setupMode === 'connect' ? '连接并解锁' : '创建并解锁') : '解锁空间' }}
        </button>
      </form>

      <div v-else class="vault-form">
        <p v-if="error || actionError" class="vault-error" role="alert">{{ actionError || error }}</p>
        <button class="vault-primary-button" type="button" :disabled="vault.state.busy" @click="emit('retry')">
          {{ vault.state.busy ? '正在初始化…' : '重试' }}
        </button>
      </div>
      <div class="vault-local-note"><LockKeyhole :size="14" />口令只用于本机解锁和空间加密</div>
    </section>
  </main>

  <div v-else class="vault-modal-backdrop" @click.self="emit('close')" @keydown.esc.stop="emit('close')">
    <section v-if="mode === 'privacy'" class="vault-dialog" role="dialog" aria-modal="true" aria-labelledby="private-dialog-title">
      <button class="vault-close" type="button" aria-label="关闭" @click="emit('close')"><X :size="18" /></button>
      <div class="vault-dialog-icon"><KeyRound :size="20" /></div>
      <div class="vault-eyebrow">PRIVATE NOTES</div>
      <h2 id="private-dialog-title">验证口令以查看隐私笔记</h2>
      <p class="vault-intro">每次进入隐私区都需要重新验证空间口令。</p>
      <form class="vault-form" @submit.prevent="revealPrivate">
        <label class="vault-field">
          <span>空间口令</span>
          <input v-model="password" type="password" autocomplete="current-password" required placeholder="输入空间口令" />
        </label>
        <p v-if="actionError" class="vault-error" role="alert">{{ actionError }}</p>
        <button class="vault-primary-button" type="submit" :disabled="busy || vault.state.busy || !password">
          {{ busy || vault.state.busy ? '正在验证…' : '验证并进入' }}
        </button>
      </form>
    </section>

    <section v-else class="vault-dialog vault-sync-dialog" role="dialog" aria-modal="true" aria-labelledby="sync-dialog-title">
      <button class="vault-close" type="button" aria-label="关闭" @click="emit('close')"><X :size="18" /></button>
      <div class="vault-dialog-icon"><Cloud :size="20" /></div>
      <div class="vault-eyebrow">SPACE SYNC</div>
      <h2 id="sync-dialog-title">同步设置</h2>
      <p class="vault-intro">为当前空间配置远程同步端点。连接码可用于在新设备首次连接此空间。</p>
      <form class="vault-form" @submit.prevent="configureSync">
        <label class="vault-field">
          <span>同步端点</span>
          <input v-model="endpoint" type="url" autocomplete="url" required placeholder="https://sync.example.com" />
        </label>
        <p v-if="actionError" class="vault-error" role="alert">{{ actionError }}</p>
        <button class="vault-primary-button" type="submit" :disabled="busy || vault.state.busy || !endpoint.trim()">
          {{ busy || vault.state.busy ? '正在配置…' : '配置同步' }}
        </button>
      </form>

      <div v-if="vault.state.connectionCode" class="vault-connection-code">
        <label class="vault-field">
          <span>空间连接码</span>
          <input :value="vault.state.connectionCode" type="text" readonly @focus="selectConnectionCode" />
        </label>
        <button class="vault-secondary-button" type="button" @click="copyConnectionCode"><Copy :size="15" />{{ copied ? '已复制' : '复制连接码' }}</button>
        <p class="vault-help">连接码用于将新设备加入当前空间，请仅分享给你信任的设备。</p>
      </div>

      <div class="vault-sync-status" aria-live="polite">
        <span>上次同步：{{ vault.state.lastSync || '尚未同步' }}</span>
        <span v-if="vault.state.syncError" class="vault-error">{{ vault.state.syncError }}</span>
      </div>
      <div class="vault-dialog-actions">
        <button class="vault-secondary-button" type="button" :disabled="!vault.state.endpoint || vault.state.syncing || busy" @click="emit('sync')">
          <Cloud :size="15" />{{ vault.state.syncing ? '正在同步…' : '立即同步' }}
        </button>
        <button class="vault-text-button" type="button" @click="emit('close')">完成</button>
      </div>
    </section>
  </div>
</template>
