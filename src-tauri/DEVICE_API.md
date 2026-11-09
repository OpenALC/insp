# 原生设备接口

前端通过 `@tauri-apps/api/core` 的 `invoke` 调用下列应用命令，Windows 和 Android 使用同一契约。

| 命令 | 参数 | 成功返回 |
| --- | --- | --- |
| `device_secret_get` | `{ id: string }` | `string \| null`，仅不存在时为 `null` |
| `device_secret_set` | `{ id: string, value: string }` | 无返回值；写入完成后 resolve |
| `device_auth_status` | 无 | `boolean`，当前设备是否可用系统认证 |
| `device_authenticate` | 无 | `boolean`，系统确认身份成功才为 `true`；取消、不可用、系统认证终止失败为 `false` |
| `device_insets` | 无 | `{ top, bottom, left, right }`，四项均为 CSS px 数值 |
| `device_set_appearance` | `{ dark: boolean }` | 无返回值；Android UI 线程将状态栏/导航栏的 light appearance 设为 `!dark`，保留透明背景；Windows no-op |

安全存储、桥接等操作错误会 reject，不能将这些错误当作“无密钥”或“认证成功”。并发发起第二次系统认证会 reject。空字符串是可存储的值，本接口没有删除语义。

## Windows

`src/device/windows.rs` 通过 `CryptProtectData/CryptUnprotectData` 使用当前 Windows 用户 DPAPI，不使用 `CRYPTPROTECT_LOCAL_MACHINE`，也不弹出凭据对话框。ID 与应用命名空间作为额外 entropy 绑定到密文，防止记录互换。

`app_local_data_dir()/device-secrets.sqlite3` 仅保存 ID 和 DPAPI 密文 BLOB；临时 SQLite 日志也不会接触明文值。数据库不参与普通笔记同步。DPAPI 由系统处理用户凭据，应用不读取用户密码。系统认证暂未实现，两个认证命令均返回 `false`，隐私区应使用前端自设 PIN。安全区四边为 `0`。

DPAPI 绑定 Windows 用户环境；复制数据库到其他用户、系统重装后恢复等操作不保证能解密。域漫游等 DPAPI 系统行为由 Windows 管理。

## Android

Rust 插件 `insp-device` 在 setup 中调用 Tauri 2.12.5 的 `PluginApi::register_android_plugin("com.insp.notes", "DevicePlugin")`；命令通过 `PluginHandle::run_mobile_plugin_async` 到达宿主应用内正式的 `@TauriPlugin` / `@Command` 实现。没有额外 JavaScriptInterface、调试端点或伪造的成功结果。Kotlin 源码位于受版本控制的 `gen/android/app/src/main/java/com/insp/notes/`，不依赖修改自动生成的 Wry/Tauri 类。

`DeviceSecrets.kt` 使用 Android Keystore 内不可导出的 AES-256 密钥及 AES-GCM，每次加密由系统生成随机 IV，使用 128-bit 认证标签，AAD 绑定应用命名空间和 ID。仅保存版本、IV 和密文到 `noBackupFilesDir/device-secrets/`；文件名为 ID 的 SHA-256，写入使用 AtomicFile。密钥不要求每次系统认证，以支持普通笔记免口令打开；隐私区认证及解密授权由前端鉴权流程负责，调用 secret_get 本身不会自动认证或授予隐私区权限。

未设置系统锁屏 PIN、图案或密码时，`device_auth_status` 为 `false`。Android 11/API 30 及以上使用平台 `BiometricPrompt` 的 `BIOMETRIC_STRONG | DEVICE_CREDENTIAL`，仅 `onAuthenticationSucceeded` 返回成功；单次指纹不匹配保持系统重试。Android 7–10/API 24–29 使用公开 `KeyguardManager.createConfirmDeviceCredentialIntent`，只接受 Activity 的 `RESULT_OK`。取消、错误和 Activity 销毁均不能返回成功。未接入厂商私有隐私密码。

卸载或清除应用数据后 Keystore 密钥及本地秘密不可恢复。硬件保护等级由设备实现决定，未强制要求 StrongBox。秘密文件排除于 Android 自动备份，避免跨设备恢复不可解密密文。

## 安全区与键盘

`MainActivity` 启用透明状态栏/导航栏、edge-to-edge、显示刘海区域，并关闭系统导航栏对比度遮罩。`DeviceInsets.kt` 读取原生 `WindowInsetsCompat.Type.systemBars() | displayCutout()`，按 WebView 实际 `window.devicePixelRatio` 转成 CSS px。安全区变化、布局变化和键盘动画均推送 DOM 事件：

```js
window.addEventListener('insp:insets', ({ detail }) => {
  // detail: { top, bottom, left, right }，单位 CSS px
})
const initialInsets = await invoke('device_insets')
```

先注册事件，再调用命令取得初始值。原生层不会替前端设置安全区 padding；前端自行应用，避免和 CSS env(safe-area-inset-*) 重复累加。

键盘高度不属于安全区。原生容器根据 IME inset 缩小 WebView，并将已处理的 IME inset 置零后向子视图传递，避免新版 WebView 再次缩小。键盘显示时 bottom 返回 `0`，其余边仍保留系统栏/刘海安全区；收起时恢复底部系统栏 inset。旋转、窗口尺寸变化及键盘动画均由 WindowInsets 和布局回调更新，不轮询屏幕尺寸。

## 依据与验证边界

- [Tauri mobile plugin 官方文档](https://v2.tauri.app/develop/plugins/develop-mobile/)；同时核对本机 tauri-2.12.5 的 `src/plugin/mobile.rs`、`mobile/android/src/main/java/app/tauri/plugin/{Plugin,Invoke,PluginHandle,PluginManager}.kt`，及 wry-0.57.1 的 WebView 创建顺序。
- [Microsoft DPAPI 官方文档](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata)。
- [Android Keystore](https://developer.android.com/privacy-and-security/keystore)、[BiometricPrompt](https://developer.android.com/reference/android/hardware/biometrics/BiometricPrompt)、[KeyguardManager](https://developer.android.com/reference/android/app/KeyguardManager)。
- [Android edge-to-edge](https://developer.android.com/develop/ui/views/layout/edge-to-edge)、[WebView insets 与重复留白处理](https://developer.android.com/develop/ui/views/layout/webapps/understand-window-insets)。

编译验证不能替代不同 Android 版本、导航模式、刘海屏及键盘的设备运行验证。本次不操作真机、不读取现有用户秘密、不构建前端 dist；前端普通笔记免口令和隐私区鉴权迁移由主代理完成。
