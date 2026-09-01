# PocketRelay — Private cross-device content relay

[简体中文](README.md) | [English](README.en.md)

PocketRelay is a self-hosted Cloudflare Workers application for sending text, links, code snippets, and images from your phone to your computer. Workers serves the frontend and API, D1 stores active cards, R2 stores images, and the browser creates encrypted archives.

This is a short-term content relay, not a store that encrypts everything end-to-end from creation: **active content is stored as plaintext on the server; client-side encryption applies to archives.**

[Source and issue tracker](https://github.com/rowanjove/pocket-relay/issues) · [Configuration](wrangler.jsonc)

## Features and retention

- Push text, links, code, and images from the web UI; preview, enlarge, and delete images.
- Send text or links from iOS Shortcuts through a dedicated HTTP endpoint.
- Fetch link titles on a best-effort basis, retaining the original link if fetching fails.
- Enter a cooling state after 24 hours by default; archive or delete after 72 hours through scheduled cleanup.
- Generate archives in the browser with PBKDF2 and AES-256-GCM; backfill encrypted material for active cards after enabling an archive password.
- Optionally protect the site with an access password.

The default cleanup runs hourly, so expiry is not an exact deletion time. Content without encrypted archive material is deleted when due; images with incomplete encrypted material are also deleted. Do not use this as your only backup.

## Local development

Requires Node.js, npm, and a runtime compatible with the locked Wrangler version.

```powershell
git clone https://github.com/rowanjove/pocket-relay.git
cd pocket-relay
npm ci
Copy-Item .dev.vars.example .dev.vars
```

Set your own random values in local `.dev.vars`; do not keep example values:

```dotenv
SHORTCUT_TOKEN=REPLACE_WITH_A_LONG_RANDOM_TOKEN
APP_ACCESS_TOKEN=REPLACE_WITH_A_DIFFERENT_RANDOM_TOKEN
```

`SHORTCUT_TOKEN` protects the shortcut endpoint. `APP_ACCESS_TOKEN` protects the website and regular API; leaving it unset disables site-wide access protection. For the browser's Basic Auth prompt, use any username and enter `APP_ACCESS_TOKEN` as the password.

```bash
npm run db:migrate:local
npm run dev
```

Open the local address printed by Wrangler. These steps use locally simulated resources; do not accidentally run remote migrations for local development. Local and deployed secrets are configured separately; see the [Workers secrets documentation](https://developers.cloudflare.com/workers/configuration/secrets/).

## Deploy to your Cloudflare account

These steps create cloud resources, modify a remote database, and publish a Worker. Confirm the target account first and back up an existing instance before applying migrations.

```bash
npx wrangler login
npx wrangler d1 create pocket-relay
npx wrangler r2 bucket create pocket-relay-images
```

Edit `wrangler.jsonc`:

- Replace the D1 placeholder `database_id` with the created database ID and handle `preview_database_id` for your own preview environment.
- Match the database and R2 bucket names to your resources.
- Replace `drop.example.com` with a domain you manage, or remove the example `routes` configuration to use workers.dev only.
- Review retention periods, the image size limit, and the Cron schedule.

Set deployed secrets, apply database migrations, and deploy:

```bash
npx wrangler secret put SHORTCUT_TOKEN
npx wrangler secret put APP_ACCESS_TOKEN
npm run db:migrate:remote
npm run deploy
```

Use the actual address printed by Wrangler, not the example domain. Workers, D1, and R2 costs depend on usage, account, and enabled services. Free allowances are not a guarantee of zero cost; see pricing for [Workers](https://developers.cloudflare.com/workers/platform/pricing/), [D1](https://developers.cloudflare.com/d1/platform/pricing/), and [R2](https://developers.cloudflare.com/r2/pricing/).

## iOS Shortcuts request

Configure a Get Contents of URL action with your HTTPS address and the following request. Prefer a header token so it does not appear in URL history or query logs:

```http
POST /api/shortcut/push
Authorization: Bearer YOUR_SHORTCUT_TOKEN
Content-Type: application/json

{"content":"https://developers.cloudflare.com/"}
```

The endpoint also accepts `text/plain`, the `x-pocketrelay-token` header, and the compatibility query parameter `?token=...`. It validates `SHORTCUT_TOKEN` separately rather than using the website access password.

## Privacy and limitations

- Active text and image originals are stored in D1/R2. Enabling an archive password does not immediately remove active plaintext.
- The archive password stays in the current page's memory and must be re-entered after a refresh.
- Expiry cleanup removes active plaintext from the application and archives or deletes content according to available encrypted material. This is not a guarantee of immediate erasure from cloud platform backups.
- Shortcut pushes do not generate browser-side archive material themselves. Backfill them through the website to retain encrypted archives.
- Basic Auth is a simple personal access gate, not a multi-user permission system. Stronger identity management requires separate design.
- Never commit `.dev.vars`, API Tokens, access passwords, or real shortcut tokens.

## Structure and validation

- `public/`: static pages, styles, and browser encryption.
- `src/index.ts`: Worker API, authorization, and scheduled cleanup.
- `migrations/`: D1 database migrations.
- `wrangler.jsonc`: bindings, domains, and retention configuration.

Run `npm run typecheck` before submitting changes. The repository currently has no automated test script; type checks do not replace deployment acceptance tests.

## Roadmap and license status

Planned work includes an importable iOS shortcut, manual expiry-archive controls, Cloudflare Access integration notes, and more detailed environment configuration. These are not delivered capabilities.

The repository currently has no separate LICENSE file. This documentation does not add or imply a license for use, modification, or redistribution.
