# 拾页 · Insp

本地优先的跨端富文本笔记项目。当前实现 Windows 桌面端：Vue 3 + Tiptap + Tauri + SQLite。

## 运行

需要 Node.js 22.12+、Rust stable MSVC、Visual Studio C++ Build Tools / Windows SDK 和 Microsoft Edge WebView2 Runtime。

```powershell
npm ci
npm run desktop
```

构建 Windows NSIS 安装包：

```powershell
npm run desktop:build
```

产物位于 `src-tauri/target/release/bundle/nsis/`。只构建可执行文件：

```powershell
npm run tauri -- build --no-bundle
```

`npm run dev` 只启动 Web 资源开发服务器。当前持久化通过 Tauri 原生接口完成，请在桌面窗口中使用；没有浏览器 localStorage 降级模式。

## 当前功能

- 新建、编辑、删除普通笔记，按最近修改时间排列，标题与摘要搜索。
- 富文本标题、粗体、斜体、删除线、链接、列表、待办、引用、代码与撤销重做。
- 通过选择文件、粘贴或拖入本地图片插入附件。
- 新建、重命名、删除分组，将笔记移动到分组。删除分组保留笔记并移入未分组。
- 自动保存；切换笔记和正常关闭窗口前提交待保存内容；失败时展示错误并保留待保存内容。
- SQLite 事务、WAL、本地独立附件文件、软删除与数据库版本迁移。

桌面端限制为单实例，重复启动聚焦已有窗口，避免多个窗口同时覆盖同一篇笔记。数据库和附件 IO 交给原生工作线程。

仓库的 `.cargo/config.toml` 让 Windows x64 MSVC 目标自动查找 Visual Studio C 编译器，避免本机全局 `CC=gcc` 导致 SQLite 链接失败；不修改系统环境变量。

本版仅实现普通笔记、平级分组和本地存储。思维导图、加密私密空间、Android/HarmonyOS 安装包和联网同步尚未实现。数据库中的 `privacy`、`sync_policy` 等字段是后续数据模型预留，当前没有启用这些功能的 UI。

## 数据与备份

Windows 数据目录：`%APPDATA%\com.insp.notes\`。

```text
notes.sqlite3        笔记、分组、附件元数据
notes.sqlite3-wal    SQLite 写入日志，运行中可能存在
notes.sqlite3-shm    SQLite 共享内存文件，运行中可能存在
attachments/         应用管理的图片副本
```

关闭应用后备份整个数据目录。不要在应用运行时只复制主数据库文件；不要通过网盘同步正在使用的数据库。

正文保存为带 `schemaVersion` 的 Tiptap JSON，图片节点只保存 `attachmentId` 与替代文字，不保存设备路径、临时 URL 或 Base64。图片被复制进应用目录，移动原始图片不影响笔记。

支持 PNG、JPEG、GIF、WebP，单张最多 20 MB。原生侧根据文件内容判断格式，阻止活动内容和过大的 IPC 附件；WebView 仅能读取本应用附件目录。当前保留原图，没有缩略图流水线或自动清理孤立附件。

当前所有笔记均为 `normal + localOnly`，正文和附件未加密，不会上传。删除笔记使用 `deleted_at` 保留记录，当前没有回收站界面；分组删除立即生效。自动保存采用短暂合并窗口，强制结束进程或突然断电仍可能丢失尚未提交的最近输入。

## 项目结构

```text
src/
  App.vue                  笔记、分组和保存生命周期
  components/              富文本编辑器与图片节点
  domain/models.ts         文档、仓库、附件与平台能力契约
  platform/native.ts       共用原生命令到业务接口的适配
  platform/tauri.ts        Windows / 后续 Android 宿主
  platform/harmonyos.ts    ArkWeb 宿主桥接契约与适配工厂
  sync/contracts.ts        密文信封、增量同步、冲突与密钥接口
src-tauri/
  src/storage.rs           SQLite 与附件存储
  src/lib.rs               Tauri IPC 命令
  migrations/              数据库迁移
docs/architecture.md       扩展边界与同步协议约定
platforms/                 Android、HarmonyOS 接入说明
server/                   Linux 同步服务边界说明
```

构建检查：`npm run build`；原生编译检查：在 `src-tauri` 下执行 `cargo check`。
