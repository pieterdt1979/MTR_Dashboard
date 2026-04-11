# Backend (Python) Guidelines

## Tech Stack

- **Python**: 3.13.9 (required)
- **Primary Modules**:
  - `mtr_poller.py` (299 lines): Main orchestrator with scheduler, MTR executor, database integration
  - `mongodb_utils.py` (88 lines): MongoDB query utilities
- **Key Dependencies**:
  - `schedule`: Cron-like scheduling (5-min polling intervals)
  - `pymongo`: MongoDB client for time-series storage
  - `mysql-connector-python`: MySQL client for device inventory
  - `pandas`, `numpy`: Data processing (optional, available)
  - `matplotlib`: Visualization (optional, available)
  - `python-dotenv`: Environment variable loading

## Project Structure

```
backend/
├── mtr_poller.py              # Main module (MySQLClient, MongoDBClient, MTRRunner, MTRPoller classes)
├── mongodb_utils.py           # Query utilities (MTRMetricsQuery class)
├── db_schema.sql              # MySQL schema (devices, polling_jobs tables)
├── requirements.txt           # Python package list
├── .env.example               # Environment template (copy to .env)
├── .gitignore                 # Excludes .env, *.log, __pycache__
└── mtr_poller.log             # Runtime log file (auto-generated)
```

## Setup & Execution

### 1. Install Dependencies

```bash
cd backend
python3 -m venv venv                    # Create virtual environment (optional but recommended)
source venv/bin/activate                # Activate on Linux/macOS
pip install -r requirements.txt
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your database credentials and config
```

**Key environment variables**:
```
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=your_password
MYSQL_DATABASE=mtr_dashboard

MONGODB_URI=mongodb://localhost:27017
MONGODB_DATABASE=mtr_metrics

POLLING_INTERVAL_MINUTES=5              # How often to run MTR on all devices
MTR_COUNT=10                            # Pings per hop in MTR output
MTR_TIMEOUT_SECONDS=30                  # Max seconds per MTR command
LOG_LEVEL=INFO                          # DEBUG, INFO, WARNING, ERROR
```

### 3. Initialize MySQL

```bash
mysql -u root -p < db_schema.sql
```

Creates:
- `devices` table: Device inventory (ip_address, hostname, is_active, timestamps)
- `polling_jobs` table: Polling run history (status, device counts, timestamps)

### 4. Run the Poller

```bash
python3 mtr_poller.py
```

The poller will:
- Schedule MTR runs every 5 minutes (or POLLING_INTERVAL_MINUTES)
- Fetch active devices from MySQL
- Execute MTR commands in parallel (10 concurrent workers)
- Store JSON results in MongoDB
- Clean up old records (configurable retention)
- Log to stdout and `mtr_poller.log`

**Graceful Shutdown**: Press Ctrl+C or send SIGTERM; poller will flush pending results and exit cleanly.

## Code Architecture

### mtr_poller.py

**Four main classes**:

1. **MySQLClient**
   - Manages device inventory from MySQL
   - Methods: `get_active_devices()`, `record_polling_job()`
   - Connection per operation (no pooling)

2. **MongoDBClient**
   - Stores MTR results as JSON documents in MongoDB
   - Methods: `insert_result(device_id, hostname, hops, timestamp)`, `cleanup_old_records(days)`
   - Auto-creates indexes on first write

3. **MTRRunner**
   - Executes `mtr -j` (json output) on a single device
   - Parses JSON hop data
   - Handles timeouts and command errors
   - Returns: `{'device_id': int, 'hops': list[dict], 'timestamp': datetime}`

4. **MTRPoller**
   - Main orchestrator using `schedule` library
   - Spawns ThreadPoolExecutor with 10 workers for parallel MTR execution
   - Logs all events (start, completion, errors)
   - Signal handlers for SIGINT/SIGTERM

**Concurrency Model**:
- Scheduler runs on main thread
- MTR execution on ThreadPoolExecutor (10 workers)
- Caution: Mixed asyncio + threads; be aware of GIL with CPU-bound work

### mongodb_utils.py

**Single main class**:

**MTRMetricsQuery**
- Queries and aggregates MTR results from MongoDB
- Methods:
  - `get_latest_results(device_id=None, limit=10)`
  - `get_results_by_time_range(start_time, end_time, device_id=None)`
  - `get_devices_with_data()`
  - `calculate_latency_stats(device_id, time_range_hours=24)`
- Auto-creates indexes on `device_id`, `timestamp`
- Handles ObjectId-to-string conversion for JSON serialization

## Security Guidelines for @SecureDevAgent

### Database Credentials
- ✅ Load from environment variables (`.env` file)
- ❌ Never hardcode credentials in source files
- ❌ Never commit `.env` to git (use `.gitignore`)

