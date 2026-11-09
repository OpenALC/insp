# HarmonyOS / NEXT

此目录是可构建的 Stage 模型 ArkTS 应用。原生 ArkWeb 宿主加载 `npm run harmony:prepare` 生成的本地网页资源；`https://insp.local` 由宿主拦截并映射到 rawfile 和应用附件目录，不允许网页访问任意本地路径。ArkWeb 通过 `window.inspNative.postMessage()` 与原生层进行 JSON 请求/响应。

## 功能与数据

- 共享前端以 AES-256-GCM 加密笔记、思维导图、分组、图片和同步配置，ArkData SQLite 保存不透明密文。解锁期间图片解密为 Blob URL，锁定时清理引用。
- 笔记内容继续使用共享前端的 JSON 文档格式；思维导图保存为 `{ type: 'mindmap', root }`，切换列表/思维树由共享前端处理。
- 图片从 ArkWeb 文件选择器导入，支持 PNG、JPEG、GIF、WebP，单张最大 20 MB；正文只引用附件 ID。
- 返回键派发可取消的 `insp:back` 事件：前端可关闭侧栏或返回笔记列表；在笔记列表时宿主退出应用。进入后台时宿主请求前端保存。
- 数据库迁移保留已有笔记及附件；完整加密事务提交成功后才清理旧明文。启动时拒绝打开高于当前版本的数据库。
- 隐私笔记的独立认证由共享前端配合下述设备认证接口处理；新建隐私笔记默认仅本机，可逐篇明确启用同步。普通笔记由 HUKS 保护的设备凭据自动打开；旧加密空间仅在升级时验证一次原口令。
- Harmony 宿主通过 NetworkKit HTTP 传输同步密文；Linux 服务端不能解密笔记。生产环境使用 HTTPS，本地联调可通过 HDC 反向端口转发访问开发服务。

ArkData 的查询结果存在单条 2 MB 的读取限制。密文列表在 SQL 阶段跳过图片内容，大密文通过每块 512 KiB 的参数化查询读取；所有 vault 命令共用原生串行队列，网络请求单独运行，避免并发读写混合密文片段。不要将附件改回列表中的整字段查询。限制说明见 [华为 ArkData 文档](https://developer.huawei.com/consumer/en/doc/harmonyos-references/arkts-apis-data-relationalstore/)。

## 设备安全与安全区桥接

以下命令沿用 `window.inspNative.postMessage()` 的请求/响应封装，`result` 是 JSON 字符串；无返回值的命令返回 JSON `null`。

| 命令 | 参数 | 返回值 |
| --- | --- | --- |
| `device_secret_get` | `{ id: string }` | `string \| null`，不存在时为 `null` |
| `device_secret_set` | `{ id: string, value: string }` | 无返回值 |
| `device_auth_status` | `{}` | `boolean`，未设置系统锁屏凭据时为 `false` |
| `device_authenticate` | `{}` | `boolean`，只有真实系统认证回调 `SUCCESS` 才为 `true` |
| `device_insets` | `{}` | `{ top, bottom, left, right }`，单位为 CSS px / vp |
| `device_set_appearance` | `{ dark: boolean }` | 无返回值，等待当前 Window 的系统栏设置完成 |

`DeviceSecurity.ets` 使用公开 HUKS API 在服务内生成并保管 AES-256-GCM 密钥，不导出密钥。应用的 `device-secrets` preferences 仅保存 `v1:` 加 Base64 编码的 12 字节随机 nonce、密文及 16 字节认证标签；secret ID 参与 AAD，替换 ID 或修改密文不能通过认证。不存在的记录不会创建密钥，读取失败也不会重建密钥或退回明文。secret 读写使用独立串行队列，防止首次写入并发生成覆盖密钥，不占用原有 vault 队列。

认证使用公开 `userIAM.userAuth` 系统组件：以 ATL2 检查已录入的系统锁屏 PIN/密码，并加入设备支持且已录入的指纹、面容；不使用认证结果复用，不接厂商隐私密码。未设置锁屏凭据时返回 `false`，交由共享前端使用自设隐私 PIN。认证 Promise 等待结果回调，取消、失败、超时、锁定均为 `false`；重复的并发认证请求为 `false`。页面或窗口关闭时取消未完成认证并注销结果监听。

`HarmonyWindowInsets.ets` 在加载网页前启用全屏布局，设置透明状态栏和导航栏，并合并系统栏、导航指示条、挖孔安全区。像素值除以窗口所在屏幕的 `densityPixels` 得到 vp，配合共享网页的设备宽度 viewport 使用 CSS px。初始值由 `device_insets` 获取，网页加载结束和后续 `avoidAreaChange` / `windowSizeChange` 通过 `CustomEvent('insp:insets', { detail: ... })` 推送。键盘区域不参与合并，ArkUI 只扩展 SYSTEM / CUTOUT 安全区，保留键盘避让。窗口关闭时按原回调注销监听、清空桥接及缓存。2in1 不支持 SDK 系统栏设置，因此只配置全屏布局和安全区。

接口依据本机 SDK `26.0.0.105` 的公开类型定义及 [HUKS AES/GCM 官方示例](https://github.com/openharmony/docs/blob/master/en/application-dev/security/UniversalKeystoreKit/huks-encryption-decryption-arkts.md) 核对。

`device_set_appearance` 接收前端实际主题，包含用户手动选择的深色模式，不依赖系统主题。当前 Window 的 `statusBarContentColor` / `navigationBarContentColor` 在深色时设为 `#D4D4D4`，浅色时设为 `#000000`；两栏背景始终为透明 `#00000000`。启动时默认浅色，随后由前端调用更新。窗口销毁时解除外观处理函数，避免保留旧 Window；2in1 沿用上述 SDK 系统栏能力限制。

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

2026-11-09 本轮新增设备安全 / 沉浸式验证：使用本机 SDK API 26（`26.0.0.105`）执行下列真实原生构建，`CompileArkTS`、`PackageHap` 通过，最终 `BUILD SUCCESSFUL`：

```powershell
& 'D:/ide/Huawei/DevEco Studio/tools/hvigor/bin/hvigorw.bat' --mode module -p product=default -p module=entry@default -p buildMode=debug assembleHap --no-daemon
```

产出 `entry/build/default/outputs/default/entry-default-unsigned.hap`。构建日志确认 `No signingConfig found for product default`，未执行实际签名。保留 SDK 的可能抛异常、设备能力以及 2in1 系统栏 API 静态警告（调用处已排除 2in1）。`git diff --check -- platforms/harmonyos` 通过。原有 `NotesRepository.ets` 未改动，vault 串行队列及 512 KiB 分块保持原样。本轮没有构建网页、改写生成的 rawfile/web 或操作设备；HUKS 加解密、系统认证成功/取消/未设置锁屏、旋转与键盘的运行效果尚未验证。下列模拟器记录是此前已有功能的验证记录，不代表这些新增功能已实测。

补充 `device_set_appearance` 后再次执行同一 Hvigor 命令，`CompileArkTS` 与 `PackageHap` 通过，`BUILD SUCCESSFUL in 8 s 720 ms`，更新 unsigned HAP，原生实现冻结。系统栏随前端手动主题变化的设备运行效果尚未验证；本次未改动生成的 web 资源。

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
