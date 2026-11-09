package com.insp.notes

import android.app.Activity
import android.app.KeyguardManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.os.Build
import android.os.CancellationSignal
import android.util.Base64
import android.webkit.WebView
import androidx.activity.result.ActivityResult
import androidx.annotation.RequiresApi
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.content.FileProvider
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.util.concurrent.Executors
import java.io.File

@InvokeArg
class SecretIdArgs {
    lateinit var id: String
}

@InvokeArg
class SecretSetArgs {
    lateinit var id: String
    lateinit var value: String
}

@InvokeArg
class AppearanceArgs {
    var dark: Boolean = false
}

@InvokeArg
class ShareTextArgs {
    lateinit var text: String
}

@InvokeArg
class ExportFileArgs {
    lateinit var name: String
    lateinit var mimeType: String
    lateinit var base64: String
}

@TauriPlugin
class DevicePlugin(private val activity: Activity) : Plugin(activity) {
    private val secrets = DeviceSecrets(activity.applicationContext)
    private companion object {
        // Device secrets are shared by every activity in this process, including during recreation.
        val storageExecutor = Executors.newSingleThreadExecutor()
    }
    private var pendingAuthentication: Invoke? = null
    private var cancellation: CancellationSignal? = null
    private var pendingSaveBytes: ByteArray? = null

    override fun load(webView: WebView) {
        (activity as MainActivity).deviceInsets.attach(webView)
    }

    @Command
    fun secretGet(invoke: Invoke) {
        val args = invoke.parseArgs(SecretIdArgs::class.java)
        storageExecutor.execute {
            // Worker failures must reject the invoke; the Tauri dispatcher only catches synchronous failures.
            try {
                val value = secrets.get(args.id)
                if (value == null) invoke.resolve() else invoke.resolveObject(value)
            } catch (_: Exception) {
                invoke.reject("无法读取设备安全存储；密文损坏或设备密钥不可用。")
            }
        }
    }

    @Command
    fun secretSet(invoke: Invoke) {
        val args = invoke.parseArgs(SecretSetArgs::class.java)
        storageExecutor.execute {
            try {
                secrets.set(args.id, args.value)
                invoke.resolve()
            } catch (_: Exception) {
                invoke.reject("无法写入设备安全存储。")
            }
        }
    }

    private fun authenticationAvailable(): Boolean {
        val keyguard = activity.getSystemService(KeyguardManager::class.java)
        if (!keyguard.isDeviceSecure) return false
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.R ||
            activity.getSystemService(BiometricManager::class.java)
                .canAuthenticate(authenticators()) == BiometricManager.BIOMETRIC_SUCCESS
    }

    @RequiresApi(Build.VERSION_CODES.R)
    private fun authenticators(): Int = BiometricManager.Authenticators.BIOMETRIC_STRONG or
        BiometricManager.Authenticators.DEVICE_CREDENTIAL

    @Command
    fun authStatus(invoke: Invoke) {
        invoke.resolveObject(authenticationAvailable())
    }

