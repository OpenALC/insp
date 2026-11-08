# 加密、同步与平台边界

## 本地加密仓库

界面通过 `WorkspaceRepository` 和 `AttachmentStore` 访问 `EncryptedWorkspace`。共享层使用 WebCrypto 加解密；Windows/Android 的 Rust SQLite 和 HarmonyOS 的 ArkData 只保存不透明密文记录。原生命令包括 `vault_header`、`vault_list`、`vault_get`、`vault_commit` 和首次迁移使用的 `vault_legacy_export`。

每个空间随机生成 256 位数据密钥。口令经 PBKDF2-HMAC-SHA256（600,000 次、随机 16 字节盐）派生封装密钥，以 AES-256-GCM 包裹数据密钥。标题、正文、预览、分组、附件内容和同步凭据都经过认证加密；每次写入使用独立随机 96 位 nonce，AAD 绑定格式版本、空间 ID 和记录 ID。数据密钥以不可导出的 CryptoKey 留在解锁进程中，口令不持久化。

`note:`、`group:`、`attachment:` 记录和加密的 `$meta` 写入同一原生事务。`$meta` 保存本地版本、待提交操作、远端版本、游标和同步配置；不能将明文配置、正文或令牌放进浏览器 localStorage。localStorage 只用于非敏感外观偏好。

附件单张最多 20 MB，按文件签名识别 PNG/JPEG/GIF/WebP。图片按需读取密文并解密为内存 Blob URL；锁定撤销 URL、释放密钥引用和解密缓存。正文节点只引用 attachmentId，不保存设备路径、明文图片或临时 URL。图片密文不会在启动时全部加载。

首次设置导出旧版分组、全部笔记（含软删除）和附件，完成加密并提交后才清理旧表、WAL 和托管明文附件。迁移失败保留原数据；外部旧备份不由应用改写。Rust schema v2 加入 vault_header/secure_records；HarmonyOS 使用对应 ArkData 表。数据库文件及备份仍须作为完整空间保存。

## 隐私模式

每次启动解锁空间，进入隐私区再次验证同一空间口令。普通笔记与隐私笔记共享空间数据密钥。隐私区关闭时，普通列表、搜索和计数不展示私密正文；锁定时卸载编辑器、清空快照与搜索。当前使用手动锁定，不承诺操作系统截图限制或独立硬件密钥库保护。

普通笔记默认允许同步，私密笔记默认 localOnly。普通笔记改为私密时同步自动关闭；随后只有用户明确开启才能上传。同步策略是笔记级设置，首次发布的附件和分组由可同步笔记的引用集合决定。撤销附件前检查其他同步引用；分组的删除由明确的删除分组操作触发。不会因为某篇私密笔记引用了一张图片，就自动上传该笔记的其他信息。

取消同步通过远端删除标记撤销，并保留本机副本；离线时在恢复同步后完成。删除操作必须来自本机明确删除或撤销同步的持久化意图，不能仅凭当前本地未包含某条记录就向远端删除；接收远端变更不产生新的本机删除意图。已下载的副本、软删除记录和既有备份不能依靠取消同步保证安全擦除。口令和解密密钥不发送到服务端，也没有口令恢复或密钥托管服务。

## 密文同步协议

Linux 服务为独立 Rust/Axum/SQLite 应用，Docker 以非 root 用户运行。客户端用随机高熵 capability token 访问指定空间；服务仅保存令牌哈希、封装后的密钥头部、最新密文记录、版本及幂等收据。

- `PUT /v1/spaces/{id}` 创建空间；已存在时验证凭据并返回原头部，不覆盖密钥。
- `GET /v1/spaces/{id}` 获取空间头部，新设备以连接码和空间口令加入。
- `POST /v1/spaces/{id}/push` 按 baseRevision 执行 CAS，在同一事务分配 revision 和空间内 sequence。operationId 重试返回已有结果；重用同一 ID 提交不同内容会失败。
- `GET /v1/spaces/{id}/changes?cursor=...&limit=...` 按 sequence 分页返回最新记录和 tombstone。每页应用结果和游标一起提交本地密文事务。

附件先于分组和笔记上传。服务端每条实体只保留最新记录，删除时移除其当前密文 payload，并保留版本，防止旧客户端按过期 baseRevision 复活数据。请求限 64 MiB、100 条操作，客户端逐条发送大附件。

客户端在本地编辑后短暂合并同步，进入前台、恢复网络及前台定时刷新时获取远端变化，也可手动同步。网络失败保留已加密的待提交操作。应用远端变更前先提交编辑器草稿，期间暂停编辑，完成后刷新，避免覆盖未保存输入。冲突保留远端当前版本和本机 localOnly 冲突副本，不按设备时间静默覆盖。

公网同步要求 HTTPS；HTTP 仅供回环和局域网联调。网络请求经 Rust reqwest 或 HarmonyOS NetworkKit 完成，使用系统 TLS 校验，禁止重定向转发凭据；网络期间不持有本地 SQLite 事务。

## 文档与平台

普通笔记使用 Tiptap JSON；思维导图使用稳定 ID 的 `{ type: 'mindmap', root: { id, text, children } }`。列表和思维树操作同一数据，不经 Markdown/HTML 转换。视图、折叠和缩放是本机呈现状态。

Windows/Android 使用 Tauri IPC，HarmonyOS 用 ArkWeb request ID 和回调桥接。三端共享加密和同步格式。平台退出前等待保存和图片导入；不能依赖后台 JS 定时器持续运行。浅色文字为黑色，暗色为淡灰色，外观可跟随系统或手动选择。

解锁期间应用进程可访问明文；备份恢复、访问凭据保护和 HTTPS 部署由空间所有者管理。
