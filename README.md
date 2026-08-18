# Aapkakaam Server

Production-grade Node.js + Express + MongoDB backend powering the Aapkakaam
platform (users, vendors, employees, admin, bookings, payments, referrals).

---

## Tech stack

| Layer            | Choice                                      |
| ---------------- | ------------------------------------------- |
| Runtime          | Node.js ≥ 18                                |
| Framework        | Express 4                                   |
| Database         | MongoDB (via Mongoose 8)                    |
| Auth             | JWT (per-audience secrets: user/vendor/admin/employee) |
| Payments         | Razorpay                                    |
| Push             | Firebase Admin SDK                          |
| Storage          | AWS S3                                      |
| Logging          | pino (structured, JSON in prod)             |
| Security         | helmet, express-mongo-sanitize, express-rate-limit, CORS allow-list |

---

## Quick start (local)

```bash
# 1. Install dependencies
yarn install     # or: npm install

# 2. Create your local env
cp .env.example .env
#    → edit .env and fill in MONGODB_URL_1, JWT_* secrets, etc.

# 3. Run in dev mode (hot reload via nodemon)
yarn dev

# 4. Run production build locally
yarn start:prod
```

Server listens on `PORT` (default `3000`). Health check: `GET /health`.

## Run with Docker

```bash
# Build & start API + MongoDB
docker compose up --build

# API:      http://localhost:3000/health
# MongoDB:  mongodb://localhost:27017
```

---

## Environment variables

All configuration is loaded from environment variables — see
[`.env.example`](./.env.example) for the full list. The server fails fast at
boot if any **required** variable is missing.

Required in every environment:

- `PORT`
- `MONGODB_URL_1`
- `JWT_SECRET`

Additionally required when `NODE_ENV=production`:

- `ALLOWED_ORIGINS`
- `JWT_USER_SECRET`, `JWT_VENDOR_SECRET`, `JWT_ADMIN_SECRET`, `JWT_EMPLOYEE_SECRET`

> **Security:** never commit `.env`. Generate JWT secrets with
> `openssl rand -base64 48` (min 32 chars recommended).

### Firebase credentials

Choose **one**:

- `FIREBASE_SERVICE_ACCOUNT_JSON` — base64-encoded service-account JSON
  (recommended for containers/CI):
  ```bash
  base64 -w0 path/to/service-account.json
  ```
- `GOOGLE_APPLICATION_CREDENTIALS` — absolute path to service-account JSON
  file (mount as a secret volume in prod).

Do **not** put OS-specific hardcoded paths in code.

---

## Project layout

```
.
├── index.js                    # Entry point → src/server.js
├── src/
│   ├── app.js                  # Express app: middleware + routes wiring
│   ├── server.js               # HTTP server + graceful shutdown
│   ├── config/
│   │   ├── env.js              # Validated env loader (fail-fast)
│   │   ├── database.js         # Mongoose connection
│   │   ├── firebase.js         # Firebase Admin initialisation
│   │   ├── razorpay.js         # Razorpay client
│   │   └── logger.js           # winston logger (file transports)
│   ├── logger/logger.js        # pino logger (default runtime logger)
│   ├── middleware/
│   │   ├── requestLogger.js    # Per-request correlation + timing
│   │   ├── rateLimiter.js      # global + auth limiters
│   │   └── errorHandler.js     # Centralised error responder
│   ├── services/               # Business services (booking, wallet, …)
│   ├── utils/                  # ApiError, ApiResponse, asyncHandler, …
│   └── validators/             # express-validator schemas
├── routes/                     # Route modules (mounted under /api/*)
├── controller/                 # Route handlers
├── auth/                       # Signup/login for user/vendor/admin/employee
├── middleware/                 # JWT auth guards (is_user, is_vendor, …)
├── models/                     # Mongoose schemas
├── Dockerfile
├── docker-compose.yml
├── .env.example
└── package.json
```

---

## API surface

All routes are mounted under `/api`:

