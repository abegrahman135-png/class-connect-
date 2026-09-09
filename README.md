# ClassConnect

Private classroom communication: teachers are provisioned (no public teacher registration), students join a class with an invitation code, and each class gets a persistent real-time chat with typing, presence, read receipts and attachments.

## Stack

- **Cloudflare Workers** API + **Durable Objects** (real-time rooms, budget guard)
- **Cloudflare D1** (SQLite) with migrations
- **Cloudflare R2** for private attachments (image, PDF, voice notes)
- **Cloudflare Pages** frontend — no bundler; served directly, proxied same-origin to the API (incl. WebSockets) via `frontend/_worker.js`
- **PWA** shell: `frontend/sw.js` + `frontend/manifest.webmanifest` + generated icons

## Layout

```
backend/            Worker API (src/index.js), wrangler.toml, migrations/, tests
frontend/           Pages site: _worker.js proxy, app.js, styles.css, index.html,
                    sw.js, manifest.webmanifest, icons/
scripts/            make-icons.py, provision-teacher.mjs
.github/workflows/  deploy.yml (manual Cloudflare deployment)
```

## Local development

Requires Node 22 and Python 3.

```bash
npm install

# local dev config (gitignored) — matches backend/.dev.vars:
# APP_ORIGIN=http://localhost:8788

npm run db:local        # apply D1 migrations to the local database
npm run dev:api         # API worker on :8787
npm run dev:web         # Pages site on :8788, service-bound to the API
```

Provision a teacher (writes `teacher-seed.sql` + `teacher-credentials.txt` — never commit either):

```bash
npm run teacher -- "Ms. Rahman"
```

Then insert `teacher-seed.sql` into the local D1 database file (`backend/.wrangler/state/v3/d1/.../*.sqlite`) before signing in locally.

Run checks:

```bash
npm test          # 6 validation tests
npm run icons     # regenerate frontend/icons/icon-{192,512}.png
```

## First deployment

```bash
npm install && npm run icons && npm test
npx wrangler login

npx wrangler d1 create classconnect-db
npx wrangler r2 bucket create classconnect-files
npx wrangler pages project create classconnect --production-branch main
```

**Replace the placeholders before deploying:**

- `backend/wrangler.toml` → `database_id` (from `d1 create`) and `APP_ORIGIN` (your Pages hostname, e.g. `https://classconnect.pages.dev`)
- If the Pages project name was unavailable, also update `package.json` (`deploy:web`) and `frontend/wrangler.toml`
- In the Cloudflare dashboard confirm the Pages production environment has the service binding `API` → `classconnect-api`

Apply the schema and provision the teacher:

```bash
npm run db:remote
npm run teacher -- "Ms. Rahman"
npx wrangler d1 execute classconnect-db --remote --config backend/wrangler.toml --file teacher-seed.sql
```

Store the generated recovery key privately, then delete the temporary provisioning files.

Deploy:

```bash
npm run deploy:api
npm run deploy:web
```

The GitHub Actions workflow `.github/workflows/deploy.yml` does the same manually (`workflow_dispatch`) using repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` — use a least-privilege token scoped to Workers, Pages, D1 and the required storage operations.

## What's left / not in this release

**Deliberately disabled — add after the core is deployed and allowances are confirmed:**

- Real-time voice/video calls (TURN / SFU) — no fake call buttons
- Background push notifications
- Student-to-student direct messages

**Remaining work before real student data:**

- Integration + device tests, including: failed D1 write → no false acknowledgement; repeated `clientId` → one saved message; removed member → socket closed and REST denied; rotated invitation → old code rejected; forged MIME / oversized uploads → rejected; logout → later socket operations rejected; reconnect → saved messages reconciled; Android microphone permission denied → recoverable UI
- Verify the Pages service binding (cookie + WebSocket auth) on the actual production hostname
- Check R2 billing conditions in your account; budget alerts are not automatic hard spending stops
- No antivirus scanning: PDFs and attachments must still be treated as untrusted files

**Enforced boundaries (intentional):**

| Control | Limit |
| --- | --- |
| Class membership | 40 students + teacher |
| Live sockets per class | 82 |
| Live sockets per account per class | 2 |
| Message length | 4,000 characters |
| WebSocket events per user per class | 90/minute |
| Attachment size | 5 MiB |
| Uploads per user | 10/day |
| Upload bytes per user | 20 MiB/day |
| Upload bytes across installation | 50 MiB/day |
| Lifetime accepted upload reservations | 512 MiB (does not reset) |
| Message & attachment retention | 30 days |
| Voice recording | 3 minutes |
| Session lifetime | 7 days |
