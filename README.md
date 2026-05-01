# PocketRelay

私人跨设备内容中转站。把手机上的文字、链接、代码片段和图片，快速、安全地推到电脑面前。

PocketRelay 是一个自部署的 Cloudflare Workers 应用：前端、API、定时任务、D1 数据库和 R2 图片存储都在 Cloudflare 免费套餐能力内运行。历史归档采用客户端加密，服务端只保存密文材料。

English: PocketRelay is a self-hosted cross-device content relay for sending text, links, code snippets, and images from your phone to your desktop. It runs on Cloudflare Workers, D1, and R2, with client-side encrypted archives.

## 功能特性 / Features

- 网页端快速推送文本、链接、代码和图片
- iOS Shortcuts 专用无 UI 推送入口
- 链接标题最佳努力抓取
- 图片上传到 R2，活跃区可查看、放大和删除
- 24 小时后进入冷却态，72 小时后自动归档或删除
- 客户端 `PBKDF2 + AES-256-GCM` 加密归档
- 启用归档密码后，会给现有活跃卡片补生成归档密文
- 可选全站访问口令，避免知道链接的人直接打开

English:
- Push text, links, code, and images from the web UI
- Dedicated no-UI endpoint for iOS Shortcuts
- Best-effort link title preview
- R2-backed image upload and preview
- Cooling state after 24 hours, archive/delete after 72 hours
- Client-side encrypted archives with `PBKDF2 + AES-256-GCM`
- Archive material backfill for existing active cards after enabling an archive password
- Optional site-wide access password via Worker secret

## 架构 / Architecture

```text
public/              Static frontend
  index.html
  styles.css
  app.js
src/
  index.ts           Cloudflare Worker API, scheduler, auth, archive cleanup
migrations/
  0001_initial.sql   D1 schema
wrangler.jsonc       Worker bindings and deployment config
```

数据流：

1. 活跃卡片保存在 D1，图片原图保存在 R2。
2. 如果页面内存里有归档密码，浏览器会在推送或补档时生成归档密文。
3. 定时任务到期后清除明文内容，只保留可由浏览器解密的密文材料。

English:
1. Active cards live in D1, and image originals live in R2.
2. When an archive password is active in the browser, the client generates encrypted archive material.
3. Scheduled cleanup removes plaintext after retention and keeps only encrypted archive data.

## 隐私和安全 / Privacy And Security

- 归档密码不落盘，只保存在当前页面内存里；刷新后需要重新输入。
- 未启用归档密码时，内容超过保留时间会被永久删除。
- `SHORTCUT_TOKEN`、`APP_ACCESS_TOKEN`、`.dev.vars`、Cloudflare API token 不应提交到仓库。
- 公开仓库只包含示例配置和应用代码，不包含本地 secret。
- Basic Auth 只用于简单个人防护；多人使用或更严格的身份管理建议接 Cloudflare Access。

English:
- The archive password is never persisted by the app; it only stays in page memory.
- Content without archive material is permanently deleted after the retention window.
- Never commit `SHORTCUT_TOKEN`, `APP_ACCESS_TOKEN`, `.dev.vars`, or Cloudflare API tokens.
- This repository should contain application code and example configuration only.
- Basic Auth is a lightweight personal gate; use Cloudflare Access for stronger identity control.

## 本地开发 / Local Development

安装依赖：

```bash
npm install
```

复制本地变量模板：

```powershell
copy .dev.vars.example .dev.vars
```

创建 D1 数据库和 R2 bucket，并把返回的绑定信息写入 `wrangler.jsonc`：

```bash
npx wrangler d1 create pocket-relay
npx wrangler r2 bucket create pocket-relay-images
```

`wrangler.jsonc` 里默认使用占位的 D1 `database_id` 和 `drop.example.com` custom domain。部署前请替换成你自己的 Cloudflare 资源。

设置本地/线上 secret：

```bash
npx wrangler secret put SHORTCUT_TOKEN
npx wrangler secret put APP_ACCESS_TOKEN
```

执行本地迁移并启动：

```bash
npm run db:migrate:local
npm run dev
```

English:
Install dependencies, copy `.dev.vars.example` to `.dev.vars`, create Cloudflare D1/R2 resources, configure secrets, run the local migration, then start Wrangler dev.

## 部署 / Deployment

登录 Cloudflare：

```bash
npx wrangler login
```

远程迁移 D1：

```bash
npm run db:migrate:remote
```

部署 Worker：

```bash
npm run deploy
```

当前配置也支持自定义域名。部署成功后，Wrangler 会显示 `workers.dev` 地址和绑定的 custom domain。

注意：公开仓库里的 `wrangler.jsonc` 不包含真实 D1 ID 或个人域名，请按自己的环境替换占位值。

English:
Log in with Wrangler, apply remote D1 migrations, and deploy with `npm run deploy`. If a custom domain is configured, Wrangler will show it in the deployment output.

## iOS Shortcuts 示例 / iOS Shortcuts Example

快捷指令入口：

```http
POST /api/shortcut/push?token=YOUR_TOKEN
Content-Type: application/json
```

请求体：

```json
{
  "content": "https://developers.cloudflare.com/"
}
```

也可以直接发送 `text/plain`，body 放纯文本。

English: Use the shortcut endpoint with `SHORTCUT_TOKEN`. JSON and plain-text request bodies are both supported.

## 后续计划 / Roadmap

- 可导入的 iOS `.shortcut` 模板
- 手动“立即归档到期内容”的管理按钮
- 可选 Cloudflare Access 集成说明
- 更细的部署模板和环境分层

English:
- Importable iOS `.shortcut` template
- Manual archive-now control
- Optional Cloudflare Access guide
- Cleaner deployment templates and environment separation
