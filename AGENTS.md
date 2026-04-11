# MTR Dashboard Project Guidelines

## Project Overview

**MTR Dashboard** is a network monitoring application that periodically polls devices to perform MTR (My Traceroute) diagnostics and visualizes the results. It consists of:

- **Frontend**: Next.js 16.2.3 web interface (React 19, TypeScript, TailwindCSS)
- **Backend**: Python async polling service (MongoDB + MySQL for dual storage)

Data flows: Backend polls devices from MySQL → runs MTR commands in parallel → stores JSON results in MongoDB → Frontend API queries and displays.

## Tech Stack Quick Reference

| Layer | Tech | Version | Key Note |
|-------|------|---------|----------|
| **Frontend** | Next.js | 16.2.3 | Breaking changes from older versions—read `node_modules/next/dist/docs/` |
| **Backend** | Python | 3.13.9 | ThreadPoolExecutor for concurrency; mixed async/sync execution model |
| **Storage** | MongoDB | 4.12.0 | Time-series MTR results (document storage) |
| **Storage** | MySQL | 9.2.0 | Device inventory (transactional storage) |

## Directory Structure

```
MTR_Dashboard/
├── backend/
│   ├── mtr_poller.py           # Main orchestrator: scheduler, MTR executor, DB integration
│   ├── mongodb_utils.py        # MongoDB query utilities for MTR metrics
│   ├── db_schema.sql           # MySQL schema (devices, polling_jobs tables)
│   ├── requirements.txt        # Python dependencies
│   └── .env.example            # Configuration template
├── frontend/
│   ├── app/
│   │   ├── api/devices/route.ts   # Device CRUD endpoints
│   │   ├── layout.tsx             # Root layout (Geist font)
│   │   ├── page.tsx               # Home page (boilerplate)
│   │   └── globals.css            # TailwindCSS global styles
│   ├── package.json
│   ├── tsconfig.json
│   ├── next.config.ts
│   ├── AGENTS.md                # Frontend-specific guidance
│   └── README.md                # Next.js boilerplate docs
└── AGENTS.md                    # <-- You are here
```

## Build & Test Commands

### Frontend Setup

```bash
cd frontend
npm install                 # Install dependencies (Node 18+)
npm run dev               # Start dev server (http://localhost:3000)
npm run build             # Production build
npm start                 # Run production build
```

### Backend Setup

```bash
cd backend
pip install -r requirements.txt  # Python 3.13+ required

# Copy environment template
cp .env.example .env
# Edit .env with your MySQL and MongoDB credentials

# Initialize MySQL
mysql -u user -p < db_schema.sql

# Run the poller (scheduler + MTR executor)
python3 mtr_poller.py
```

### Database Initialization

**MySQL** stores device inventory and polling job history:
```sql
mysql < backend/db_schema.sql
```

**MongoDB** is automatically created on first write; ensure connection string is correct in `.env`.

## Security Baseline (Critical for @SecureDevAgent)

### Backend (Python)

- **Input Validation**: MTR command construction escapes shell injection risk (uses subprocess with list args, not shell=True)
- **Database Connections**: Use environment variables for credentials (`.env` file); never hardcode
- **API Security**: Frontend API endpoints must validate device ownership before returning data
- **Dependency Management**: Keep packages current; run `pip list --outdated` regularly
- **Logging**: Sensitive data (IPs, credentials) should NOT appear in logs; use log filters if needed

### Frontend (Next.js)

- **API Routes**: All `/api/devices` endpoints must validate request origin and user context
- **SQL Injection**: Use parameterized queries for all MySQL operations (mysql2 supports prepared statements)
- **XSS Protection**: TailwindCSS + Next.js auto-escapes JSX by default; avoid dangerouslySetInnerHTML
- **Secrets Management**: Never commit `.env` to git; use `.env.example` for template only
- **CORS**: Restrict backend API calls to same origin if deployed

### Monorepo Separation

- Frontend and backend should have separate `.env` files
- Frontend `.env.local` communicates only with backend API
- Backend `.env` contains direct database credentials (not exposed to frontend)

## Code Conventions

### Naming
- **Backend**: snake_case (files, functions, variables)
- **Frontend**: PascalCase (components), camelCase (functions, variables)
- **Database**: snake_case columns, lowercase collection names

### API Responses
All endpoints use consistent JSON envelope:
```json
{
  "success": boolean,
  "data": { /* response payload */ },
  "error": "error message if success=false",
  "count": /* optional: item count for lists */
}
```

### Error Codes
- `200 OK`: GET/POST success
- `201 Created`: New resource created
- `400 Bad Request`: Validation error
- `409 Conflict`: Duplicate resource
- `500 Server Error`: Unhandled exception

### Concurrency Model
- **Backend**: ThreadPoolExecutor with 10 workers (mtr_poller.py) for parallel MTR execution
- **Frontend**: Standard Node.js async/await; new MySQL connection per request
- **Caution**: Mixed asyncio + threads in backend; be aware of GIL limitations with CPU-bound work

## Configuration & Environment

All config via environment variables (see `backend/.env.example`):

```
# MySQL
MYSQL_HOST=localhost
MYSQL_USER=root
MYSQL_PASSWORD=your_password
MYSQL_DATABASE=mtr_dashboard

# MongoDB
MONGODB_URI=mongodb://localhost:27017
MONGODB_DATABASE=mtr_metrics

# Polling
POLLING_INTERVAL_MINUTES=5      # Interval between MTR runs
MTR_COUNT=10                     # Ping count per hop
MTR_TIMEOUT_SECONDS=30           # Max seconds per MTR command

# Logging
LOG_LEVEL=INFO                   # DEBUG, INFO, WARNING, ERROR
```

Frontend has no secrets in `.env.local` (config via API calls to backend).

## Testing

**Currently not implemented.** Scope for future work:
- Backend: pytest for mtr_poller.py and mongodb_utils.py
- Frontend: Jest/React Testing Library for components and API routes

## Documentation References

| Topic | Document | Status |
|-------|----------|--------|
| Next.js Breaking Changes | `frontend/AGENTS.md` | ✅ Read first |
| Database Schema | `backend/db_schema.sql` | ✅ Source of truth |
| Environment Setup | `backend/.env.example` | ✅ Template |
| Frontend README | `frontend/README.md` | ⚠️ Generic boilerplate |

## When to Use @SecureDevAgent

Invoke `@SecureDevAgent` when:
- Adding new API endpoints or database queries (security review before merge)
- Updating dependencies (check for security advisories)
- Handling user input or device data (validate all inputs)
- Implementing authentication/authorization (user context validation)
- Refactoring for SOLID principles (reduce security surface area)

## Known Gotchas

1. **Next.js 16.2.3 Breaking Changes**: See `frontend/AGENTS.md`—don't assume patterns from older Next.js docs
2. **Mixed Async/Sync in Backend**: `mtr_poller.py` mixes asyncio + ThreadPoolExecutor; be careful with shared state
3. **Connection Pooling**: Frontend creates new MySQL connections per request; consider connection pool if scaling
4. **MongoDB Auto-Indexing**: MTRMetricsQuery auto-creates indexes; monitor for large collections
5. **No Client-Side Auth Yet**: Frontend API has no authentication; add before production deployment

## Going Forward

- [ ] Implement test suite (pytest backend, Jest frontend)
- [ ] Add API documentation (OpenAPI/Swagger)
- [ ] Configure Docker + docker-compose for local development
- [ ] Add CI/CD pipeline (GitHub Actions)
- [ ] Implement user authentication and role-based access control
- [ ] Add deployment guides (cloud providers)
