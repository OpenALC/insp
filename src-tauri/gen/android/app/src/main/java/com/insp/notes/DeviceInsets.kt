package com.insp.notes

import android.view.ViewGroup
import android.webkit.WebView
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsAnimationCompat
import androidx.core.view.WindowInsetsCompat
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import org.json.JSONTokener

class DeviceInsets(private val activity: MainActivity) {
    private lateinit var webView: WebView
    private var safeArea = Insets.NONE
    private var imeVisible = false

    fun attach(view: WebView) {
        webView = view
        val content = activity.findViewById<ViewGroup>(android.R.id.content)
        ViewCompat.setOnApplyWindowInsetsListener(content) { _, insets ->
            update(content, insets)
            // The native container has already resized for IME. Zero only that type to avoid double resizing.
            WindowInsetsCompat.Builder(insets)
                .setInsets(WindowInsetsCompat.Type.ime(), Insets.NONE)
                .setVisible(WindowInsetsCompat.Type.ime(), false)
                .build()
        }
        ViewCompat.setWindowInsetsAnimationCallback(content, object : WindowInsetsAnimationCompat.Callback(
            WindowInsetsAnimationCompat.Callback.DISPATCH_MODE_CONTINUE_ON_SUBTREE,
        ) {
            override fun onProgress(
                insets: WindowInsetsCompat,
                runningAnimations: MutableList<WindowInsetsAnimationCompat>,
            ): WindowInsetsCompat {
                update(content, insets)
                return WindowInsetsCompat.Builder(insets)
                    .setInsets(WindowInsetsCompat.Type.ime(), Insets.NONE)
                    .setVisible(WindowInsetsCompat.Type.ime(), false)
                    .build()
            }
        })
        webView.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> publish() }
        ViewCompat.requestApplyInsets(content)
    }

    private fun update(content: ViewGroup, insets: WindowInsetsCompat) {
        safeArea = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
        val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
        imeVisible = insets.isVisible(WindowInsetsCompat.Type.ime())
        content.setPadding(0, 0, 0, ime.bottom)
        publish()
    }

    private fun script(): String {
        // Read the actual WebView pixel ratio so the result is CSS px, including display-density changes.
        val bottom = if (imeVisible) 0 else safeArea.bottom
        return """
            (() => {
                const ratio = window.devicePixelRatio;
                const detail = {
                    top: ${safeArea.top} / ratio,
                    bottom: $bottom / ratio,
                    left: ${safeArea.left} / ratio,
                    right: ${safeArea.right} / ratio
                };
                window.dispatchEvent(new CustomEvent('insp:insets', { detail }));
                return JSON.stringify(detail);
            })()
        """.trimIndent()
    }

    private fun publish() {
        webView.evaluateJavascript(script(), null)
    }

    fun resolve(invoke: Invoke) {
        webView.evaluateJavascript(script()) { result ->
            // evaluateJavascript JSON-encodes the returned JSON string once more.
            val json = JSONTokener(result).nextValue()
            if (json is String) invoke.resolve(JSObject(json))
            else invoke.reject("WebView 安全区尚不可用。")
        }
    }
}
