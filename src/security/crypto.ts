import type { CipherEnvelope } from '../sync/contracts'

export interface VaultHeader {
  version: 1
  id: string
  kdf: {
    algorithm: 'PBKDF2-SHA256'
    iterations: 600000
    salt: string
  }
  wrappedKey: CipherEnvelope
}

const PBKDF2_ITERATIONS = 600_000
const AES_GCM_ALGORITHM = 'AES-256-GCM'
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const BASE64_LOOKUP = new Int16Array(128)
BASE64_LOOKUP.fill(-1)
for (let index = 0; index < BASE64_ALPHABET.length; index += 1) {
  BASE64_LOOKUP[BASE64_ALPHABET.charCodeAt(index)] = index
}

const textEncoder = new TextEncoder()

export function encodeBase64(bytes: Uint8Array): string {
  const chunks: string[] = []
  let chunk = ''

  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]
    const second = bytes[index + 1]
    const third = bytes[index + 2]

    chunk += BASE64_ALPHABET[first >> 2]
    chunk += BASE64_ALPHABET[((first & 0x03) << 4) | ((second ?? 0) >> 4)]
    chunk += second === undefined
      ? '=='
      : `${BASE64_ALPHABET[((second & 0x0f) << 2) | ((third ?? 0) >> 6)]}${third === undefined ? '=' : BASE64_ALPHABET[third & 0x3f]}`

    if (chunk.length >= 8192) {
      chunks.push(chunk)
      chunk = ''
    }
  }

  if (chunk.length > 0) chunks.push(chunk)
  return chunks.join('')
}

export function decodeBase64(text: string): Uint8Array<ArrayBuffer> {
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0
  const dataLength = text.length - padding
  if (
    text.length % 4 !== 0
    || (padding === 2 && dataLength % 4 !== 2)
    || (padding === 1 && dataLength % 4 !== 3)
    || (padding === 0 && dataLength % 4 !== 0)
  ) {
    throw new Error('Base64格式无效')
  }

  for (let index = 0; index < dataLength; index += 1) {
    const code = text.charCodeAt(index)
    if (code >= BASE64_LOOKUP.length || BASE64_LOOKUP[code] < 0) throw new Error('Base64格式无效')
  }

  const bytes = new Uint8Array((text.length / 4) * 3 - padding)
  let outputIndex = 0

  for (let index = 0; index < text.length; index += 4) {
    const first = BASE64_LOOKUP[text.charCodeAt(index)]
    const second = BASE64_LOOKUP[text.charCodeAt(index + 1)]
    const thirdChar = text.charCodeAt(index + 2)
    const fourthChar = text.charCodeAt(index + 3)
    const third = thirdChar === 61 ? 0 : BASE64_LOOKUP[thirdChar]
    const fourth = fourthChar === 61 ? 0 : BASE64_LOOKUP[fourthChar]

    bytes[outputIndex++] = (first << 2) | (second >> 4)
    if (thirdChar !== 61) bytes[outputIndex++] = ((second & 0x0f) << 4) | (third >> 2)
    if (fourthChar !== 61) bytes[outputIndex++] = ((third & 0x03) << 6) | fourth
  }

  return bytes
}

export function vaultPasswordKind(password: string): 'pin' | 'passphrase' | null {
  if (/^[0-9]{6}$/.test(password)) return 'pin'
  return Array.from(password).length >= 12 ? 'passphrase' : null
}

export async function createVault(password: string): Promise<{ header: VaultHeader; key: CryptoKey }> {
  if (!vaultPasswordKind(password)) throw new Error('请设置 6 位数字口令，或使用至少 12 个字符的复杂口令。')

  const idBytes = crypto.getRandomValues(new Uint8Array(16))
  const id = Array.from(idBytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const wrappingKey = await deriveWrappingKey(password, salt)
  const rawKey = crypto.getRandomValues(new Uint8Array(32))

  try {
    const nonce = crypto.getRandomValues(new Uint8Array(12))
    const ciphertext = await crypto.subtle.encrypt(
      gcmParams(nonce, associatedData(id, '$master')),
      wrappingKey,
      rawKey,
    )
    const key = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])

    return {
      header: {
        version: 1,
        id,
        kdf: {
          algorithm: 'PBKDF2-SHA256',
          iterations: PBKDF2_ITERATIONS,
          salt: encodeBase64(salt),
        },
        wrappedKey: {
          version: 1,
          algorithm: AES_GCM_ALGORITHM,
          keyId: id,
          nonce: encodeBase64(nonce),
          ciphertext: encodeBase64(new Uint8Array(ciphertext)),
        },
      },
      key,
    }
  } finally {
    rawKey.fill(0)
  }
}

