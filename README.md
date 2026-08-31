# PocketRelay — 私人跨设备内容中转站

[简体中文](README.md) | [English](README.en.md)

PocketRelay 是一个自部署的 Cloudflare Workers 应用，用来把手机上的文字、链接、代码片段和图片发送到电脑。前端和 API 由 Workers 提供，活跃卡片存入 D1，图片存入 R2，浏览器负责生成加密归档。

这是短期内容中转工具，不是所有数据从创建起就端到端加密的存储服务：**活跃内容以明文保存在服务端，归档内容才使用客户端加密。**

[源码与问题反馈](https://github.com/rowanjove/pocket-relay/issues) · [配置文件](wrangler.jsonc)

## 功能与数据保留

- 网页推送文本、链接、代码和图片；支持图片预览、放大和删除。
- iOS Shortcuts 可通过专用 HTTP 入口推送文本或链接。
- 尝试获取链接标题，失败时仍保留原链接。
- 默认 24 小时后进入冷却态，72 小时后由定时任务归档或删除。
- 归档使用浏览器端 PBKDF2 与 AES-256-GCM；启用归档密码后可为已有活跃卡片补生成密文。
- 可配置全站访问口令。

默认定时任务每小时运行一次，所以到期时间不等于精确删除时刻。没有归档密文的内容到期后会删除；图片缺少完整加密材料时也会删除。请勿把它当作唯一备份。

## 本地开发

需要 Node.js、npm，以及满足锁定版本 Wrangler 要求的运行环境。

```powershell
git clone https://github.com/rowanjove/pocket-relay.git
cd pocket-relay
npm ci
Copy-Item .dev.vars.example .dev.vars
```

在本机 `.dev.vars` 中设置自己的随机值，不要保留示例值：

```dotenv
SHORTCUT_TOKEN=REPLACE_WITH_A_LONG_RANDOM_TOKEN
APP_ACCESS_TOKEN=REPLACE_WITH_A_DIFFERENT_RANDOM_TOKEN
```

`SHORTCUT_TOKEN` 控制快捷指令入口；`APP_ACCESS_TOKEN` 控制网页和常规 API 访问。后者未设置时不启用全站访问保护。浏览器 Basic Auth 登录框可填写任意用户名，密码填写 `APP_ACCESS_TOKEN`。

```bash
npm run db:migrate:local
npm run dev
```

打开 Wrangler 输出的本地地址。这里使用本地模拟资源；不要为了本地开发误执行远程数据库迁移。本地与线上密钥分开配置，见 [Workers secrets 文档](https://developers.cloudflare.com/workers/configuration/secrets/)。

## 部署到自己的 Cloudflare 账户

部署步骤会创建云资源、修改远程数据库并发布 Worker。执行前确认目标账户；给已有实例迁移前先备份数据。

```bash
npx wrangler login
npx wrangler d1 create pocket-relay
npx wrangler r2 bucket create pocket-relay-images
```

编辑 `wrangler.jsonc`：

- 将 D1 占位 `database_id` 替换为创建结果，并按自己的预览环境处理 `preview_database_id`。
- 确认数据库名称与 R2 bucket 名称对应自己的资源。
- 将 `drop.example.com` 替换为自己管理的域名；若只使用 workers.dev，移除示例 `routes` 配置。
- 检查保留时间、图片大小限制与 Cron 配置。

然后配置线上密钥、迁移数据库并部署：

```bash
npx wrangler secret put SHORTCUT_TOKEN
npx wrangler secret put APP_ACCESS_TOKEN
npm run db:migrate:remote
npm run deploy
```

以 Wrangler 实际输出的地址为准。不要把示例域名当作可用部署地址。Workers、D1 和 R2 的费用取决于用量、账户及启用的服务；免费额度不代表始终零费用，参见 [Workers](https://developers.cloudflare.com/workers/platform/pricing/)、[D1](https://developers.cloudflare.com/d1/platform/pricing/) 和 [R2](https://developers.cloudflare.com/r2/pricing/) 定价。

## iOS Shortcuts 请求示例

在“获取 URL 内容”动作中，使用自己的 HTTPS 地址与以下请求。推荐把令牌放在请求头，避免写进 URL 历史或查询日志：

```http
POST /api/shortcut/push
Authorization: Bearer YOUR_SHORTCUT_TOKEN
Content-Type: application/json

{"content":"https://developers.cloudflare.com/"}
```

也支持 `text/plain` 请求体、`x-pocketrelay-token` 请求头，以及兼容用的 `?token=...` 参数。快捷指令入口单独检查 `SHORTCUT_TOKEN`，不使用网页访问口令。

## 隐私与限制

- 活跃文本和图片原图存于 D1／R2；启用归档密码不会立即移除这些活跃明文。
- 归档密码仅保存在当前页面内存；刷新后需要重新输入。
- 到期清理会移除应用中的活跃明文，并按已有加密材料归档或删除；这不等于对云平台备份作出即时擦除保证。
- 快捷指令推送不会自行生成浏览器归档材料，需要在网页中补档后才能保留加密归档。
- Basic Auth 适合简单个人访问保护，不是多用户权限系统；更严格的身份管理应单独设计。
- 不要提交 `.dev.vars`、API Token、访问口令或真实快捷指令令牌。

## 结构与验证

- `public/`：静态网页、样式和浏览器加密逻辑。
- `src/index.ts`：Worker API、身份检查和定时清理。
- `migrations/`：D1 数据库迁移。
- `wrangler.jsonc`：绑定、域名和保留策略配置。

提交前运行 `npm run typecheck`。当前仓库没有配置自动化测试脚本，类型检查不能替代部署验收。

## 后续计划与许可状态

计划中的内容包括可导入的 iOS 快捷指令模板、手动到期归档入口、Cloudflare Access 集成说明及更细的环境配置；这些不是已交付能力。

仓库当前未附独立 LICENSE 文件。本次文档不新增或推定使用、修改与再分发许可。
