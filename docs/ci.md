# CI 与构建产物

`Build` 工作流在推送 main、提交 PR 或手动运行时启动四个独立任务：

| 任务 | 检查 | 产物 |
| --- | --- | --- |
| Shared frontend | 锁定依赖安装、加密和同步策略测试、Vue/TypeScript 检查、Vite 生产构建 | Web 资源 |
| Windows executable | Rust 格式及迁移测试、Tauri 发布构建 | Windows x64 EXE |
| Android emulator APK | Android SDK/NDK、Rust Android 目标、Gradle/Tauri 构建 | x86_64 调试 APK |
| Linux encrypted sync server | Rust 格式、HTTP 协议测试、Linux 发布构建、Docker 镜像构建 | Linux x64 同步服务 |

工作流只授予仓库读取权限，不依赖发布签名密钥。Android 调试包用于模拟器开发，正式发行需另设签名。

鸿蒙另有 `HarmonyOS native build` 手动工作流，运行在已安装 DevEco Studio SDK、ohpm 和 hvigorw 的 Windows runner，标签为 `harmonyos`。验证使用一次性 `--ephemeral` runner：领取一个任务后自动注销，不安装常驻服务。后续手动运行前需先提供对应 runner；公开仓库的 fork PR 不会触发该任务。

鸿蒙编译所需 SDK 不随代码分发，开发者的证书、profile、密钥库和 local.properties 不提交到仓库。手动工作流先打包共享前端，再由宿主编译 unsigned HAP。原生构建使用当前安装的 API 26 SDK；模拟器支持未签名调试包，真机和发行签名另外配置。

本机开发环境需在 runner 的 PATH 中提供 `ohpm`、`hvigorw`，并设置 `DEVECO_SDK_HOME`。runner 工作目录与日常开发目录分开，构建输出只上传 HAP，不上传设备数据或签名材料。

鸿蒙任务使用 runner 工具目录内的独立 npm 缓存，重复构建可复用本项目依赖，不上传本机共用 npm 缓存。

模拟器功能验证在开发过程中直接运行应用完成，不把临时探针或验证脚本加入项目。

查看记录：<https://github.com/OpenALC/insp/actions>。
