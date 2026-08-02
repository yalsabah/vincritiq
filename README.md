# VinCritiq

> AI-powered used-car deal analyzer. Upload a CARFAX PDF and a few photos of a vehicle, and VinCritiq returns a structured deal report — pricing vs. market, depreciation curve, financing math, vehicle history flags, an interactive 3D model, and a Great / Good / Fair / Bad verdict.

🌐 **Live site:** [vincritiq.com](https://vincritiq.com)

---

## What it does

- **CARFAX + photo analysis** — parse the report, classify title status, accident count, owner history, and service health.
- **Pricing intelligence** — compare against KBB and market averages; surface % over/under and a structured price story.
- **Financing math** — APR, term, down payment, monthly payment, total interest, total cost.
- **Depreciation curve** — projected 1/3/5-year residual values for the specific year/make/model.
- **Verdict engine** — heavy-flag rules (salvage, frame damage, 4+ owners, etc.) hard-cap the rating; price drives the base case otherwise.
- **Interactive 3D model** — generated once per year/make/model/trim from a vehicle photo via Tripo3D, cached in Cloudflare R2, then re-served instantly to every future user querying the same vehicle.
- **Body-color swatches** — repaint the 3D model in 8 preset colors via shader-injected per-pixel re-hueing.

## Stack

- **Frontend:** React 18 (CRA), Tailwind, Three.js / @react-three/fiber / @react-three/drei
- **Backend:** Cloudflare Pages Functions (`/functions/api/*`)
- **Storage:** Cloudflare R2 (3D model cache), Firebase Storage (vehicle photos)
- **Database & Auth:** Firebase Firestore + Firebase Auth
- **AI:** Anthropic Claude Opus 5 (streaming, multimodal, adaptive thinking)
- **3D pipeline:** Tripo3D image-to-model API → R2 mirror for permanent URLs
- **Hosting:** Cloudflare Pages

---

## Run it locally

### 1. Prerequisites

- Node.js **18+** and npm
- Git
- A Firebase project (free Spark plan is fine for local dev; Blaze required for Storage)
- API keys for: **Anthropic Claude**, **Tripo3D**, optionally **VinAudit** and **Vincario** (VIN decode)

### 2. Clone and install

```bash
git clone https://github.com/<your-org>/vincritiq.git
cd vincritiq/carbot
npm install
```

### 3. Configure environment variables

Create `carbot/.env` (this file is gitignored). The dev proxy in `src/setupProxy.js` reads server-side secrets from this file and proxies them to the real upstream APIs so the browser never sees them.

```bash
# ── Server-side secrets (used by the dev proxy in src/setupProxy.js) ──
CLAUDE_API_KEY=sk-ant-…
AUTODEV_API_KEY=…        # vehicle listings for "Find Me a Car" — see below
TRIPO_KEY=tsk_…
VINAUDIT_KEY=…           # optional — VIN-image lookups
VINCARIO_KEY=…           # optional — VIN decode
VINCARIO_SECRET=…        # optional — VIN decode

# ── Public Firebase web config (baked into the client bundle) ──
REACT_APP_FIREBASE_API_KEY=…
REACT_APP_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
REACT_APP_FIREBASE_PROJECT_ID=your-project
REACT_APP_FIREBASE_STORAGE_BUCKET=your-project.firebasestorage.app
REACT_APP_FIREBASE_MESSAGING_SENDER_ID=…
REACT_APP_FIREBASE_APP_ID=1:…:web:…
REACT_APP_FIREBASE_MEASUREMENT_ID=G-…
```

> Get the Firebase web config from **Firebase Console → Project Settings → General → Your apps → Web app → SDK setup**.

#### Vehicle listings (`AUTODEV_API_KEY`)

"Find Me a Car" searches live US dealer inventory through
[Auto.dev](https://auto.dev)'s Vehicle Listings API. Sign up, copy the key from
the dashboard, and set `AUTODEV_API_KEY`. The Starter tier is free — 1,000 calls
a month, no card — which the panel is built around: searches are debounced,
superseded requests are aborted, and the mileage / source / trim filters refine
the already-fetched page instead of re-querying.

Without the key the panel renders a "listings aren't connected yet" state. It
deliberately does **not** fall back to sample data — showing invented inventory
to someone shopping for a car is worse than showing nothing.

Map pins come from ZIP centroids resolved through
[Zippopotam.us](https://zippopotam.us) (free, no key), cached at the edge; the
"use my location" button reverse-geocodes via BigDataCloud's free client
endpoint. Neither needs configuring.

### 4. Set up Firebase

In the [Firebase Console](https://console.firebase.google.com/):

1. **Authentication** → enable **Email/Password** and **Google** sign-in.
2. **Firestore Database** → create in production mode, then publish these rules (Rules tab):

   ```javascript
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       // Cross-user 3D model cache — slug-keyed, no per-user ownership.
       match /models3d/{slug} {
         allow read, create, update: if request.auth != null;
       }

       // Per-user chat sessions, messages, settings.
       match /users/{uid}/{document=**} {
         allow read, write: if request.auth != null && request.auth.uid == uid;
       }

       // Crash reports — see "Error reporting" below. Create-only from the
       // client; reports are read in the Firebase console, never by the app,
       // so one reporter can't read anyone else's report back out.
       //
       // Anonymous creates are allowed deliberately: crashes hit signed-out
       // users too, and those are often the most useful ones. The field
       // allowlist and size caps are what keep this from being an open write
       // endpoint — enable App Check if it ever gets abused.
       match /errorReports/{id} {
         allow read, update, delete: if false;
         allow create: if request.resource.data.keys().hasOnly([
                            'message','name','stack','componentStack','source',
                            'fingerprint','mode','sessionId','url','userAgent',
                            'viewport','theme','appVersion','occurredAt',
                            'comment','userId','email','status','createdAt'
                          ])
                          && request.resource.data.message is string
                          && request.resource.data.message.size() <= 1000
                          && request.resource.data.stack.size() <= 6000
                          && request.resource.data.comment.size() <= 1000
                          && request.resource.data.status == 'new';
       }
     }
   }
   ```

3. **Storage** (requires Blaze plan) → publish [`storage.rules`](./storage.rules) from this repo.
4. (Optional) **Storage lifecycle** → apply [`storage-lifecycle.json`](./storage-lifecycle.json) via `gsutil` to auto-delete user uploads after 90 days.

### 5. Start the dev server

```bash
npm start
```

Opens [http://localhost:3000](http://localhost:3000). The dev proxy starts automatically and prints a startup banner showing which API keys it loaded — if a key shows `MISSING`, double-check `.env` and restart.

### 6. (Optional) Deploy your own copy

This project deploys to Cloudflare Pages with a connected R2 bucket. Push to your fork, then in the Cloudflare dashboard:

1. Pages → Create project → connect your repo, build command `npm run build`, output `build/`.
2. Settings → Environment variables → add the **server-side secrets** as encrypted Secrets (`CLAUDE_API_KEY`, `AUTODEV_API_KEY`, `TRIPO_KEY`, etc.). The Firebase `REACT_APP_*` values are already in [`wrangler.toml`](./wrangler.toml).
3. R2 → create a bucket named `vincritiq-models`. The binding is declared in `wrangler.toml`.
4. Settings → Custom domains → point your domain at the Pages project.

---

## Error reporting

The app watches for errors it doesn't already handle and offers the user a
one-click "send this to the developer" prompt — the macOS crash-reporter model.
Reports land in Firestore `errorReports/{auto-id}`; read them in the Firebase
console, newest first, and set `status` to something other than `new` as you
triage.

**Nothing is ever sent without an explicit click.** The payload is assembled
locally, shown in full behind "Show what will be sent", and discarded on
"Don't Send".

The part that matters is what *doesn't* prompt. [`src/utils/errorReporter.js`](./src/utils/errorReporter.js)
holds a `KNOWN_BENIGN` list of failures the app already surfaces properly —
aborted searches, offline blips, Claude refusals, listings-API errors,
`ResizeObserver` noise, post-deploy chunk misses. Those are logged and dropped.
Prompting on expected errors is how users learn to dismiss the dialog without
reading it, which costs you the one report that mattered.

On top of that:

- Reports are **fingerprinted** with VINs, ids, hashes, and numbers scrubbed, so
  the same bug on two different vehicles is one fingerprint, not two.
- A given fingerprint re-prompts at most **once per 24h** (`localStorage`).
- At most **2 prompts per page load**, whatever the fingerprint.
- Users can tick **"Don't ask again on this device"**.

**When you add a new expected failure mode, add it to `KNOWN_BENIGN`** — or
call `markHandled(err, 'where')` at the call site. Otherwise it starts nagging
everyone.

Three capture points feed the sensor: `window.onerror`, `unhandledrejection`,
and the top-level `ErrorBoundary` (which offers its own Send Report button,
since a render crash takes the normal prompt down with the rest of the tree).

---

## Available scripts

| Script | What it does |
|---|---|
| `npm start` | Run dev server with proxy on `localhost:3000` |
| `npm run build` | Production build into `build/` |
| `npm test` | CRA test runner (interactive watch) |

## Project layout

```
carbot/
├── src/
│   ├── components/      # ChatInterface, ReportModal, RightSidebar, …
│   ├── contexts/        # Auth + Chat React contexts
│   ├── utils/           # claudeApi, model3d, pricing, pdfParser, …
│   └── setupProxy.js    # Dev-only API key proxy
├── functions/api/       # Cloudflare Pages Functions (production proxy)
│   ├── claude.js
│   ├── models/upload.js # Tripo → R2 mirror
│   ├── tripo/[[path]].js
│   └── vinaudit.js
├── public/
├── storage.rules        # Firebase Storage rules
├── storage-lifecycle.json
├── wrangler.toml        # Cloudflare Pages config + R2 binding
└── tailwind.config.js
```

## Troubleshooting

- **`auth/invalid-api-key` on load** — `REACT_APP_FIREBASE_API_KEY` missing/wrong; restart `npm start` after editing `.env`.
- **`/api/claude` 500** — Claude key missing in `.env` or hit the per-request size limit (the app compresses photos but very large CARFAX PDFs can still tip it).
- **3D model stuck "pending"** — likely Firestore rules don't allow `update` on `models3d/{slug}`. Re-publish the rules above.
- **CORS errors loading GLB** — in dev the Tripo URL is routed through `/dev-glb-proxy`; in prod the GLB must be served from R2 (`MODELS_PUBLIC_BASE` env var must be set in the Cloudflare dashboard).
- **"Client is offline" warning on first load** — benign. Firestore's WebChannel is still connecting; the code retries automatically.

## License

Private project — all rights reserved.
