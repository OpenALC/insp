package com.insp.notes

import android.app.Activity
import android.app.KeyguardManager
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.os.Build
import android.os.CancellationSignal
import android.webkit.WebView
import androidx.activity.result.ActivityResult
import androidx.annotation.RequiresApi
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.util.concurrent.Executors

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

@TauriPlugin
class DevicePlugin(private val activity: Activity) : Plugin(activity) {
    private val secrets = DeviceSecrets(activity)
    private val storageExecutor = Executors.newSingleThreadExecutor()
    private var pendingAuthentication: Invoke? = null
    private var cancellation: CancellationSignal? = null

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

    override fun onDestroy(activity: AppCompatActivity) {
        val signal = cancellation
        pendingAuthentication?.let { finishAuthentication(it, false) }
        signal?.cancel()
        storageExecutor.shutdown()
    }
}