### Command Execution
- ✅ Safe: `subprocess.run(['mtr', '-j', ipaddr], args as list)`
- ❌ Dangerous: `subprocess.run(f'mtr -j {ipaddr}', shell=True)` (shell injection)
- Current implementation is safe; maintain this pattern

### Input Validation
- Validate all device IPs before executing MTR
- Regex pattern: `^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$`
- Validate port numbers (1-65535)
- Trim/sanitize all string inputs before database operations

### Dependency Security
- Run `pip list --outdated` regularly to check for updates
- Keep critical packages current: `pymongo`, `mysql-connector-python`
- Check CVE databases for known vulnerabilities
- Review updated packages in `requirements.txt` before merging

### Logging
- ✅ Log operation outcomes (device count, run duration, errors)
- ❌ Don't log device credentials or raw passwords
- ❌ Don't log full command lines with IPs (if sensitive)
- Use LOG_LEVEL to control verbosity (INFO for production, DEBUG for dev)

### Database Access Control
- MySQL: Use dedicated service account with minimum necessary privileges
- MongoDB: Enable authentication in production; use connection string with credentials in `.env`
- Restrict network access: Bind to localhost unless backend accessed remotely

## Code Conventions

### Naming
- **Files & Modules**: snake_case (mtr_poller.py, mongodb_utils.py)
- **Classes**: PascalCase (MySQLClient, MTRPoller, MTRRunner)
- **Functions & Variables**: snake_case (get_active_devices, device_count)
- **Constants**: UPPER_CASE (POLLING_INTERVAL_MINUTES, MTR_COUNT)

### Function Signatures
```python
def get_active_devices(self) -> list[dict]:
    """Fetch all active devices from MySQL.
    
    Returns:
        List of dicts: [{'id': 1, 'ip_address': '192.168.1.1', 'hostname': 'router'}, ...]
    """
    pass

def insert_result(self, device_id: int, hostname: str, hops: list, timestamp: datetime) -> None:
    """Insert MTR result into MongoDB."""
    pass
```

### Error Handling
```python
try:
    result = mtr_runner.run_mtr(device_ip)
except subprocess.TimeoutExpired:
    logger.error(f"MTR timeout for {device_ip}")
except Exception as e:
    logger.error(f"MTR failed for {device_ip}: {e}")
```

### Logging
```python
logger.info(f"Starting MTR poll run for {len(devices)} devices")
logger.debug(f"Device {device_id}: {device_ip}")
logger.warning(f"Device {device_id} unreachable")
logger.error(f"Database connection failed: {e}")
```

## Testing

**Currently not implemented.** Scope for future work:
```bash
pip install pytest pytest-asyncio  # Testing framework
pytest backend/tests/              # Run all tests
```

Suggested test modules:
- `test_mtr_poller.py`: Unit tests for MySQLClient, MongoDBClient, MTRRunner
- `test_mongodb_utils.py`: Tests for MTRMetricsQuery
- `test_integration.py`: End-to-end tests with mock databases

## Known Gotchas

1. **Mixed Async/Sync**: `mtr_poller.py` mixes asyncio + ThreadPoolExecutor; avoid adding pure async code without refactoring
2. **GIL Contention**: 10 workers may hit Python GIL with CPU-bound work; monitor performance
3. **Connection Per Operation**: No connection pooling; creates new connections on every query (acceptable for polling frequency)
4. **MongoDB Auto-Indexing**: Auto-creates indexes; monitor for large collections (may slow write performance)
5. **Timezone Handling**: Ensure MySQL and MongoDB use UTC; timestamps should be timezone-aware
6. **MTR Dependencies**: Requires `mtr` command-line tool installed on system; not all systems have it

## Running Locally (Development)

```bash
# Terminal 1: Start MongoDB (if using local instance)
mongod

# Terminal 2: Start MySQL (if using local instance)
mysql -u root -p

# Terminal 3: Run the poller
cd backend
source venv/bin/activate
python3 mtr_poller.py
```

Monitor `mtr_poller.log` for:
- Polling events (start/completion)
- Device counts
- Error messages
- Database connection issues

## Performance Tuning

- **Polling Interval**: Adjust POLLING_INTERVAL_MINUTES (default 5 min) based on device count
- **MTR Timeout**: Adjust MTR_TIMEOUT_SECONDS if network is slow (default 30 sec)
- **Worker Count**: Adjust ThreadPoolExecutor workers (default 10) based on system CPU cores
- **Database**: Add indexes on MongoDB `device_id` and `timestamp` for large result sets

## When to Use @SecureDevAgent

- Adding new database queries or operations
- Updating dependencies (security impact review)
- Handling device IPs or sensitive network data
- Refactoring for SOLID principles
- Implementing authentication/logging features

## Next Steps

- [ ] Implement test suite (pytest)
- [ ] Add Docker support for backend isolation
- [ ] Implement retry logic for failed MTR commands
- [ ] Add alerting for unreachable devices
- [ ] Implement result aggregation/analytics
- [ ] Add API for querying poller status and metrics
