# HarmonyOS / NEXT

此目录是可构建的 Stage 模型 ArkTS 应用。原生 ArkWeb 宿主加载 `npm run harmony:prepare` 生成的本地网页资源；`https://insp.local` 由宿主拦截并映射到 rawfile 和应用附件目录，不允许网页访问任意本地路径。ArkWeb 通过 `window.inspNative.postMessage()` 与原生层进行 JSON 请求/响应。

## 功能与数据

- 共享前端以 AES-256-GCM 加密笔记、思维导图、分组、图片和同步配置，ArkData SQLite 保存不透明密文。解锁期间图片解密为 Blob URL，锁定时清理引用。
- 笔记内容继续使用共享前端的 JSON 文档格式；思维导图保存为 `{ type: 'mindmap', root }`，切换列表/思维树由共享前端处理。
- 图片从 ArkWeb 文件选择器导入，支持 PNG、JPEG、GIF、WebP，单张最大 20 MB；正文只引用附件 ID。
- 返回键派发可取消的 `insp:back` 事件：前端可关闭侧栏或返回笔记列表；在笔记列表时宿主退出应用。进入后台时宿主请求前端保存。
- 数据库迁移保留已有笔记及附件；完整加密事务提交成功后才清理旧明文。启动时拒绝打开高于当前版本的数据库。
- 隐私笔记需再次验证空间口令后显示，新建隐私笔记默认仅本机，可逐篇明确启用同步。应用进程重启后需要重新解锁。
- Harmony 宿主通过 NetworkKit HTTP 传输同步密文；Linux 服务端不能解密笔记。生产环境使用 HTTPS，本地联调可通过 HDC 反向端口转发访问开发服务。

ArkData 的查询结果存在单条 2 MB 的读取限制。密文列表在 SQL 阶段跳过图片内容，大密文通过每块 512 KiB 的参数化查询读取；所有 vault 命令共用原生串行队列，网络请求单独运行，避免并发读写混合密文片段。不要将附件改回列表中的整字段查询。限制说明见 [华为 ArkData 文档](https://developer.huawei.com/consumer/en/doc/harmonyos-references/arkts-apis-data-relationalstore/)。

## 构建

需要 Node.js/npm、HarmonyOS SDK API 26、ohpm 和 Hvigor。将 DevEco 命令行工具加入 `PATH`，并设置 `DEVECO_SDK_HOME`。先在仓库根目录构建网页并复制资源，再打包 HAP：

```powershell
npm ci
npm run harmony:prepare
Push-Location platforms/harmonyos
ohpm install --all
hvigorw --mode module -p product=default -p module=entry@default -p buildMode=debug assembleHap --no-daemon
Pop-Location
```

`harmony:prepare` 会运行共享前端的类型检查和 Vite 构建，并覆盖生成目录 `entry/src/main/resources/rawfile/web`。请勿手工编辑该目录。

生成包：`entry/build/default/outputs/default/entry-default-unsigned.hap`。本地 HarmonyOS CI 可执行同一组 `harmony:prepare` 与 Hvigor 命令；Windows runner 需预装 API 26 SDK、ohpm、Hvigor 和 Node.js。

## 模拟器与签名

模拟器调试可使用 unsigned HAP；真机安装或发布需要 HarmonyOS 签名配置。签名文件、密钥库密码和签名配置只应保存在本机未跟踪文件或 CI secret 中，不能提交到仓库。当前 `build-profile.json5` 不包含签名配置，因此构建输出为 unsigned HAP。

模拟器在线后，可通过 HDC 安装并启动（将 `<emulator-target>` 换成模拟器显示的目标 ID）：

```powershell
hdc -t <emulator-target> install entry/build/default/outputs/default/entry-default-unsigned.hap
hdc -t <emulator-target> shell aa start -a EntryAbility -b com.openalc.inspnotes -m entry
```

## 当前构建状态

2026-11-09：API 26 原生编译通过。在本地 HarmonyOS 7 / API 26 平板模拟器保留数据安装 unsigned HAP，完成以下实际界面操作：

- 创建分组、编辑富文本，将普通笔记与导图归入同一分组。
- 编辑根节点与子节点，切换列表和思维树，确认文字及层级保留。
- 通过系统图库选择器插入 PNG，确认正文显示图片。
- 进入后台、强停并重新启动后，分组、富文本、图片和导图节点均恢复；系统返回键可从编辑返回，再等待保存后退出。
- 使用已有加密库强停重启后恢复笔记和分组；密文大小为 2,323,825 字节的图片在重启后可实际显示，覆盖 ArkData 大字段读取回归。
- 通过 Linux 服务与 Windows、Android 互收分组、正文、图片和导图；隐私笔记明确开启同步后可在口令认证的隐私区打开，普通区搜索不显示。源设备改回仅本机后，同步会从对端隐私区撤下该笔记，源设备仍保留本机副本。
- 浅色与深色界面正文可读，图标外侧无明显黑边。包内文字颜色分别为 `#000` 和 `#d4d4d4`；该模拟器未启用 ArkWeb DevTools，没有将静态样式检查记作运行时计算色验证。

空白模拟器可先将仓库现有 PNG 图标导入媒体库，再打开图片选择器：

```powershell
hdc -t <emulator-target> file send <absolute-path-to-image.png> /mnt/data/100/media_fuse/Photo/insp-image.png
```

该媒体库路径适用于 API 21+，参见 [华为媒体库调试文档](https://developer.huawei.com/consumer/en/doc/harmonyos-guides/mediatool/)。本目录没有提交签名材料或设备数据。
