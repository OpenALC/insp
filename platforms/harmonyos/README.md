# HarmonyOS / NEXT

此目录是可构建的 Stage 模型 ArkTS 应用。原生 ArkWeb 宿主加载 `npm run harmony:prepare` 生成的本地网页资源；`https://insp.local` 由宿主拦截并映射到 rawfile 和应用附件目录，不允许网页访问任意本地路径。ArkWeb 通过 `window.inspNative.postMessage()` 与原生层进行 JSON 请求/响应。

## 功能与数据

- ArkData SQLite 保存笔记、思维导图、分组、附件索引和同步预留表；应用文件目录保存图片附件。
- 笔记内容继续使用共享前端的 JSON 文档格式；思维导图保存为 `{ type: 'mindmap', root }`，切换列表/思维树由共享前端处理。
- 图片从 ArkWeb 文件选择器导入，支持 PNG、JPEG、GIF、WebP，单张最大 20 MB；正文只引用附件 ID。
- 返回键派发可取消的 `insp:back` 事件：前端可关闭侧栏或返回笔记列表；在笔记列表时宿主退出应用。进入后台时宿主请求前端保存。
- 数据库 `user_version` 为 1；启动时保留已有附件目录，并拒绝打开高于当前版本的数据库。
- 当前跨端同步仍由后续同步服务实现；本地表已保留 outbox/state 字段。Harmony 宿主不包含同步网络客户端。

## 构建

需要 Node.js/npm、HarmonyOS SDK API 26、ohpm 和 Hvigor。先在仓库根目录构建网页并复制资源，再打包 HAP：

```powershell
npm ci
npm run harmony:prepare
Push-Location platforms/harmonyos
hvigorw assembleHap --mode module -p product=default -p module=entry
Pop-Location
```

`harmony:prepare` 会运行共享前端的类型检查和 Vite 构建，并覆盖生成目录 `entry/src/main/resources/rawfile/web`。请勿手工编辑该目录。

在 DevEco 命令行工具不在 `PATH` 时，可直接调用本机 Hvigor：

```powershell
& 'D:\ide\Huawei\DevEco Studio\tools\hvigor\bin\hvigorw.bat' assembleHap --mode module -p product=default -p module=entry
```

生成包：`entry/build/default/outputs/default/entry-default-unsigned.hap`。本地 HarmonyOS CI 可执行同一组 `harmony:prepare` 与 Hvigor 命令；Windows runner 需预装 API 26 SDK、ohpm、Hvigor 和 Node.js。

## 模拟器与签名

模拟器调试可使用 unsigned HAP；真机安装或发布需要 HarmonyOS 签名配置。签名文件、密钥库密码和签名配置只应保存在本机未跟踪文件或 CI secret 中，不能提交到仓库。当前 `build-profile.json5` 不包含签名配置，因此构建输出为 unsigned HAP。

模拟器在线后，可通过 HDC 安装并启动（将 `<emulator-target>` 换成模拟器显示的目标 ID）：

```powershell
hdc -t <emulator-target> install entry/build/default/outputs/default/entry-default-unsigned.hap
hdc -t <emulator-target> shell aa start -a EntryAbility -b com.openalc.inspnotes -m entry
```

## 当前构建状态

2026-11-08：已用 API 26 SDK 完成 ArkTS 编译与 unsigned HAP 打包。模拟器安装和运行需在 DevEco 模拟器在线后完成；本目录没有提交签名材料。