    @Command
    fun authenticate(invoke: Invoke) {
        if (pendingAuthentication != null) {
            invoke.reject("系统认证正在进行。")
            return
        }
        if (!authenticationAvailable()) {
            invoke.resolveObject(false)
            return
        }
        pendingAuthentication = invoke
        // Launch failures also need to clear the pending request so a later attempt can proceed.
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                authenticateBiometric(invoke)
            } else {
                authenticateCredential(invoke)
            }
        } catch (_: Exception) {
            finishAuthentication(invoke, false)
        }
    }

    @RequiresApi(Build.VERSION_CODES.R)
    private fun authenticateBiometric(invoke: Invoke) {
        val signal = CancellationSignal()
        cancellation = signal
        BiometricPrompt.Builder(activity)
            .setTitle("解锁隐私区")
            .setSubtitle("使用系统锁屏密码或生物识别验证身份")
            .setAllowedAuthenticators(authenticators())
            .setConfirmationRequired(true)
            .build()
            .authenticate(signal, activity.mainExecutor, object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    finishAuthentication(invoke, true)
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    finishAuthentication(invoke, false)
                }
                // onAuthenticationFailed is a retryable biometric mismatch, never a success.
            })
    }

    @Suppress("DEPRECATION")
    private fun authenticateCredential(invoke: Invoke) {
        // API 24–29 use the public system credential challenge, avoiding unsupported authenticator combinations.
        val intent = activity.getSystemService(KeyguardManager::class.java)
            .createConfirmDeviceCredentialIntent("解锁隐私区", "请验证系统锁屏密码")
        if (intent == null) {
            finishAuthentication(invoke, false)
            return
        }
        startActivityForResult(invoke, intent, "credentialResult")
    }

    @ActivityCallback
    fun credentialResult(invoke: Invoke, result: ActivityResult) {
        finishAuthentication(invoke, result.resultCode == Activity.RESULT_OK)
    }

    private fun finishAuthentication(invoke: Invoke, success: Boolean) {
        // A destroyed activity or an already completed request must never deliver a late success.
        if (pendingAuthentication !== invoke) return
        pendingAuthentication = null
        cancellation = null
        invoke.resolveObject(success)
    }

    @Command
    fun insets(invoke: Invoke) {
        (activity as MainActivity).deviceInsets.resolve(invoke)
    }

    @Command
    fun setAppearance(invoke: Invoke) {
        val args = invoke.parseArgs(AppearanceArgs::class.java)
        activity.runOnUiThread {
            val window = activity.window
            WindowCompat.getInsetsController(window, window.decorView).apply {
                isAppearanceLightStatusBars = !args.dark
                isAppearanceLightNavigationBars = !args.dark
            }
            invoke.resolve()
        }
    }

    @Command
    fun shareText(invoke: Invoke) {
        val text = invoke.parseArgs(ShareTextArgs::class.java).text
        val clipboard = activity.getSystemService(ClipboardManager::class.java)
        clipboard.setPrimaryClip(ClipData.newPlainText("拾页笔记", text))
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, text)
        }
        activity.startActivity(Intent.createChooser(send, "分享笔记"))
        invoke.resolve()
    }

    @Command
    fun shareFile(invoke: Invoke) {
        val args = invoke.parseArgs(ExportFileArgs::class.java)
        val directory = File(activity.cacheDir, "shared-notes").apply { mkdirs() }
        val file = File(directory, File(args.name).name.replace('\\', '_'))
        file.writeBytes(Base64.decode(args.base64, Base64.DEFAULT))
        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
        val send = Intent(Intent.ACTION_SEND).apply {
            type = args.mimeType
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        activity.startActivity(Intent.createChooser(send, "分享笔记").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
        invoke.resolve()
    }

    @Command
    fun saveFile(invoke: Invoke) {
        val args = invoke.parseArgs(ExportFileArgs::class.java)
        pendingSaveBytes = Base64.decode(args.base64, Base64.DEFAULT)
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = args.mimeType
            putExtra(Intent.EXTRA_TITLE, File(args.name).name.replace('\\', '_'))
        }
        startActivityForResult(invoke, intent, "fileSaveResult")
    }

    @ActivityCallback
    fun fileSaveResult(invoke: Invoke, result: ActivityResult) {
        val bytes = pendingSaveBytes
        pendingSaveBytes = null
        if (result.resultCode != Activity.RESULT_OK || result.data?.data == null || bytes == null) {
            invoke.resolveObject(false)
            return
        }
        try {
            activity.contentResolver.openOutputStream(result.data!!.data!!, "wt")!!.use { it.write(bytes) }
            invoke.resolveObject(true)
        } catch (error: Exception) {
            invoke.reject("无法保存文件：${error.message}")
        }
    }

    override fun onDestroy(activity: AppCompatActivity) {
        val signal = cancellation
        pendingAuthentication?.let { finishAuthentication(it, false) }
        signal?.cancel()
    }
}
