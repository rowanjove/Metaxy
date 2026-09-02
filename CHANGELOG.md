# 更新日志

本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [2.0.2] - 2026-09-02

### 品牌图标

- 重新设计“之间门 / Metaxy”矢量图标，以相向的双门框、中央通道和字母 `M` 轮廓表达品牌含义。
- 优化图标在浏览器标签、桌面导航栏和移动端小尺寸场景下的辨识度。
- 更新桌面端、移动端和内容详情页真实截图。
- 将导航栏装饰性图标改为空替代文本，避免辅助技术重复朗读相邻品牌名。

[2.0.2]: https://github.com/rowanjove/metaxy/releases/tag/v2.0.2

## [2.0.1] - 2026-09-01

### 品牌更新

- 中文名正式更名为“之间门”，英文名正式更名为“Metaxy”。
- 更新网页标题、中英文界面、管理后台、默认站点设置、文档、截图、包名和 Worker 名称。
- GitHub 仓库迁移至 `rowanjove/metaxy`。
- 新增设置迁移，仅将仍为旧默认值 `PocketRelay` 的站点名改为“之间门”，不会覆盖用户自定义站点名。
- 新客户端键、Cookie 和上传 Header 使用 `metaxy` 命名，并兼容、迁移旧版浏览器状态与 Header。

[2.0.1]: https://github.com/rowanjove/metaxy/releases/tag/v2.0.1

## [2.0.0] - 2026-09-01

### 新增

- 文本与最多 10 个文件可在同一个中转任务中发送。
- 文件通过短期 R2 Presigned PUT 直传，完成后固化到独立正式对象。
- 大文本自动在 D1 与 Private R2 之间分层存储。
- 提取码、分享链接、二维码、中英文界面和亮暗主题。
- 管理后台、iOS 快捷指令接口、运行状态与就绪检查接口。
- D1 实时过期判断与 Cron 两阶段清理。

### 安全与可靠性

- 上传重试复用原文件记录，避免遗留永久 pending 条目。
- 隔离上传对象与正式对象，预签名 URL 重放不能覆盖已提交文件。
- 上传完成、文本写入和提交过程加入并发状态保护。
- 下载时验证实际 GET 对象的大小与 ETag。
- 管理员单设备退出会立即撤销对应 Session；Bearer 客户端不依赖浏览器 CSRF Header。
- 快捷指令、上传、登录和提取路径均接入限流。
- 清理任务加入预签名过期等待、失败退避、公平排序和孤儿对象队列。
- 部署前校验示例资源 ID、CORS、签名有效期与误提交的密钥文件。

### 不兼容变更

- v2 使用新的 `drops`、`drop_items`、`files`、`settings`、`admin_sessions` 和
  `object_deletions` 数据模型；旧版 `cards` 数据不会自动转换。
- 确认 v2 部署及数据备份无误前，不要执行 `release/0003_remove_v1.sql`。

[2.0.0]: https://github.com/rowanjove/metaxy/releases/tag/v2.0.0
