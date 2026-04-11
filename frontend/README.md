This frontend powers the MTR Dashboard UI and API routes.

## Getting Started

Install dependencies and run the development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser.

## Authentication And Security (POC)

The frontend now includes:

- Username/password login with signed HTTP-only session cookies
- Role-based access control (`viewer`, `operator`, `admin`)
- Role-aware UI controls (viewer/operator/admin experiences)
- In-memory per-route rate limiting
- Sanitized 500 responses (no raw internal error leakage)

Security is enforced when either:

- `SECURITY_ENFORCE_AUTH=true`, or
- one or more API tokens are configured.

If neither is set, the app runs in permissive mode for local development.

Create `.env.local` from `.env.example` and set at minimum:

- `SESSION_SECRET`
- initial auth users/passwords (`AUTH_ADMIN_*`, `AUTH_OPERATOR_*`, `AUTH_VIEWER_*`)

Then run:

```bash
node scripts/seed-auth-users.mjs
```

In Docker deployments, auth users are seeded automatically by `docker-entrypoint.sh`.

## Role Matrix

- `viewer`: Read-only metrics/health endpoints
- `operator`: Viewer permissions + probe/realtime/actions
- `admin`: Full access including device management and backend overview

## Notes

- Rate limiting is in-memory and intended for POC use.
- For production, use centralized/session-backed auth and distributed rate limiting.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

- [Next.js Documentation](https://nextjs.org/docs)
