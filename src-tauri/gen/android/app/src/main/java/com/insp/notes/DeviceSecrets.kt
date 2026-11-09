package com.insp.notes

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import android.util.Base64
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal class DeviceSecrets(private val context: Context) {
    private val keyAlias = "com.insp.notes.device-secrets.v1"

    private fun store(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun keyForWrite(): SecretKey {
        val existing = store().getKey(keyAlias, null)
        if (existing != null) return existing as SecretKey
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(
                KeyGenParameterSpec.Builder(
                    keyAlias,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setKeySize(256)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setRandomizedEncryptionRequired(true)
                    // Ordinary notes must open without an authentication prompt.
                    .setUserAuthenticationRequired(false)
                    .build(),
            )
        }.generateKey()
    }

    private fun file(id: String): AtomicFile {
        val digest = MessageDigest.getInstance("SHA-256").digest(id.toByteArray(Charsets.UTF_8))
        val name = digest.joinToString("") { "%02x".format(it) }
        val directory = File(context.noBackupFilesDir, "device-secrets")
        directory.mkdirs()
        return AtomicFile(File(directory, "$name.json"))
    }

    private fun aad(id: String): ByteArray =
        "com.insp.notes/device-secret/v1/$id".toByteArray(Charsets.UTF_8)

    fun get(id: String): String? {
        val file = file(id)
        if (!file.baseFile.exists() && !File(file.baseFile.path + ".bak").exists()) return null
        val record = file.openRead().bufferedReader(Charsets.UTF_8).use { JSONObject(it.readText()) }
        require(record.getInt("version") == 1) { "Unsupported secret version" }
        // Never generate a replacement key while trying to read existing ciphertext.
        val key = store().getKey(keyAlias, null) as SecretKey
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.DECRYPT_MODE,
            key,
            GCMParameterSpec(128, Base64.decode(record.getString("iv"), Base64.NO_WRAP)),
        )
        cipher.updateAAD(aad(id))
        val plaintext = cipher.doFinal(Base64.decode(record.getString("ciphertext"), Base64.NO_WRAP))
        return plaintext.toString(Charsets.UTF_8)
    }

    fun set(id: String, value: String) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, keyForWrite())
        cipher.updateAAD(aad(id))
        val ciphertext = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        val record = JSONObject()
            .put("version", 1)
            .put("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .put("ciphertext", Base64.encodeToString(ciphertext, Base64.NO_WRAP))
            .toString().toByteArray(Charsets.UTF_8)
        val file = file(id)
        val stream = file.startWrite()
        // AtomicFile must roll back failed writes to preserve an existing device key.
        try {
            stream.write(record)
            file.finishWrite(stream)
        } catch (error: Exception) {
            file.failWrite(stream)
            throw error
        }
    }
}
