<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  id: string
  text: string
  editable: boolean
  label: string
}>()

const emit = defineEmits<{
  edit: [id: string, text: string]
  select: [id: string]
  command: [id: string, command: 'enter' | 'indent' | 'outdent']
}>()

const value = computed({
  get: () => props.text,
  set: (text: string) => {
    if (props.editable) emit('edit', props.id, text)
  },
})

let composing = false
let enterKey: 'command' | 'newline' | 'composition' | null = null
let pendingBreak: {
  text: string
  start: number
  end: number
  direction: 'forward' | 'backward' | 'none'
  command: boolean
} | null = null

function onKeydown(event: KeyboardEvent) {
  enterKey = null
  if (!props.editable) return
  if (composing || event.isComposing || event.keyCode === 229) {
    if (event.key === 'Enter') enterKey = 'composition'
    return
  }

  if (event.key === 'Enter') {
    enterKey = event.shiftKey ? 'newline' : 'command'
    if (event.shiftKey) return
    event.preventDefault()
    emit('command', props.id, 'enter')
  } else if (event.key === 'Tab') {
    event.preventDefault()
    emit('command', props.id, event.shiftKey ? 'outdent' : 'indent')
  }
}

function onBeforeinput(event: InputEvent) {
  if (event.inputType !== 'insertParagraph' && event.inputType !== 'insertLineBreak') return
  const key = enterKey
  enterKey = null
  if (!props.editable || composing || event.isComposing || key === 'composition' || key === 'newline') return

  if (event.cancelable) {
    event.preventDefault()
    if (key !== 'command') emit('command', props.id, 'enter')
    return
  }

  // Some Android keyboards cannot cancel beforeinput; restore the native range on input.
  const field = event.target as HTMLTextAreaElement
  pendingBreak = {
    text: field.value,
    start: field.selectionStart,
    end: field.selectionEnd,
    direction: field.selectionDirection,
    command: key !== 'command',
  }
}

function onInput(event: Event) {
  if (!pendingBreak) return
  const field = event.target as HTMLTextAreaElement
  const pending = pendingBreak
  pendingBreak = null
  field.value = pending.text
  field.setSelectionRange(pending.start, pending.end, pending.direction)
  event.stopImmediatePropagation()
  if (pending.command) emit('command', props.id, 'enter')
}

function resetKeyboard() {
  enterKey = null
}

function onComposition(event: CompositionEvent) {
  composing = event.type === 'compositionstart'
}
</script>

<template>
  <textarea
    v-model="value"
    rows="1"
    :readonly="!editable"
    :aria-label="label"
    :data-mindmap-node-id="id"
    placeholder="新主题"
    enterkeyhint="enter"
    spellcheck="true"
    @focus="emit('select', id)"
    @keydown="onKeydown"
    @keyup="resetKeyboard"
    @blur="resetKeyboard"
    @beforeinput="onBeforeinput"
    @input.capture="onInput"
    @compositionstart="onComposition"
    @compositionend="onComposition"
  ></textarea>
</template>
