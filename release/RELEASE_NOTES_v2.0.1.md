# 之间门 / Metaxy v2.0.1

本次修正版完成正式品牌更名：中文名为“之间门”，英文名为“Metaxy”。

## 更新内容

- 中文界面、默认站点名与中文文档统一使用“之间门”。
- 英文界面、包名、Worker 名称与英文文档统一使用“Metaxy”。
- GitHub 仓库更名为 `rowanjove/metaxy`，旧仓库链接由 GitHub 自动重定向。
- 更新桌面端、移动端和提取页真实截图。
- 新增 `0004_metaxy_brand.sql`：只迁移仍使用旧默认品牌的站点，不覆盖管理员自定义名称。
- Cookie、本地存储键和上传 Header 切换到新品牌命名，同时保留旧版本兼容读取。

## 兼容性

- 已存在的 D1、R2 名称可以继续保留，无需为了品牌更名迁移数据。
- 旧 `X-PocketRelay-Upload-Token` Header、浏览器本地设置和管理员 Cookie 仍可兼容使用，并会逐步迁移到新键。
- 本版不改变 v2 API 路径和数据模型。

## 验证

- TypeScript、单元/集成测试、Workerd/D1 测试、Playwright E2E 和生产构建全部通过。
- Release 源码包不包含本地 Secret、`.dev.vars`、构建缓存或 Wrangler 状态。