| Prefix              | Purpose                                  |
| ------------------- | ---------------------------------------- |
| `GET  /health`      | Container/LB liveness probe              |
| `GET  /api/health`  | Detailed health payload                  |
| `/api/user/*`       | User signup, login, profile, orders      |
| `/api/vendor/*`     | Vendor signup, login, listings, earnings |
| `/api/admin/*`      | Admin auth + dashboards + analytics      |
| `/api/employee/*`   | Employee auth + payouts                  |
| `/api/bookings/*`   | Create, cancel, complete, rate           |
| `/api/payment/*`    | Razorpay order + verification            |
| `/api/pincode/*`    | Pincode lookup                           |
| `/api/share/*`      | Referral/share tracking                  |

The full contract is documented in [`openapi.yaml`](./openapi.yaml). Load it
into Swagger UI, Postman, or Redocly to explore each endpoint.

### Admin analytics

`GET /api/admin/analytics` (requires an admin bearer token) returns a compact
ops dashboard — daily bookings, monthly GMV, referral funnel, totals — with a
60-second in-memory cache to protect the DB from bursty polling.

Auth: send `Authorization: Bearer <jwt>` — tokens are signed with the
per-audience secret matching the caller (user/vendor/admin/employee).

---

## Production hardening (already applied)

- [x] Fail-fast env validation (`src/config/env.js`)
- [x] Helmet security headers + response compression
- [x] Strict CORS allow-list (empty list = allow-all only in non-prod)
- [x] NoSQL injection sanitisation (`express-mongo-sanitize`)
- [x] Global + auth-specific rate limiters
- [x] Trust-proxy honoured for correct client IP behind LB/ingress
- [x] Structured logging with per-request correlation IDs
- [x] Central error handler with typed `ApiError`
- [x] Per-audience JWT secrets (no shared hardcoded key)
- [x] Graceful shutdown on SIGTERM/SIGINT + `uncaughtException` /
      `unhandledRejection` handling
- [x] Dockerfile: multi-stage, non-root `node` user, HEALTHCHECK
- [x] Docker Compose stack with MongoDB + healthchecks
- [x] `.env.example`, `.dockerignore`, ESLint, Prettier configs

---

## Scripts

| Command            | Description                              |
| ------------------ | ---------------------------------------- |
| `yarn start`       | Run server (any env)                     |
| `yarn start:prod`  | Run server with `NODE_ENV=production`    |
| `yarn dev`         | Run with nodemon hot reload              |
| `yarn test`        | Run Jest (unit + integration with in-mem Mongo) |
| `yarn lint`        | ESLint check                             |
| `yarn lint:fix`    | ESLint autofix                           |
| `yarn format`      | Prettier format                          |

## Testing

Tests use **jest**, **supertest**, and **mongodb-memory-server** so no external
MongoDB is required.

```bash
yarn test
```

Suites cover:
- Health endpoints, security headers, 404 handling
- JWT middleware (missing / invalid / wrong-audience / missing-claim → 401)
- Auth rate limiter (429 after `AUTH_RATE_LIMIT_MAX + 1` attempts)
- User signup + login integration flow against an in-memory Mongo (verifies
  password hashing, duplicate rejection, JWT round-trip)

## Continuous integration

`.github/workflows/ci.yml` runs on every push / PR:

1. **Lint** — `yarn lint`
2. **Test** — `yarn test` on Node 18 & 20
3. **Docker build** — validates the multi-stage Dockerfile builds (main branch only)

---

## Deployment notes

- Reverse-proxy the API on 443 (nginx / ALB / CloudFront) and terminate TLS
  there; set `TRUST_PROXY=1`.
- Provide `.env` via your platform's secret store (never bake into the image).
- Ship container logs to your aggregator (pino writes structured JSON to
  stdout in production).
- Use MongoDB Atlas or a managed replica-set with `retryWrites=true`.
- Monitor `/health` from your load balancer.
# Aapkakaam-server-production