export async function unlockVault(header: VaultHeader, password: string): Promise<CryptoKey> {
  assertVaultHeader(header)

  const salt = decodeBase64(header.kdf.salt)
  const wrappingKey = await deriveWrappingKey(password, salt)
  const nonce = decodeBase64(header.wrappedKey.nonce)
  const ciphertext = decodeBase64(header.wrappedKey.ciphertext)
  let rawKey: Uint8Array<ArrayBuffer> | undefined

  try {
    const plaintext = await crypto.subtle.decrypt(
      gcmParams(nonce, associatedData(header.id, '$master')),
      wrappingKey,
      ciphertext,
    )
    rawKey = new Uint8Array(plaintext)
  } catch {
    throw new Error('口令错误或密钥库数据已损坏')
  }

  try {
    if (rawKey.byteLength !== 32) throw new Error('密钥库数据无效')
    return await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  } finally {
    rawKey.fill(0)
  }
}

export async function encryptValue(
  key: CryptoKey,
  vaultId: string,
  recordId: string,
  value: unknown,
): Promise<CipherEnvelope> {
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw new Error('数据无法序列化为JSON')
  }
  if (serialized === undefined) throw new Error('数据无法序列化为JSON')

  const plaintext = textEncoder.encode(serialized)
  const nonce = crypto.getRandomValues(new Uint8Array(12))

  try {
    const ciphertext = await crypto.subtle.encrypt(
      gcmParams(nonce, associatedData(vaultId, recordId)),
      key,
      plaintext,
    )

    return {
      version: 1,
      algorithm: AES_GCM_ALGORITHM,
      keyId: vaultId,
      nonce: encodeBase64(nonce),
      ciphertext: encodeBase64(new Uint8Array(ciphertext)),
    }
  } finally {
    plaintext.fill(0)
  }
}

export async function decryptValue<T>(
  key: CryptoKey,
  vaultId: string,
  recordId: string,
  envelope: CipherEnvelope,
): Promise<T> {
  assertCipherEnvelope(envelope, vaultId)
  const nonce = decodeBase64(envelope.nonce)
  const ciphertext = decodeBase64(envelope.ciphertext)
  let plaintext: ArrayBuffer

  try {
    plaintext = await crypto.subtle.decrypt(
      gcmParams(nonce, associatedData(vaultId, recordId)),
      key,
      ciphertext,
    )
  } catch {
    throw new Error('密文验证失败，数据可能已被篡改或上下文不匹配')
  }

  const plaintextBytes = new Uint8Array(plaintext)
  try {
    const serialized = new TextDecoder('utf-8', { fatal: true }).decode(plaintextBytes)
    return JSON.parse(serialized) as T
  } catch {
    throw new Error('解密内容不是有效的JSON数据')
  } finally {
    plaintextBytes.fill(0)
  }
}

async function deriveWrappingKey(password: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const passwordBytes = textEncoder.encode(password)
  let passwordMaterial: CryptoKey

  try {
    passwordMaterial = await crypto.subtle.importKey('raw', passwordBytes, 'PBKDF2', false, ['deriveKey'])
  } finally {
    passwordBytes.fill(0)
  }

  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
    passwordMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

function gcmParams(nonce: Uint8Array<ArrayBuffer>, additionalData: Uint8Array<ArrayBuffer>): AesGcmParams {
  return { name: 'AES-GCM', iv: nonce, additionalData, tagLength: 128 }
}

function associatedData(vaultId: string, recordId: string): Uint8Array<ArrayBuffer> {
  return textEncoder.encode(`insp|1|${vaultId}|${recordId}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertVaultHeader(header: unknown): asserts header is VaultHeader {
  if (!isRecord(header) || header.version !== 1 || typeof header.id !== 'string' || header.id.length === 0) {
    throw new Error('密钥库格式无效')
  }

  const kdf = header.kdf
  if (!isRecord(kdf) || kdf.algorithm !== 'PBKDF2-SHA256' || kdf.iterations !== PBKDF2_ITERATIONS || typeof kdf.salt !== 'string') {
    throw new Error('密钥库格式无效')
  }

  let salt: Uint8Array<ArrayBuffer>
  try {
    salt = decodeBase64(kdf.salt)
  } catch {
    throw new Error('密钥库格式无效')
  }
  if (salt.byteLength !== 16) throw new Error('密钥库格式无效')

  assertCipherEnvelope(header.wrappedKey, header.id, 48)
}

function assertCipherEnvelope(
  envelope: unknown,
  expectedKeyId: string,
  expectedCiphertextLength?: number,
): asserts envelope is CipherEnvelope {
  if (
    !isRecord(envelope)
    || envelope.version !== 1
    || envelope.algorithm !== AES_GCM_ALGORITHM
    || envelope.keyId !== expectedKeyId
    || typeof envelope.nonce !== 'string'
    || typeof envelope.ciphertext !== 'string'
  ) {
    throw new Error('加密数据格式无效')
  }

  let nonce: Uint8Array<ArrayBuffer>
  let ciphertext: Uint8Array<ArrayBuffer>
  try {
    nonce = decodeBase64(envelope.nonce)
    ciphertext = decodeBase64(envelope.ciphertext)
  } catch {
    throw new Error('加密数据格式无效')
  }

  if (
    nonce.byteLength !== 12
    || ciphertext.byteLength < 16
    || (expectedCiphertextLength !== undefined && ciphertext.byteLength !== expectedCiphertextLength)
  ) {
    throw new Error('加密数据格式无效')
  }
}
