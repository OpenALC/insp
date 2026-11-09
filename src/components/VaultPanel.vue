<script setup lang="ts">
import { computed, ref } from 'vue'
import type { VaultController } from '../security/types'
import { vaultPasswordKind } from '../security/crypto'
import { ArrowLeft, Fingerprint, LockKeyhole, X } from 'lucide-vue-next'
const props = defineProps<{ vault: VaultController; mode: 'gate' | 'privacy'; error?: string }>()
const emit = defineEmits<{ revealed: []; close: []; retry: [] }>()
const password = ref('')
const confirm = ref('')
const complex = ref(false)
const busy = ref(false)
const actionError = ref('')
const creating = computed(() => !props.vault.state.privacyConfigured)
const valid = computed(() => creating.value
  ? vaultPasswordKind(password.value) === (complex.value ? 'passphrase' : 'pin') && password.value === confirm.value
  : password.value.length > 0)
async function submit() {
  busy.value = true
  actionError.value = ''
  try {
    if (props.mode === 'gate') {
      await props.vault.unlock(password.value)
      await props.vault.rememberLocalAccess(password.value)
    } else {
      if (creating.value) await props.vault.setPrivacyPassword(password.value)
      await props.vault.revealPrivate(password.value)
      emit('revealed')
    }
    password.value = ''
    confirm.value = ''
  } catch (error) { actionError.value = error instanceof Error ? error.message : String(error) }
  finally { busy.value = false }
}
async function useSystem() {
  busy.value = true
  actionError.value = ''
  try { await props.vault.revealPrivateWithSystem(); emit('revealed') }
  catch (error) { actionError.value = error instanceof Error ? error.message : String(error) }
  finally { busy.value = false }
}
</script>

<template>
  <main v-if="mode === 'gate'" class="access-migration">
    <div class="migration-content">
      <LockKeyhole :size="32" />
      <h1>{{ vault.state.migrationRequired ? '保留你的笔记' : '正在打开笔记' }}</h1>
      <p v-if="vault.state.migrationRequired">验证一次原空间口令，将加密访问交给这台设备安全保存。之后打开普通笔记不再需要口令。</p>
      <form v-if="vault.state.migrationRequired" @submit.prevent="submit">
        <input v-model="password" type="password" autocomplete="current-password" placeholder="原空间口令" aria-label="原空间口令" required />
        <button class="action-primary" :disabled="busy || !password">{{ busy ? '正在处理…' : '验证并继续' }}</button>
      </form>
      <div v-else-if="!error" class="loading-orbit"></div>
      <p v-if="actionError || error" class="vault-error" role="alert">{{ actionError || error }}</p>
      <button v-if="error" class="action-text" @click="emit('retry')">重试</button>
    </div>
  </main>
  <div v-else class="sheet-backdrop" @click.self="emit('close')" @keydown.esc="emit('close')">
    <section class="bottom-sheet privacy-sheet" role="dialog" aria-modal="true" aria-labelledby="privacy-title">
      <div class="sheet-grabber"></div>
      <button class="sheet-close" aria-label="关闭" @click="emit('close')"><X :size="21" /></button>
      <div class="privacy-symbol"><LockKeyhole :size="29" /></div>
      <h2 id="privacy-title">隐私笔记</h2>
      <p class="sheet-description">只在进入这里时验证身份。</p>
      <button v-if="vault.state.systemAuthAvailable" class="system-auth-button" :disabled="busy" @click="useSystem"><Fingerprint :size="24" /><span>使用系统验证</span></button>
      <details :open="!vault.state.systemAuthAvailable" class="privacy-password">
        <summary>{{ creating ? '设置独立隐私密码' : '使用隐私密码' }}</summary>
        <form @submit.prevent="submit">
          <div v-if="creating" class="credential-options"><button type="button" :class="{ active: !complex }" @click="complex = false; password = ''; confirm = ''">6 位数字</button><button type="button" :class="{ active: complex }" @click="complex = true; password = ''; confirm = ''">复杂口令</button></div>
          <input v-model="password" type="password" :inputmode="creating && !complex ? 'numeric' : 'text'" :autocomplete="creating ? 'new-password' : 'current-password'" :placeholder="creating ? (complex ? '至少 12 个字符' : '设置 6 位数字') : '输入隐私密码'" aria-label="隐私密码" required />
          <input v-if="creating" v-model="confirm" type="password" :inputmode="complex ? 'text' : 'numeric'" autocomplete="new-password" placeholder="再次输入" aria-label="再次输入隐私密码" required />
          <p v-if="creating" class="settings-hint">隐私密码仅用于隐私区。忘记后无法通过服务端找回。</p>
          <button class="action-primary" :disabled="busy || !valid">{{ busy ? '正在验证…' : creating ? '设置并进入' : '验证并进入' }}</button>
        </form>
      </details>
      <p v-if="actionError" class="vault-error" role="alert">{{ actionError }}</p>
    </section>
  </div>
</template>
