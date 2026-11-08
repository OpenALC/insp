# Android 接入预留

当前没有生成 Android 工程或 APK，也未在 Android 上验证。

已有：共享 Vue/Tiptap、`WorkspaceRepository` / `AttachmentStore`、可移动端编译的 Tauri Rust 入口、`createTauriAdapter('android')`。

后续安装 Android Studio / SDK / NDK 后，执行 `npm run tauri -- android init`，再使用 `npm run tauri -- android dev`。初始化生成内容位于 `src-tauri/gen/android`。

接入工作：

- 用 Tauri 移动插件 / Kotlin 实现系统图片选择、分享接收与 Keystore。
- 调整键盘遮挡、选择菜单、返回手势及窄屏布局。
- 应用暂停前提交前端保存队列；系统可能直接回收后台进程。
- 检查 bundled SQLite 的 NDK 编译、WebView 附件协议和离线重启。

数据目录始终通过宿主 API 获取，不能复用 Windows 路径。
