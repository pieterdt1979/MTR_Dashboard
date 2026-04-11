# Frontend (Next.js 16.2.3) Guidelines

## Next.js 16.2.3 Breaking Changes ⚠️

<!-- BEGIN:nextjs-agent-rules -->
**This is NOT the Next.js you know.** This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

Key differences from older Next.js versions:
- **App Router only** (no Pages Router)
- **Server Components by default** (use `'use client'` for interactivity)
- **Streaming & partial prerendering** may affect data fetching patterns
- **Image component changes** and optimization behavior
- **API Route syntax** may differ from your expectations

## Frontend Tech Stack

- **Next.js**: 16.2.3 (App Router, TypeScript strict mode)
- **React**: 19.2.4 (with RSC support)
- **TypeScript**: 5.x (strict null checks enabled)
- **Styling**: TailwindCSS 4.x + PostCSS
- **Database Driver**: mysql2 3.22.0 (Node.js MySQL adapter)
- **Server Environment**: Node.js 18+ required

## Project Structure

```
frontend/
├── app/
│   ├── api/
│   │   └── devices/
│   │       └── route.ts              # Device CRUD endpoints
│   ├── layout.tsx                    # Root layout (RSC, fonts)
│   ├── page.tsx                      # Home page
│   └── globals.css                   # Global Tailwind styles
├── public/                           # Static assets
├── next.config.ts                    # Next.js configuration
├── tsconfig.json                     # TypeScript strict mode
├── package.json
└── AGENTS.md                         # <-- You are here
```

## Build Commands

```bash
npm install          # Install all dependencies
npm run dev         # Start dev server (http://localhost:3000, port 3000)
npm run build       # Production build (optimizes for deployment)
npm start           # Run production build locally
npm run lint        # Run ESLint (if configured)
```

## API Routes (/api/devices)

All endpoints return the standard response envelope:
```json
{
  "success": boolean,
  "data": { /* endpoint-specific response */ },
  "error": "error message if success=false",
  "count": /* optional: item count for lists */
}
```

### HTTP Status Codes
- `200 OK`: GET/POST success
- `201 Created`: New device added
- `400 Bad Request`: Validation error
- `409 Conflict`: Duplicate IP address
- `500 Server Error`: Database connection or unhandled error

## Security Guidelines for @SecureDevAgent

### API Route Security
- **Validate all inputs**: Device IPs, hostnames, ports must validate format
- **SQL Injection Prevention**: Use parameterized queries via mysql2 prepared statements
- **Request Validation**: Check Content-Type, validate request body structure
- **Error Messages**: Never expose database errors or internal stack traces to clients

### Server Component Data Fetching
- **Secrets in .env.local**: Only non-sensitive config (API endpoints)
- **Database Connections**: Create per-request connections; don't cache raw connections
- **CORS**: If frontend and backend are separate origins, configure CORS properly
- **Rate Limiting**: Consider adding rate limits to `/api/devices` endpoints

### Frontend Safety
- **RSC Serialization**: Be careful with Date objects and non-serializable values in Server Components
- **XSS Protection**: Next.js auto-escapes JSX; avoid dangerouslySetInnerHTML unless sanitized
- **Environment Variables**: NEXT_PUBLIC_* vars are exposed to browser; keep secrets in .env.local only

## Code Conventions

### File Naming
- **Components**: PascalCase (e.g., `DeviceList.tsx`, `StatusCard.tsx`)
- **Utilities**: camelCase (e.g., `deviceApi.ts`, `formatUtils.ts`)
- **API routes**: lowercase with slashes (e.g., `/api/devices/[id]/route.ts`)

### Component Structure
- **Client Components**: Add `'use client'` pragma at top of file
- **Server Components**: Default behavior; explicitly mark if needed
- **Props**: Use TypeScript interfaces for all component props

### Import Organization
1. React/Next.js imports
2. Third-party imports
3. Relative imports (from `@/` or `../`)

## When to Use @SecureDevAgent

- Adding new API endpoints
- Implementing input validation
- Handling sensitive data (IPs, device metadata)
- Updating dependencies for security patches
- Reviewing authentication/authorization logic

## Known Issues & Gotchas

1. **Node 18 Required**: npm install fails on older Node.js
2. **TypeScript Strict Mode**: All types must be explicit; no implicit `any`
3. **mysql2 Connection Per Request**: No connection pooling by default; consider adding for scale
4. **Streaming & Dynamic Routes**: Some patterns may cause unexpected behavior; test thoroughly

## Database Connection Pattern

```typescript
import mysql from 'mysql2/promise';

async function query(sql: string, values?: any[]) {
  const connection = await mysql.createConnection({
    host: process.env.MYSQL_HOST || 'localhost',
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE || 'mtr_dashboard',
  });
  
  try {
    const [rows] = await connection.execute(sql, values);
    return rows;
  } finally {
    await connection.end();
  }
}
```

Use **prepared statements** (shown above with `?` placeholders) to prevent SQL injection.

## Next Steps

- Implement additional pages (device list, device detail, MTR result visualization)
- Add client-side form validation for new devices
- Implement error boundary components
- Set up ESLint + Prettier for code formatting
- Add integration tests for API routes
