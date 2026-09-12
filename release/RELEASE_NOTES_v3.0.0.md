# 之间门 / Metaxy v3.0.0

Metaxy 3.0 在原有临时中转能力之外，加入长期私人文件空间、WebDAV 多设备访问和独立图片库，同时保留既有 Drop、提取码与 iOS 快捷指令兼容性。

## 主要更新

- 新增一级入口“文件空间”：支持目录、网页直传、预览、搜索、重命名、移动、复制、回收站、临时分享，以及 Drop 与 Drive 双向保存。
- 新增 HTTPS WebDAV：支持独立设备凭据、常用文件方法、Range、锁与并发保护，可供 Windows、iPhone/iPad 和其他 WebDAV 客户端连接。
- 新增 Gallery 图片库：使用独立永久 R2、图片签名校验、去重、Markdown/HTML/BBCode 链接和两阶段删除队列。
- 公共导航继续隐藏管理后台入口；主题切换改为带无障碍标签的图标按钮。

## 存储与安全边界

- Drop 临时对象、Drive 永久文件和 Gallery 图片分别使用独立 R2 Bucket，生命周期互不混用。
- Drive 目录树、设备凭据、WebDAV 锁和删除意图保存在 D1；对象键不使用用户路径。
- WebDAV 使用按设备生成并可单独撤销的凭据，不复用管理密码、上传口令或快捷指令令牌。
- Gallery 上传采用有界读取、Content-Length 校验、允许类型与文件签名双重检查。

## 升级说明

- 新部署需要 D1 迁移 `0005_drive_core.sql`、`0006_drive_dav.sql`、`0007_gallery_core.sql`。
- 需要独立的 `pocket-relay-drive` 与 `pocket-relay-gallery` R2 Bucket，以及 `DRIVE`、`GALLERY` 绑定。
- 浏览器 Drive 直传还需要生产 R2 S3 凭据；Secret 不应写入源码或 Wrangler 配置。
- WebDAV 代理上传上限为 50 MiB；更大的文件应优先通过网页直传。

## 验证

- TypeScript 类型检查和生产构建通过。
- 84 项单元/集成测试、6 项 Workerd/D1 运行时测试通过。
- 4 项 Playwright 端到端测试通过。
- Wrangler 部署前校验、dry-run 和启动分析通过。
- npm 依赖审计未发现漏洞。

设备侧边界：Windows Explorer 挂载和 iPhone/iPad Files 的物理设备验收仍需在对应设备上执行；协议级 OPTIONS/PROPFIND 等能力由自动测试覆盖。
