# 实现边界

## 共享文档与平台

`WorkspaceRepository` 管理笔记与分组，`AttachmentStore` 处理附件，组件只依赖这两个业务接口。`createNativeAdapter` 统一命令的 JSON 传输格式。数据库时间统一使用 UTC ISO 8601，展示时由客户端转换。

Windows 和 Android 使用 Rust + bundled SQLite，HarmonyOS 使用 ArkData SQLite。各宿主从应用私有目录打开数据库，通过原生命令访问；Vue 不直接执行 SQL。正常保存使用事务，删除笔记保留 tombstone；删除分组在一个事务里解除笔记归属并删除分组。

本地 `revision` 每次保存递增，与未来的 `server_revision` 分离。当前不产生网络请求，也不写入待上传队列。后续启用同步时，只有 `syncPolicy=sync` 的记录才进入队列；提交笔记和对应加密 outbox 记录必须在同一事务中完成。

分组类型预留 `parentId`，首版 UI 只创建平级分组。普通笔记正文使用 Tiptap JSON；`kind=mindmap` 保存 `{ type: 'mindmap', root: { id, text, children } }`。列表与思维树直接操作同一份树，不进行 Markdown/HTML 转换，切换视图不触发正文保存，不重新分配节点 ID。节点的顺序、层级、空文本与多行文本都在树中保存；折叠、缩放和视图选择属于本机展示状态。

新增导图沿用 notes 表现有 kind/content/schema_version、分组外键、版本号和删除标记，不需要改写已有普通笔记或升级数据库表。导图与普通笔记使用相同的保存队列、事务和本地生命周期。界面根据文档类型按需加载对应编辑器。

## 附件

`import_image` 接收名称和字节，检查大小与文件签名，生成随机 ID，并保存到专用附件目录；文件名由程序生成，原名称不参与路径构造。`resolve_image` 根据数据库 ID 查询文件路径，宿主把它映射为 WebView 可读地址。

Windows 使用 `import_image_bytes` 的二进制 IPC，名称通过编码后的 `x-file-name` 头传递，避免把图片膨胀成 JSON 数字数组。Android 的 Tauri 请求体不支持同一套二进制传输，所以保留 JSON 命令；鸿蒙宿主后续可以在 `AttachmentStore` 后接入平台二进制通道。文件大小在读取前和原生接收后分别限制，防止过大图片阻塞窗口。

正文的 image 节点只携带 `attachmentId`、`alt`。节点视图按 ID 解析图片地址，地址不写回文档。因此迁移到其他设备时只需保持附件 ID 并传输文件。

后续同步先上传附件再提交引用它的文档，下载时允许文档先显示附件占位。需要保存上传队列与下载状态；正文是否已同步和附件是否完整应分别表达。附件不可按单设备当前引用立即永久回收，还需考虑 tombstone、历史版本和离线设备。

## 跨端接入

- Windows：Tauri IPC + Rust 存储，关闭窗口前等待保存。
- Android：复用 Web 资源与 Tauri 核心，原生工程位于 `src-tauri/gen/android`；文件选择、系统返回键、后台保存接入原生生命周期。手机使用列表与编辑器单页导航。
- HarmonyOS：`platforms/harmonyos` 的 ArkTS + ArkWeb 宿主加载打包 Web 资源，以 `inspNative.postMessage` 请求 ID 和 `__inspBridgeResponse` 回调实现异步命令；ArkData 管理分组、笔记和附件，资源拦截器只映射打包资源及应用附件。暂停和退出通过 `__inspBeforeClose` 提交保存。

不要把 Tauri 的 `convertFileSrc` 地址直接用于鸿蒙。ArkWeb 的资源拦截器应只服务应用附件目录，不开放任意文件读取。宿主暂停/退出前调用前端的保存入口；不能依赖 JS 定时器在后台持续执行。

## 同步契约

`src/sync/contracts.ts` 定义协议类型，没有运行中的同步引擎、账号服务或加密实现。

`SyncTransport.push` 使用 `operationId` 做幂等提交，以 `baseRevision` 进行版本比较。服务端在一个事务中分配实体新 revision 和账号内单调递增 sequence；相同操作重试返回已有结果。版本不一致返回冲突，客户端保留双方内容并建立冲突副本，不按客户端时间戳静默覆盖。

`pull(cursor)` 返回按 sequence 排序的变更与 nextCursor。分页游标和本地应用变更必须一起提交；网络请求不置于数据库事务内。长时间离线设备若超出变更保留窗口，需重新下载当前快照并协调尚未提交的本地编辑。

删除作为可同步 tombstone 传播。已经同步的笔记切换为 localOnly 时，需要一个服务端确认的撤销同步操作，阻止旧设备继续上传该实体，再按产品策略处理远端副本。

`sync_outbox`、`sync_state` 是空表预留。实现加密后才允许上传：标题、正文、分组名称和附件内容均应进入密文信封；协议暴露必要的路由 ID、版本和序号等元数据。

## 隐私边界

`VaultCrypto` 只是加密/解密/锁定接口，不具备安全性承诺。后续使用经过审查的认证加密与 Argon2id 实现，规定 nonce、AAD、密钥封装、恢复密钥及跨端编码格式，再启用 `private`。

私密空间使用独立密钥；Windows 安全存储、Android Keystore、鸿蒙 HUKS 保护设备密钥材料。锁定时同时处理预览、搜索索引、图片解码缓存、临时文件及后台预览。不得仅隐藏组件而继续把私密正文写入明文 SQLite 或普通搜索索引。
