# PocketRelay v2

[简体中文](README.md) | [English](README.en.md)

私人跨设备内容中转站。复制一下，换台设备，输入提取码，拿走。

PocketRelay v2 是基于 Cloudflare Workers 单 Worker 架构（API + Static Assets + Cron）构建的极简中转工具，使用 D1 保存元数据、Private R2 存储文件及大文本。

![PocketRelay 桌面端首页](docs/screenshots/home.png)

<details>
<summary>查看更多界面截图</summary>

| 移动端首页 | 提取内容 |
|---|---|
| ![PocketRelay 移动端首页](docs/screenshots/home-mobile.png) | ![PocketRelay 提取页](docs/screenshots/drop-detail.png) |

</details>

## 特性

- **文本与多文件同批中转**：支持一段文本（最高 5 MiB）与最多 10 个文件（单个最高 50 MiB，总量最高 500 MiB）。
- **浏览器 R2 直传**：文件通过短期 Presigned PUT URL 直接上传 Private R2 隔离区。
- **安全固化**：Worker 校验隔离对象后将其固化为独立正式对象，旧上传链接无法覆盖已提交文件。
- **大文本分层存储**：不超过 1 MiB 的文本存入 D1，更大的文本存入 Private R2。
- **随机提取码**：默认六位，可配置为 5–8 位；支持分享链接与二维码。
- **实时过期判断**：过期内容立即返回 410，不依赖定时任务是否已执行。
- **双模式权限**：支持公开上传或上传口令；公开模式默认阻断危险脚本与可执行文件。
- **iOS 快捷指令接口**：使用 Bearer Token 一键推送文本。
- **管理后台**：支持 Session 登录、总览统计、延期、失效、删除和系统设置。
- **自动清理**：每分钟分批处理未提交草稿、过期内容、失效记录和孤儿对象。
- **原生前端**：Vite + TypeScript + CSS，支持中英文、亮暗主题和移动端布局。

## 架构

```text
浏览器
  ├─ 页面与静态资源 ───────────────> Worker Static Assets
  ├─ 元数据、文本、认证、提取 ─────> Hono Worker API
  └─ 文件二进制 ── Presigned PUT ──> Private R2 隔离上传区

Hono Worker
  ├─ D1：Drops、Files、DropItems、Settings、AdminSessions、ObjectDeletions
  ├─ R2：隔离对象校验、正式对象固化、Private 文件和大文本存储
  ├─ aws4fetch：生成最长 300 秒的 Presigned PUT URL
  ├─ Rate Limit：管理登录、上传、快捷指令和提取
  └─ Scheduled Cron：两阶段删除与失败退避
```

## 本地开发

需要 Node.js 及 npm。

```bash
git clone https://github.com/rowanjove/pocket-relay.git
cd pocket-relay
npm ci
cp .dev.vars.example .dev.vars
```

在 `.dev.vars` 中填写仅用于本地开发的值：

```env
ADMIN_PASSWORD=your-local-admin-password
UPLOAD_TOKEN=your-local-upload-token
SHORTCUT_TOKEN=your-local-shortcut-token
R2_ACCESS_KEY_ID=your-r2-s3-access-key-id
R2_SECRET_ACCESS_KEY=your-r2-s3-secret-access-key
R2_ACCOUNT_ID=your-cloudflare-account-id
R2_BUCKET_NAME=pocket-relay-files
```

应用迁移并启动：

```bash
npm run db:migrate:local
npm run check
npm run dev
```

本地与生产 Secret 必须分开配置，不要提交 `.dev.vars`。

## 部署到 Cloudflare

部署会创建或修改云资源。给已有实例升级前，先备份 D1 和 R2。

### 1. 准备资源

```bash
npx wrangler d1 create pocket-relay
npx wrangler r2 bucket create pocket-relay-files
```

将 D1 创建结果中的 `database_id` 写入 `wrangler.jsonc`，并确认 R2 Bucket 名称与配置一致。

### 2. 配置 R2 CORS

把 `cors.json` 中的 `https://drop.example.com` 替换为生产站点的完整 Origin，然后执行：

```bash
npx wrangler r2 bucket cors set pocket-relay-files --file cors.json
```

### 3. 配置生产 Secret

```bash
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put UPLOAD_TOKEN
npx wrangler secret put SHORTCUT_TOKEN
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
npx wrangler secret put R2_ACCOUNT_ID
```

### 4. 迁移与部署

```bash
npm run db:migrate:remote
npm run deploy:dry
npm run deploy
```

`deploy:dry` 会拒绝示例资源 ID、示例 CORS Origin、过长预签名有效期及误提交的密钥文件。

部署后检查 `GET /api/v1/ready`、首页、创建与提取流程以及文件下载。确认 v2 正常且备份可用后，才可按需执行一次性的旧表删除：

```bash
npm run db:remove-v1:remote
```

### 5. R2 生命周期兜底

建议为 Bucket 配置 8 天后删除对象的生命周期规则。应用内最长保留期为 7 天；该规则用于 Cron 或数据库异常时清理孤儿对象，不应短于业务最长保留期。

## iOS 快捷指令请求示例

```http
POST /api/shortcut/push
Authorization: Bearer YOUR_SHORTCUT_TOKEN
Content-Type: application/json

{"content":"https://developers.cloudflare.com/","expiresInSeconds":86400}
```

也支持 `text/plain` 请求体。令牌只能放在 Authorization Header 中，不支持 URL 查询参数。

## API 概览

| 方法 | 路径 | 说明 | 权限要求 |
|---|---|---|---|
| `GET` | `/api/v1/health` | 进程健康检查 | 公开 |
| `GET` | `/api/v1/ready` | 数据库、绑定和 Secret 就绪检查 | 公开 |
| `GET` | `/api/v1/meta` | 站点元数据与容量限制 | 公开 |
| `POST` | `/api/v1/drops` | 创建中转草稿 | 由上传模式决定 |
| `PUT` | `/api/v1/drops/:dropId/text` | 写入或替换草稿文本 | Draft Token |
| `POST` | `/api/v1/uploads/prepare` | 申请文件直传 URL | Draft Token |
| `POST` | `/api/v1/uploads/complete` | 校验隔离上传并固化对象 | Draft Token |
| `POST` | `/api/v1/drops/:dropId/commit` | 提交并生成提取码 | Draft Token |
| `GET` | `/api/v1/drops/:code` | 获取中转内容 | 提取码 |
| `GET` | `/api/v1/files/:fileId/content` | 下载文件或预览图片 | 有效 Drop |
| `POST` | `/api/shortcut/push` | iOS 快捷指令推送 | Bearer Token |
| `POST` | `/api/v1/admin/login` | 管理员登录 | 管理密码 |
| `POST` | `/api/v1/admin/logout` | 撤销当前 Session | 管理 Session |
| `POST` | `/api/v1/admin/logout-all` | 撤销全部 Session | 管理 Session |

## 隐私与限制

- 有效期内的文本和文件保存在服务端，不是端到端加密存储。
- 提取码用于临时分享，不应视为高强度访问控制或唯一备份。
- Presigned URL 在过期前属于 Bearer 凭据；客户端不应记录或转发它。
- 删除是应用层异步流程，不代表云平台备份会在同一时刻完成物理擦除。
- 不要提交 `.dev.vars`、API Token、账户凭据或真实快捷指令令牌。

## 版本与许可

- [更新日志](CHANGELOG.md)
- [v2.0.0 发布公告](release/RELEASE_NOTES_v2.0.0.md)
- [MIT License](LICENSE)
