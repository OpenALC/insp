import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createVault,
  decodeBase64,
  decryptValue,
  encodeBase64,
  encryptValue,
  unlockVault,
  type VaultHeader,
} from './crypto.ts'

const PASSWORD = 'correct horse battery staple'

test('a six-digit vault preserves leading zeros and rejects incomplete or mixed PINs', async () => {
  const { header, key } = await createVault('012345')
  const record = await encryptValue(key, header.id, 'note-1', { title: '数字口令' })
  const reopened = await unlockVault(header, '012345')
  assert.deepEqual(await decryptValue(reopened, header.id, 'note-1', record), { title: '数字口令' })
  await assert.rejects(unlockVault(header, '12345'), /口令错误/)
  for (const invalid of ['12345', '0123456', '12a345', ' 12345']) {
    await assert.rejects(createVault(invalid), /6 位数字/)
  }
})

test('vault values round-trip with fresh nonces and a non-exportable key', async () => {
  const { header, key } = await createVault(PASSWORD)
  const first = await encryptValue(key, header.id, 'record-1', { title: '秘密', count: 3 })
  const second = await encryptValue(key, header.id, 'record-1', { title: '秘密', count: 3 })

  assert.notEqual(first.nonce, second.nonce)
  assert.deepEqual(await decryptValue(key, header.id, 'record-1', first), { title: '秘密', count: 3 })
  assert.equal(key.extractable, false)
  await assert.rejects(crypto.subtle.exportKey('raw', key))
})

test('wrong passwords and modified ciphertext are rejected with clear Chinese errors', async () => {
  const { header, key } = await createVault(PASSWORD)

  await assert.rejects(
    unlockVault(header, 'this is an incorrect password'),
    /口令错误或密钥库数据已损坏/,
  )

  const envelope = await encryptValue(key, header.id, 'record-2', { body: '保密内容' })
  const ciphertext = decodeBase64(envelope.ciphertext)
  ciphertext[0] ^= 1
  const tampered = { ...envelope, ciphertext: encodeBase64(ciphertext) }

  await assert.rejects(
    decryptValue(key, header.id, 'record-2', tampered),
    /密文验证失败，数据可能已被篡改或上下文不匹配/,
  )
})

test('record IDs are authenticated as additional data', async () => {
  const { header, key } = await createVault(PASSWORD)
  const envelope = await encryptValue(key, header.id, 'record-a', { body: '隔离记录' })

  await assert.rejects(
    decryptValue(key, header.id, 'record-b', envelope),
    /密文验证失败，数据可能已被篡改或上下文不匹配/,
  )
})

test('unlock rejects unsupported KDF parameters before deriving a key', async () => {
  const { header } = await createVault(PASSWORD)
  const malformed = JSON.parse(JSON.stringify(header)) as VaultHeader
  Object.assign(malformed.kdf, { iterations: 1 })

  await assert.rejects(unlockVault(malformed, PASSWORD), /密钥库格式无效/)
})

test('Base64 round-trips a 2 MiB binary payload', () => {
  const original = new Uint8Array(2 * 1024 * 1024)
  for (let index = 0; index < original.length; index += 1) {
    original[index] = (index * 73 + (index >>> 8)) & 0xff
  }

  assert.deepEqual(decodeBase64(encodeBase64(original)), original)
})
