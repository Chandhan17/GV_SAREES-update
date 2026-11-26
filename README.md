
# GV Sarees

![React](https://img.shields.io/badge/React-19-61DAFB?logo=react) ![Vite](https://img.shields.io/badge/Vite-8-646CFF?logo=vite) ![Firebase](https://img.shields.io/badge/Firebase-Firestore%20%2B%20Auth-FFCA28?logo=firebase) ![Razorpay](https://img.shields.io/badge/Payments-Razorpay-0052CC?logo=razorpay) ![License](https://img.shields.io/badge/License-Not%20Specified-red) ![Deploy](https://img.shields.io/badge/Deploy-Vercel-black?logo=vercel)

> Independent GV Sarees project. Configure a separate Firebase project before local development or deployment.

## Short Project Description

GV Sarees is an online-payment e-commerce and catalog experience for a premium saree boutique. Customers browse products, add them to a cart, and complete purchases through server-verified Razorpay checkout. The application includes Firebase-backed admin controls, transaction-safe inventory holds, and serverless media and payment integrations.

## Table of Contents

- [Features](#features-)
- [Screenshots](#screenshots-)
- [Tech Stack](#tech-stack-)
- [Project Architecture](#project-architecture-)
- [Folder Structure](#folder-structure-)
- [Installation](#installation-)
- [Environment Variables](#environment-variables-)
- [Running Locally](#running-locally-)
- [Build for Production](#build-for-production-)
- [Deployment Instructions](#deployment-instructions-)
- [API Endpoints](#api-endpoints-)
- [Authentication Flow](#authentication-flow-)
- [Database Schema Overview](#database-schema-overview-)
- [Admin Features](#admin-features-)
- [User Features](#user-features-)
- [Performance Optimizations](#performance-optimizations-)
- [Security Features](#security-features-)
- [Future Enhancements](#future-enhancements-)
- [Known Limitations](#known-limitations-)
- [Contributing Guidelines](#contributing-guidelines-)
- [License](#license-)
- [Author](#author-)

## Features ✨

- 🛍️ Elegant product catalog with category, fabric, and price-based filtering
- 💳 Razorpay-only checkout with server-side signature and captured-payment verification
- 📦 Temporary inventory holds during payment, released safely on verified failure or abandonment
- 🧾 Customers can review payment and fulfillment status for orders saved in their browser
- 💬 Optional post-payment WhatsApp click-to-chat with the configured store contact; customers press Send themselves
- 🧑‍💼 Secure admin dashboard to create, edit, and delete products
- 📦 Order management with payment and fulfillment status tracking
- 🖼️ Image uploads and proxying through Telegram-backed serverless endpoints
- 🔍 Product detail pages with gallery-style browsing and size-chart support
- 📱 Responsive UI designed for mobile and desktop experiences
- ⚡ Performance-conscious rendering with lazy loading and skeleton states

## Screenshots 📸

> Screenshots will be added here as the app evolves.

![Home Page](./Screenshots/Homepage.png)

![Products Page](./Screenshots/Productspage.png)

![Admin Dashboard](./Screenshots/Adminpage.png)

## Tech Stack 🛠️

| Layer | Technologies |
| --- | --- |
| Frontend | React 19, Vite, React Router, Tailwind CSS, Framer Motion, Lucide Icons |
| State & Data | Firebase Authentication, Firestore, React hooks |
| Backend/API | Node.js serverless functions on Vercel, Zod validation, rate limiting |
| Media | Telegram Bot API, Sharp, Multer |
| Payments | Razorpay SDK |
| Tooling | ESLint, PostCSS, Autoprefixer |

### Major Dependencies

- React, React DOM, React Router DOM
- Firebase, Firebase Admin
- Axios
- Razorpay
- Zod
- Framer Motion
- Lucide React
- Multer
- Sharp
- Form Data
- CLSX

## Project Architecture 🧱

The application follows a modular architecture:

1. The React/Vite frontend serves the storefront and admin dashboard.
2. Firebase handles authentication and Firestore persistence for products and orders.
3. Vercel serverless API routes manage reservations, inventory/admin actions, image uploads, and Telegram-backed media proxying.
4. Admin actions are protected by Firebase ID tokens verified by the server.
5. New online orders are confirmed automatically after verified capture; WhatsApp click-to-chat is optional and is never part of payment processing.

```text
User Browser
  └─ React + Vite frontend
       ├─ Firebase Auth + Firestore
       ├─ Cart + Razorpay checkout
       └─ Vercel serverless APIs
            ├─ Telegram image upload/proxy
            ├─ Reservation and inventory APIs
            └─ Admin verification + rate limiting
```

## Folder Structure 🌳

```text
GV_SAREES/
├── api/
│   ├── _lib/
│   ├── image/
│   ├── razorpay/
│   ├── delete-telegram-media.js
│   └── upload-image.js
├── public/
├── scripts/
├── server/
│   ├── firebaseAdmin.js
│   ├── http.js
│   ├── rateLimit.js
│   ├── validation.js
│   └── verifyAdmin.js
├── src/
│   ├── assets/
│   ├── components/
│   ├── config/
│   ├── context/
│   ├── hooks/
│   ├── pages/
│   ├── scripts/
│   ├── services/
│   └── utils/
├── package.json
├── vercel.json
└── vite.config.js
```

## Installation ⚙️

```bash
git clone <your-gv-sarees-repository-url>
cd GV_SAREES
npm install
```

## Environment Variables 🌐

Copy `.env.example` to `.env` in the project root for local development. Use only credentials from the independent GV Sarees services. Never copy credentials from the original Srimathi Silks project.

| Variable | Required | Description |
| --- | --- | --- |
| `VITE_FIREBASE_API_KEY` | Yes | Firebase client API key |
| `VITE_FIREBASE_AUTH_DOMAIN` | Yes | Firebase auth domain |
| `VITE_FIREBASE_PROJECT_ID` | Yes | Firebase project ID |
| `VITE_FIREBASE_STORAGE_BUCKET` | Yes | Firebase storage bucket |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | Yes | Firebase messaging sender ID |
| `VITE_FIREBASE_APP_ID` | Yes | Firebase app ID |
| `VITE_ADMIN_EMAILS` | Yes | Comma-separated admin emails allowed to access the dashboard |
| `VITE_IMAGE_UPLOAD_ENDPOINT` | Optional | Override for image upload API endpoint |
| `VITE_API_BASE_URL` | Optional | Base URL used for image proxying |
| `VITE_RAZORPAY_KEY_ID` | Optional | Public Razorpay test-mode key; must match the server key ID |
| `RAZORPAY_KEY_ID` | Optional | Server-side Razorpay test-mode key ID; must match `VITE_RAZORPAY_KEY_ID` |
| `RAZORPAY_KEY_SECRET` | Optional | Server-only Razorpay test-mode secret; never expose or prefix with `VITE_` |
| `RAZORPAY_WEBHOOK_SECRET` | Required for webhooks | Separate server-only secret configured for the Razorpay test-mode webhook endpoint |
| `TELEGRAM_BOT_TOKEN` | Yes for media uploads | Telegram bot token used for image uploads and proxying |
| `TELEGRAM_CHANNEL_ID` | Yes for media uploads | Telegram channel or chat ID |
| `RESERVATION_TOKEN_SECRET` | Yes for checkout holds | Server-only random secret (at least 32 bytes) used to generate reservation access tokens |
| `CRON_SECRET` | Yes for reservation expiry | Server-only Vercel Cron bearer secret; generate with `openssl rand -hex 32` and configure in Vercel project environment variables |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Alternative | Full Firebase Admin service account JSON |
| `FIREBASE_CLIENT_EMAIL` | Alternative | Firebase admin client email |
| `FIREBASE_PRIVATE_KEY` | Alternative | Firebase admin private key |
| `FIREBASE_PROJECT_ID` | Alternative | Firebase admin project ID |
| `VITE_NGROK_HOST` | Optional | Hostname allowed for local tunnel testing |
| `FIREBASE_SERVICE_ACCOUNT_FILE` | Migration only | Path to a local Admin SDK service-account JSON file |
| `GCLOUD_PROJECT` | Migration fallback | Google Cloud project ID used by the migration script |

### Isolated performance test mode

Performance mode is deliberately separate from the normal development and production configuration. Keep the dedicated test bot settings and emulator-only Firebase settings in the ignored `.env.performance.local`. Vercel Dev may inject `.env` or `.env.build`; required Telegram/Firebase settings are replaced by validated performance values, and production `VITE_` settings not explicitly configured for performance are excluded. Unrecognized inherited conflicts fail closed. Production files are also checked to ensure the test bot and channel are not reused.

1. Start only the local Firebase Auth and Firestore emulators with `firebase emulators:start --only auth,firestore --project demo-gv-sarees`.
2. From the repository root, run `node scripts/seed-performance-products.mjs` to add 20 repeatable sample products to the verified emulator. The script reads the demo project and emulator host from `.env.performance.local`, rejects conflicting production settings or credentials, and uses a local placeholder image. Re-running it updates the same deterministic product IDs.
3. In another terminal, run either `npm run dev:performance` to use the API-only Vercel runtime from `vercel.performance.json`, or `npm run dev:performance:persistent` to use the isolated persistent Node API runtime. Both bind the API only to `127.0.0.1:3001` and start the separate Vite app on port 5174. Vercel remains the default workflow; the regular `vercel.dev.json` SPA workflow is unchanged.
4. Add a unique `RESERVATION_TOKEN_SECRET` of at least 32 bytes and dedicated Razorpay Test Mode credentials (`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, and matching `VITE_RAZORPAY_KEY_ID`) to `.env.performance.local`. Do not reuse any production credential. Startup rejects missing or mismatched values, live-mode keys, and credentials that match production configuration.
5. Startup verifies the dedicated Telegram bot and private test channel, emulator project and connectivity, and API backend isolation. Uploads and writes are blocked if any verification fails.
   Telegram verification failures identify the check and a sanitized category only; tokens, destination IDs, API URLs, and response bodies are never included.

For performance admin access, `.env.performance.local` contains a separate `VITE_ADMIN_EMAILS` allowlist. Create the test user in the Auth Emulator, then create `admins/{uid}` in the Firestore Emulator with the boolean field `isAdmin: true`. The user ID must match the Auth Emulator UID; do not copy production admin records.

Backend readiness failures report the last HTTP status or fetch error and a sanitized summary of allowlisted health fields; arbitrary response content is omitted.

The performance app connects Firebase Auth and Firestore directly to the local emulators. Vite does not automatically reload production environment files in performance mode, and inherited Firebase service-account credentials cause startup validation to fail. Do not start benchmarks until the isolated environment is healthy.

### Isolated performance benchmarks

The benchmark suite uses Playwright for browser navigation metrics, Lighthouse against an isolated performance-mode build, and Autocannon only for `GET /api/best-sellers`. Browser requests are restricted to the local frontend, API, and Firebase emulators; external browser resources are blocked. The API load runner rejects every method/path other than the allowlisted read-only endpoint.

Install the declared dependencies with `npm install`, then install the Playwright browser once with `npx playwright install chromium`. Start the Auth and Firestore emulators and isolated services as described above. Keep the existing 20 seeded products; benchmark runs do not reseed or mutate Firestore.

```powershell
npm run benchmark:smoke
npm run benchmark:baseline
npm run benchmark:compare -- --baseline-file .performance-reports\baseline.json
npm run benchmark:load -- --connections 1 --duration-seconds 10
```

Smoke mode is the default and uses one browser pass per page plus three sequential read-only API requests. Baseline and comparison modes first run the smoke checks, then collect three browser samples per page, Lighthouse mobile performance audits, and a conservative one-connection/10-second Autocannon run. Load mode also performs smoke checks first; it is capped at five connections and 30 seconds. Larger load tests are never started by the default command.

Select the benchmark runtime explicitly to match the service started above. For the persistent server, use `npm run benchmark:smoke -- --api-runtime persistent`; for Vercel Dev, use `npm run benchmark:smoke -- --api-runtime vercel`. The benchmark validates the runtime identity and fails on a mismatch.

Pages measured: `/`, `/products`, `/products/performance-seed-v1-001`, and `/cart` (with a local-only cart fixture; checkout is never submitted). The browser captures page load time, DOM Content Loaded, FCP, LCP, and CLS. Lighthouse reports its performance score and FCP/LCP/CLS. API metrics include average, median, P95/P99 latency, requests per second, and error rate. `/api/test` is used only as a safety/readiness check; it is not load-tested. Best-sellers is cached, so API results can represent warm-cache performance.
Browser timing failures list the missing metric names and sample; reports retain sanitized browser errors and failed local-request diagnostics without full request URLs. Failed timing samples also include navigation timing/type, document state, paint entries, LCP observer support, and delivered/pending observer records. The runner waits up to one second for actual FCP and LCP observer values before strict validation; it does not substitute missing metrics.

Reports also include individual smoke-request start/end times, HTTP response duration, JSON parsing and validation duration, total duration, HTTP status, fetch/JSON/payload validation outcomes, sanitized failure reasons, and allowlisted Best Sellers server-timing stages. Persistent-runtime reports separately record process startup/import time and classify cold service-cache misses, actual cache hits, and in-flight reuse from the returned Server-Timing diagnostics—not request order. API diagnostics are retained even when a smoke request fails. Runtime markers and timing headers are local performance diagnostics; production responses and JSON payloads are unchanged.

Each run writes `report.json` and `report.html` under `.performance-reports/<timestamp>-<mode>/`. Full runs also use a temporary production build compiled in performance mode for Lighthouse; that build is removed after the audit. Baseline mode writes `.performance-reports/baseline.json`; compare mode reads that file by default or accepts `--baseline-file <path>`. Reports and baselines are local and git-ignored.

The benchmark runner validates the dedicated performance configuration, verifies the demo project and loopback emulators, and checks the API’s performance health response before collecting metrics. It never calls checkout, payment, webhook, reservation-creation, inventory-mutation, Telegram-upload, or admin mutation endpoints. Startup verification may make read-only identity checks to the configured Telegram test bot; no Telegram message or upload is sent.

<details>
<summary>Example environment file</summary>

```env
# Browser-safe Firebase Web app configuration
VITE_FIREBASE_API_KEY=your_key
VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your-project
VITE_FIREBASE_STORAGE_BUCKET=your-project.firebasestorage.app
VITE_FIREBASE_MESSAGING_SENDER_ID=123456789
VITE_FIREBASE_APP_ID=1:123456789:web:abc123
VITE_ADMIN_EMAILS=admin@example.com

# Server-only values
FIREBASE_SERVICE_ACCOUNT_JSON=
# Or use FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, and FIREBASE_PROJECT_ID.
RESERVATION_TOKEN_SECRET=
CRON_SECRET=
TELEGRAM_BOT_TOKEN=xxx
TELEGRAM_CHANNEL_ID=xxx
```

</details>

### Firebase setup for GV Sarees

1. Create a new Firebase project specifically for GV Sarees. Do not reuse the original Srimathi Silks project.
2. Register a Web app in the new project and copy its six configuration values into the `VITE_FIREBASE_*` variables.
3. Enable Email/Password sign-in in Firebase Authentication.
4. Create the initial admin user in Firebase Authentication. Add its exact Firebase UID to the `admins/{uid}` collection using a trusted Firebase Admin SDK process, with `{ "isAdmin": true }`. `VITE_ADMIN_EMAILS` is only a browser-side navigation allow-list; it does not grant API or Firestore access.
5. Create the Firestore database in the new project. The application uses `products`, `orders`, and `admins` collections.
6. Create a Firebase Admin service account for server-side token verification. Prefer `FIREBASE_SERVICE_ACCOUNT_JSON` in local/server secret storage, or use the separate `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, and `FIREBASE_PROJECT_ID` variables.
7. Keep all service-account fields server-only. Never prefix them with `VITE_`, import them from `src/`, commit them, or paste them into browser-visible configuration.
8. Review and deploy `firestore.rules` only after the new project and initial admin bootstrap have been verified. This project does not deploy rules automatically.

The client uses Firebase Authentication and Firestore through [src/services/firebase.js](./src/services/firebase.js). API routes verify Firebase ID tokens and require an `admins/{uid}` document with `isAdmin: true`; Firestore rules use the same UID-document policy. To add an administrator, create their Firebase Auth account and add their UID record with a trusted Admin SDK process. To revoke access, delete that UID record or set `isAdmin` to false. Never create admin records from browser code.

The current rules are project-independent and do not contain a Firebase project ID. Before first use, review these intentional access choices:

- Product documents are publicly readable.
- Checkout holds and payment records are created only through validated server-side APIs. Direct Firestore order writes are denied. Store WhatsApp settings are publicly readable and server-write-only.
- Product creation/content edits and order reads require an authenticated admin document. Product inventory changes and order lifecycle changes are routed through server APIs.
- `admins` documents cannot be written through the client, so the first `admins/{uid}` document must be created through a trusted, separately approved bootstrap process.

Do not run the migration script with `--apply` until the target Firebase project, collections, rules, and backups have been explicitly confirmed.

### Inventory migration

Legacy products without stock data default to zero available stock. Before enabling reservations, prepare a JSON file mapping each product document ID to the physically confirmed stock count, for example:

```json
{
  "firestoreProductDocumentId": 5
}
```

Run `npm run migrate:inventory -- --input stock-confirmations.json` first. This is a dry run and does not write products. After reviewing the quantities and backing up the target database, apply with `npm run migrate:inventory -- --input stock-confirmations.json --apply --confirm-stock`. Existing reserved quantities are preserved and a migration is rejected if the confirmed physical quantity is below the reserved amount. Never run against production without an approved stock count and backup.

### Telegram image URL audit

Run `node scripts/auditTelegramImageUrls.js` from an environment where Firebase Admin is already configured through process environment variables or Application Default Credentials. The script reads only `products` and reports counts plus affected document IDs and image field paths; it does not print URLs or credentials and performs no writes. It does not load environment files.

### Reservation secrets and rate limits

Set `RESERVATION_TOKEN_SECRET` and `CRON_SECRET` as server-only Vercel environment variables (Production/Preview as applicable). Generate each independently with a cryptographically secure generator such as `openssl rand -hex 32`; do not commit actual values. Rotating `RESERVATION_TOKEN_SECRET` invalidates outstanding checkout-hold access tokens.

Reservation creation and cancellation currently use the repository's in-memory rate limiter. Its counters are per serverless instance and are not globally distributed. No Redis/Upstash or other distributed limiter is configured in this project. A distributed limiter requires selecting and configuring a supported shared backend before claiming global rate limits.

The Razorpay backend creates idempotent INR payment orders for active checkout holds and verifies checkout signatures against Razorpay's server-fetched payment details. Verified capture automatically confirms and fulfills an order in a transaction. The webhook endpoint verifies the exact raw request body with the separate `RAZORPAY_WEBHOOK_SECRET`, deduplicates event IDs, and reconciles payment-order IDs against persisted attempt receipts.

Configure matching `rzp_test_` key IDs, the server-only `RAZORPAY_KEY_SECRET`, and a separate `RAZORPAY_WEBHOOK_SECRET`. In the Razorpay **Test Mode** dashboard, register `https://<your-test-host>/api/razorpay/webhook`, subscribe to `payment.authorized`, `payment.captured`, `payment.failed`, and `order.paid`, then place the webhook secret only in the server environment. For local testing, expose the Vercel API runtime started on port 3000 through a trusted test tunnel and set that tunnel URL as the webhook URL; Vite proxies `/api/razorpay/webhook` to the same API runtime. Use Razorpay's dashboard test-event delivery and verify duplicate deliveries return success without changing payment state twice. Do not copy the webhook secret into frontend variables or source.

#### Local webhook smoke test

Run this from the repository root in PowerShell:

```powershell
node .\scripts\test-razorpay-webhook.js
```

The script loads `RAZORPAY_WEBHOOK_SECRET` from `.env.local` or `.env` (or the current process environment), never prints it, and POSTs a synthetic `payment.captured` event with fresh IDs to an ephemeral loopback HTTP harness. The harness invokes the production webhook handler with an injected test processor, so it tests raw-body handling and signature validation without accessing Firestore or Razorpay. The valid signature is expected to return HTTP 200. This is a test-only harness, not a Vercel Dev runtime integration test.

To verify signature rejection instead, run:

```powershell
node .\scripts\test-razorpay-webhook.js --invalid-signature
```

That request is expected to return HTTP 403. Both modes have a five-second request timeout and create no Razorpay order or payment.

#### Customer checkout (Razorpay Test Mode)

The cart offers Razorpay as the only purchase method. Checkout submits the complete cart as one reservation and one Firestore order. The server validates every product and atomically holds all requested quantities; if any item is unavailable, none of the cart is reserved. One Razorpay order is created for the combined total calculated from current Firestore product prices; frontend cart prices are display-only. Payment and fulfillment state on My Orders comes from the token-protected status API and is refreshed while the page is open.

Use matching `rzp_test_` key IDs only for local testing. Live-mode keys are rejected by the payment backend; do not enable Live Mode or perform real transactions as part of local verification. Closing Checkout triggers server reconciliation; unresolved payment is not reported as failed, and authorization is not treated as capture. After verified capture and automatic fulfillment of every item, the customer is redirected in the same tab to a prefilled WhatsApp click-to-chat link addressed to the configured store number. WhatsApp only prepopulates the message; the customer must press Send, and closing WhatsApp does not affect the order.

Payment attempts and verified payment states are stored on the existing `orders` document. Webhook event IDs and outcomes are recorded in `razorpayWebhookEvents` (event IDs are hashed for document keys); raw webhook payloads, signatures, and customer tokens are not stored. A server-verified payment failure releases reserved stock transactionally and exactly once. Pending or unverified payments retain the hold only until safe expiry; expiry attempts server-side reconciliation, then releases stock without falsely changing an unresolved payment to failed. A later capture atomically reacquires inventory only when available; otherwise the order is tracked for a full refund. Fulfillment is never marked confirmed without verified captured payment and available inventory. Refund actions are server-side and require an authorized admin action.

Admins configure the public store WhatsApp destination under **Admin → Settings**. Numbers are normalized to E.164; a blank setting disables the order WhatsApp link. Click-to-chat does not automatically deliver a message and does not change order/payment state.

## Running Locally ▶️

Start the Vercel API runtime in one terminal:

```bash
npx vercel dev --listen 127.0.0.1:3000
```

Start Vite in a second terminal:

```bash
npm run dev -- --host 127.0.0.1 --port 5174 --strictPort
```

Open http://127.0.0.1:5174. Vite serves the frontend and handles image uploads through its local middleware; it proxies product, inventory, and reservation API requests to Vercel Dev on port 3000. Port 5174 avoids colliding with the Vite server that Vercel Dev may start for its own frontend forwarding. Multipart uploads also work through Vercel Dev's API route, which captures its replayed raw bytes before parsing.

To serve SPA routes through Vercel Dev's Vite Development Command instead, run:

```powershell
npx vercel dev --local-config .\vercel.dev.json --listen 127.0.0.1:3000
```

Keep the Vercel Project Development Command set to `npx vite --host 127.0.0.1 --port %PORT% --strictPort`. The local config excludes `/shared/` from the SPA fallback so shared JavaScript modules reach Vite; production continues to use `vercel.json`. Verify `http://127.0.0.1:3000/cart` renders and `http://127.0.0.1:3000/shared/customerValidation.js` responds with `200 text/javascript`.

## Build for Production 🏗️

```bash
npm run build
```

The production build output is generated in the `dist/` directory.

## Deployment Instructions 🚀

This project is configured for Vercel deployment via `vercel.json` and serverless API routes under `api/`.

1. Create a new Vercel project and connect this repository.
2. Set all required environment variables in the Vercel dashboard.
3. Deploy the project.
4. Ensure your Firebase and Telegram credentials are available in the production environment.

```bash
vercel --prod
```

## API Endpoints 🔌

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `POST` | `/api/upload-image` | Upload an image to Telegram and return proxyable metadata |
| `POST` | `/api/delete-telegram-media` | Temporarily disabled; returns HTTP 503 |
| `POST` | `/api/reservations/create` | Validate products and create temporary online-checkout inventory holds |
| `POST` | `/api/reservations/cancel` | Disabled; customer order cancellation is managed by the store |
| `GET` / `POST` | `/api/reservations/cleanup` | Vercel Cron expiry cleanup; requires server-only `CRON_SECRET` |
| `POST` | `/api/admin/reservations` | Admin-only release, expire, refund, or restock actions |
| `POST` | `/api/admin/inventory` | Admin-only stock adjustments |
| `POST` | `/api/admin/orders` | Admin-only fulfillment, safe cancellation, archive, and guarded order retention/deletion actions |
| `GET` / `POST` | `/api/admin/settings` | Public store-contact read; authorized-admin WhatsApp number update |
| `POST` | `/api/razorpay/create-order` | Create/reuse a test-mode INR payment order for a reservation using its access token and an idempotency key |
| `POST` | `/api/razorpay/verify` | Verify a Razorpay signature and server-fetched payment before updating the reservation order |
| `POST` | `/api/razorpay/webhook` | Verify and idempotently process Razorpay payment events using the exact raw body |
| `GET` | `/api/image/[...path]` | Proxy Telegram media for browser-safe delivery |

## Authentication Flow 🔐

- Admins sign in with Firebase Authentication using their email and password.
- The client stores the Firebase ID token and sends it with privileged requests.
- The server verifies the token using Firebase Admin SDK.
- Admin API and Firestore access require an `admins/{uid}` document with `isAdmin: true`. `VITE_ADMIN_EMAILS` only affects client-side dashboard visibility and does not grant authorization.

## Database Schema Overview 🗄️

The project uses Firestore collections for content and orders.

| Collection | Fields |
| --- | --- |
| `products` | `id`, `name`, `price`, `category`, `fabric`, `description`, `images`, `sizeLength`, `totalStock`, `reservedStock`, `availableStock`, `lowStockThreshold`, `inStock`, `createdAt` |
| `orders` | `id`, `items[]` product/name/size/quantity/unit-price snapshots, subtotal/total amount, customer snapshot, `reservationId`, `reservationStatus`, payment attempts and refund state, `paymentStatus`, `orderStatus`, and archival metadata; legacy single-product fields remain supported |
| `orderDeletionAudits` | Versioned, customer-PII-free accounting snapshot of payment/refund references, amounts, order summary and inventory lifecycle, keyed by permanently deleted order ID |
| `settings/store` | Public `whatsappNumber` in E.164; updated only by the admin settings API |
| `reservationRequests` | Idempotency key, canonical request fingerprint, linked order/reservation IDs |
| `reservationTokens` | Reservation-bound customer access-token hash; no plaintext token |
| `inventoryHistory` | Inventory action, quantity delta, previous/new quantity, reason, timestamp, associated reservation/order |
| `razorpayWebhookEvents` | Webhook event IDs and processing outcomes used for duplicate protection and payment reconciliation |

### Best Sellers

The public `GET /api/best-sellers` endpoint aggregates captured Razorpay orders from `orders`; it reads only order timestamps, status, product/item snapshots, quantities, prices, refund state, and archive/deletion flags. Current checkout orders store all products in `items[]`; legacy single-product fields and historical `orderItems` or `products` arrays are also recognized. Only captured, confirmed/fulfilling orders contribute. Cancelled, archived/deleted, stock-restored, unresolved-refund, and fully refunded orders are excluded. A processed refund equal to an exact number of units at the single product's stored price reduces eligible units. The current schema does not record item-level refunded quantities for non-unit or multi-item partial refunds, so those quantities are not guessed.

The endpoint ranks by eligible units, net eligible product revenue, then current product name; it uses `createdAt` for a 90-day window and falls back to lifetime eligible orders if fewer than three available products have recent sales. Recent queries use the single-field `createdAt` index; lifetime fallback queries only captured payments. It reads no customer/payment credentials, creates no summary documents, and requires no new index or data migration. Server memory and CDN responses are cached for five minutes. Product visibility is currently collection-wide (no separate visibility field exists); missing and out-of-stock products are omitted.

## Admin Features 🧑‍💼

- Add, edit, and remove products
- Upload product images and size charts
- Manage stock availability
- View and update order status
- Filter orders by customer, payment/order status, and inclusive Asia/Kolkata date range
- Select and remove eligible orders from the active list, individually or in batches
- Permanently delete eligible orders individually or in batches after reviewing an optional XLSX backup
- Export every matching order to a formatted Excel workbook with Orders, Order Items, and Summary sheets
- Remove outdated media from Telegram-backed storage

The existing Delete/Archive flow remains a guarded retention action and does not physically delete order documents. Permanent deletion is a separate admin API action: the server re-reads and validates each order inside a Firestore transaction, creates `orderDeletionAudits/{orderId}`, and then removes only the `orders/{orderId}` document. For reservations, the transaction also requires matching inventory-history records and an action consistent with the final reservation state; missing or inconsistent history blocks deletion. The audit snapshot keeps transaction IDs/statuses, amounts, order/item summaries, and inventory lifecycle fields, but excludes customer PII, raw webhook payloads/signatures, and credentials. Razorpay webhook events, reservation idempotency records/tokens, inventory history, products, and stock are not modified. The server rejects an order if it has any subcollections; the application currently creates none under orders. Bulk deletion is per-order and idempotent, so eligible orders can complete while rejected orders retain specific reasons.

The `orderDeletionAudits` collection is created on first use; no backfill is needed for existing orders. Existing clients continue querying `orders`, so a permanently deleted order no longer appears in admin/customer order-status lookups; its retained audit is server-only under the existing Firestore rules. Permanent deletion does not delete related global financial/audit records, and exact storage savings are not measured; Firestore billing/storage metrics may take time to reflect document removal. Product documents and stock are never changed.

## User Features 👩‍💼

- Browse curated saree collections
- Filter by category, fabric, size, and price
- View detailed product pages
- Add products to cart and pay securely with Razorpay
- View payment and order fulfillment status
- Optionally open a prefilled WhatsApp order message after verified payment; customer confirmation by pressing Send is required
- See product availability and new-arrival badges

## Performance Optimizations ⚡

- Lazy-loaded images and product cards
- Skeleton loading states for smoother perception of load times
- Product caching in the frontend service layer
- Optimized image upload using Sharp before media transfer
- Telegram image proxy with cache-friendly headers

## Security Features 🔒

- Firebase-based admin authentication
- Server-side ID token verification
- Rate limiting for upload, delete, and payment endpoints
- Security headers and CSP for API responses
- Input validation using Zod for API payloads
- Admin-only access to image upload and delete endpoints

## Future Enhancements 🚧

- Customer accounts and receipt generation
- Customer account and saved address management
- Search indexing and analytics dashboards
- Multi-language and multi-currency support
- Inventory sync and export/import tools

## Known Limitations ⚠️

- The project currently relies on Telegram as the media storage backend for uploaded images.
- Reservation rate limiting is in-memory per serverless instance and is not globally distributed.
- The Admin Orders table currently subscribes to the full orders collection; Excel exports include every locally loaded order matching the active filters. Bulk order actions are sent to the server in bounded batches of 100 IDs.
- Permanent deletion retains an accounting snapshot in `orderDeletionAudits`; Firestore storage savings are not measured, and emulator/project-backed transaction concurrency testing is still required.
- Automated unit and integration-guard tests run with `npm test`; Firestore transaction concurrency still requires emulator/project-backed testing.
- The README uses placeholders for screenshots and live demo URL until production assets are published.

## Contributing Guidelines 🤝

Contributions are welcome.

1. Fork the repository.
2. Create a feature branch.
3. Make your changes and test locally.
4. Open a pull request with a clear description.

```bash
npm run lint
npm run build
```

## License 📄

No license has been specified for this repository yet. Please contact the maintainer before reusing or redistributing the codebase.

## Author 👤

- Name: Sai Chandhan Reddy Annapureddy
- GitHub: https://github.com/SAI-CHANDHAN
- Portfolio: https://saichandhan.online/
- LinkedIn: https://www.linkedin.com/in/saichandhanannapureddy/

---

Built with care for a premium saree shopping experience.
#   G V _ S A R E E S - u p d a t e  
 