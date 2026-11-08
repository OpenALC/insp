# CI 与构建产物

`Build` 工作流在推送 main、提交 PR 或手动运行时启动三个独立任务：

| 任务 | 检查 | 产物 |
| --- | --- | --- |
| Shared frontend | 锁定依赖安装、Vue/TypeScript 检查、Vite 生产构建 | Web 资源 |
| Windows executable | Rust 格式检查、Tauri 发布构建 | Windows x64 EXE |
| Android emulator APK | Android SDK/NDK、Rust Android 目标、Gradle/Tauri 构建 | x86_64 调试 APK |

工作流只授予仓库读取权限，不依赖发布签名密钥。Android 调试包用于模拟器开发，正式发行需另设签名。

鸿蒙另有 `HarmonyOS native build` 手动工作流，运行在已安装 DevEco Studio SDK、ohpm 和 hvigorw 的 Windows runner，标签为 `harmonyos`。这个 runner 尚需管理员注册；仓库不会自动安装或注册本机 runner。公开仓库的 fork PR 不会触发该任务。

鸿蒙编译所需 SDK 不随代码分发，开发者的证书、profile、密钥库和 local.properties 不提交到仓库。手动工作流先打包共享前端，再由宿主编译 HAP；没有已配置 runner 时不要启动该工作流等待队列。

模拟器功能验证在开发过程中直接运行应用完成，不把临时探针或验证脚本加入项目。

查看记录：<https://github.com/OpenALC/insp/actions>。
