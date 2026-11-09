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
    private var densityDpi = 0
    private val imeAnimations = mutableSetOf<WindowInsetsAnimationCompat>()

    fun attach(view: WebView) {
        webView = view
        val content = activity.findViewById<ViewGroup>(android.R.id.content)
        ViewCompat.setOnApplyWindowInsetsListener(content) { _, insets ->
            // onApply receives the target insets before onStart. Keep the current WebView
            // size until all IME animations end, including interrupted show/hide transitions.
            if (imeAnimations.isEmpty()) update(content, insets)
            // Native padding owns the IME space; do not let WebView resize its viewport too.
            WindowInsetsCompat.Builder(insets)
                .setInsets(WindowInsetsCompat.Type.ime(), Insets.NONE)
                .setVisible(WindowInsetsCompat.Type.ime(), false)
                .build()
        }
        ViewCompat.setWindowInsetsAnimationCallback(content, object : WindowInsetsAnimationCompat.Callback(
            WindowInsetsAnimationCompat.Callback.DISPATCH_MODE_STOP,
        ) {
            override fun onPrepare(animation: WindowInsetsAnimationCompat) {
                if (animation.typeMask and WindowInsetsCompat.Type.ime() != 0) {
                    imeAnimations.add(animation)
                }
            }

            override fun onProgress(
                insets: WindowInsetsCompat,
                runningAnimations: MutableList<WindowInsetsAnimationCompat>,
            ): WindowInsetsCompat = insets

            override fun onEnd(animation: WindowInsetsAnimationCompat) {
                if (imeAnimations.remove(animation) && imeAnimations.isEmpty()) {
                    // Re-read settled insets rather than trusting a cancelled animation's target.
                    ViewCompat.requestApplyInsets(content)
                }
            }
        })
        ViewCompat.requestApplyInsets(content)
    }

    private fun update(content: ViewGroup, insets: WindowInsetsCompat) {
        val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
        val imeBottom = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
        if (content.paddingBottom != imeBottom) {
            content.setPadding(content.paddingLeft, content.paddingTop, content.paddingRight, imeBottom)
        }
        // Subtract only space already reserved natively; floating IMEs still need the safe area.
        val nextSafeArea = Insets.of(bars.left, bars.top, bars.right, (bars.bottom - imeBottom).coerceAtLeast(0))
        val nextDensityDpi = webView.resources.configuration.densityDpi
        if (safeArea != nextSafeArea || densityDpi != nextDensityDpi) {
            safeArea = nextSafeArea
            densityDpi = nextDensityDpi
            publish()
        }
    }

    private fun script(): String {
        // Read the actual WebView pixel ratio so the result is CSS px, including display-density changes.
        return """
            (() => {
                const ratio = window.devicePixelRatio;
                const detail = {
                    top: ${safeArea.top} / ratio,
                    bottom: ${safeArea.bottom} / ratio,
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
