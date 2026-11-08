# HarmonyOS 接入预留

当前没有 ArkTS 工程、HAP 或可运行的鸿蒙宿主。目标为原生 HarmonyOS/NEXT。

使用 ArkTS 页面 + ArkWeb 加载 `npm run build` 产生的本地资源。平台入口分别导出 `createHarmonyAdapter(host)` 的实例，以及绑定宿主的 `registerHarmonyCloseGuard` 作为 `registerCloseGuard`；宿主实现 `src/platform/harmonyos.ts` 的 `HarmonyHostBridge`。App 和编辑器的导入接口保持一致。

请求方法是与 Windows 相同的 `load_workspace`、`get_note`、`create_note`、`save_note`、`delete_note`、`create_group`、`rename_group`、`delete_group`、`import_image`、`resolve_image`。参数对象字段采用 camelCase，返回值为 JSON，失败必须拒绝 Promise。

ArkTS 宿主通过 WebMessagePort 或请求 ID + JS 回调实现 Promise 请求响应，原生数据库侧需提供同等事务和迁移语义。图片资源通过宿主拦截映射，只允许应用附件目录；文档仍只保存 attachmentId。Vue/编辑器不依赖 Tauri API，只有平台入口依赖宿主。

后续需实机处理中文组合输入、选区、键盘、图片导入、生命周期保存与 HUKS。当前 Windows 窗口关闭保存事件需要替换为鸿蒙宿主的生命周期事件。
