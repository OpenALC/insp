# 拾页 · Insp

[![Build](https://github.com/OpenALC/insp/actions/workflows/ci.yml/badge.svg)](https://github.com/OpenALC/insp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

本地优先的跨端笔记与思维导图：Vue 3 + Tiptap + Tauri + SQLite。Windows 和 Android 共享界面与 Rust 存储；HarmonyOS 通过 ArkTS / ArkWeb 宿主接入共享前端。

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
- 创建思维导图，在列表和思维树之间无损切换；支持主题编辑、增删、排序、缩进、折叠和缩放。
- 富文本标题、粗体、斜体、删除线、链接、列表、待办、引用、代码与撤销重做。
- 通过选择文件、粘贴或拖入本地图片插入附件。
- 新建、重命名、删除分组，将笔记移动到分组。删除分组保留笔记并移入未分组。
- 自动保存；切换笔记和正常关闭窗口前提交待保存内容；失败时展示错误并保留待保存内容。
- 口令保护的本地加密空间，标题、正文、分组、图片与同步配置均加密保存。
- 隐私区需再次验证口令；私密笔记默认仅本机，可逐篇明确开启同步。
- 端到端密文同步、离线编辑、版本冲突副本、取消同步和删除标记。
- SQLite 事务、WAL、软删除与数据库版本迁移。
- 浅色黑字、暗色淡灰字，支持手动选择或跟随系统；使用新的 Inspiration Logo 与绿色主题。

图标源文件为 `src/assets/insp-logo.svg`，在原始图案外使用透明轮廓裁切，保留内部文字和图形。运行 `node scripts/generate-icons.mjs` 可重新生成桌面、Android、HarmonyOS 和网页图标；Android 自适应前景另保留系统裁切所需的安全留白。

桌面端限制为单实例，重复启动聚焦已有窗口，避免多个窗口同时覆盖同一篇笔记。数据库和附件 IO 交给原生工作线程。

仓库的 `.cargo/config.toml` 让 Windows x64 MSVC 目标自动查找 Visual Studio C 编译器，避免本机全局 `CC=gcc` 导致 SQLite 链接失败；不修改系统环境变量。

普通笔记和思维导图共享分组、自动保存与加密仓库；手机采用列表 / 编辑器单页导航。首次启动设置至少 12 个字符的空间口令。已有明文数据先完整加密提交，再清理旧表和原始附件，保留软删除记录；迁移失败不会先删除原数据。

在同步设置中填写自建服务的 HTTPS 地址，复制空间连接码；新设备首次设置时选择「连接已有空间」，输入连接码和同一空间口令。普通笔记默认可同步，私密笔记默认仅本机。口令和解密密钥不上传，忘记口令无法由服务端恢复。

Linux 同步服务的 Docker / Compose 部署、HTTPS 代理和备份见 [server/README.md](server/README.md)。本机及局域网联调支持 HTTP；公网地址必须使用 HTTPS。

## 数据与备份

Windows 数据目录：`%APPDATA%\com.insp.notes\`。

```text
notes.sqlite3        空间密钥头部、笔记/分组/图片/同步配置密文
notes.sqlite3-wal    SQLite 写入日志，运行中可能存在
notes.sqlite3-shm    SQLite 共享内存文件，运行中可能存在
attachments/         旧版明文附件目录，迁移成功后清理
```

关闭应用后备份整个数据目录。不要在应用运行时只复制主数据库文件；不要通过网盘同步正在使用的数据库。

正文使用带 `schemaVersion` 的 Tiptap JSON，图片节点只保存 `attachmentId` 与替代文字。文档和附件作为独立密文记录写入 SQLite；图片解密为内存 Blob URL 显示，不把明文临时图片写回磁盘。移动原始图片不影响笔记。

支持 PNG、JPEG、GIF、WebP，单张最多 20 MB，按文件签名识别格式。附件按需读取和解密；当前保留原图，没有缩略图流水线或自动清理孤立附件。

本地密文使用 AES-256-GCM，每条记录独立随机 nonce，并将空间与记录 ID 纳入认证数据。随机数据密钥经 PBKDF2-HMAC-SHA256（600,000 次）派生的口令密钥封装；锁定会释放密钥引用、解密对象与图片 URL。旧版明文备份不会被自动改写。

取消同步会向服务端提交删除标记，同时保留本机笔记；离线时在下次成功同步后完成撤销。已下载到其他设备的数据和既有备份不能靠取消同步保证安全擦除。删除笔记保留加密的软删除记录，目前没有回收站界面。强停或断电仍可能丢失尚未提交的最近输入。

## 项目结构

```text
src/
  App.vue                  笔记、分组和保存生命周期
  components/              富文本编辑器与图片节点
  domain/mindmap.ts        思维树的稳定节点模型
  domain/models.ts         文档、仓库、附件与平台能力契约
  platform/native.ts       原生命令传输类型
  security/                密钥封装、加密仓库与同步状态机
  platform/tauri.ts        Windows / Android 宿主与生命周期
  platform/harmonyos.ts    ArkWeb 平台适配
  platform/harmonyos-host.ts  原生请求回调与保存桥接
  sync/contracts.ts        密文信封、增量同步、冲突与密钥接口
src-tauri/
  src/storage.rs           SQLite 与附件存储
  src/lib.rs               Tauri IPC 命令
  migrations/              数据库迁移
docs/architecture.md       扩展边界与同步协议约定
platforms/harmonyos/       ArkTS 宿主、ArkData 存储与 HAP 工程
platforms/android/         Android 开发说明（原生工程在 src-tauri/gen/android）
server/                   Linux 密文同步服务、协议测试与 Docker 部署
```

构建检查：`npm run build`；原生编译检查：在 `src-tauri` 下执行 `cargo check`。

Android 开发与构建见 [platforms/android/README.md](platforms/android/README.md)，鸿蒙见 [platforms/harmonyos/README.md](platforms/harmonyos/README.md)。CI 任务与产物见 [docs/ci.md](docs/ci.md)。

## 开源协议

[MIT](LICENSE) © 2026 OpenALC contributors。
