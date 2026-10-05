# PostgreSQL-backed LASO integration

The integration lane validates LASO-Web's Python production server against current LASO `main` and its PostgreSQL durable-session implementation. The production request path remains:

```text
Browser -> Python LASO-Web -> LASO API -> PostgreSQL
```

LASO-Web has no PostgreSQL driver, DSN setting, database tables, or direct
connection. PostgreSQL is provisioned only for LASO and the integration test.

## CI lanes

The `Python PostgreSQL current LASO main` workflow checks out LASO `main` at
`65bb0b849351d3322413644f546556e116509372`. The Web application contains no PR
number, branch name, commit check, or candidate-specific behavior.

CI provisions PostgreSQL 16, creates run/attempt-specific application role,
databases, and schema names, then starts two LASO processes in
`multi_instance` mode. LASO instances start in sequence so the first applies
clean-database migrations before the second connects. The harness then starts
two independent `python3 server.py` processes, each configured with its own
LASO endpoint. Playwright uses separate Chromium browser contexts with Basic
authentication. PostgreSQL credentials are passed only to LASO configuration
and stripped from the Python web-process environments.

The main PostgreSQL browser suite exercises the two Python frontends and two
LASO processes against one durable store: shared ordered turns, SSE visibility,
replay after a frontend-process interruption with the browser-held cursor,
deep-link reload, close/read-only history, LASO restart,
standalone runs/history/details, workers, approval/decision, schedules empty
state, mobile interactions, and outage display. The isolated context case uses
a second fresh database with automatic reduction configured, alternates turns
between both browser/frontend/backend paths, and checks context-generation and
run-snapshot metadata without exposing payloads. Repeated service startup
against an already migrated database is included in the setup/restart path.

The separate legacy browser workflow checks compatibility against the pinned
SQLite-era LASO commit `3cf8bed43d841086d58716bad223e08d6bf22a74`. That build
does not advertise capabilities; the Python adapter returns
`advertised: false` and the session page falls back to actual route probing
instead of claiming support. Current LASO `main` no longer supports SQLite and
is exercised by the PostgreSQL workflow above.

## Local reproduction

Requirements: Python 3.10+, Node.js 22, CMake/Ninja, LASO C++ build
dependencies, PostgreSQL 16, and Playwright Chromium dependencies. Use fresh
clones and a disposable PostgreSQL instance. Create a unique role, database,
and schema; do not use a shared or production database.

Build the pinned current LASO `main` checkout and install browser dependencies:

```sh
git clone https://github.com/Registered-Agent-Attorney/LASO.git ../LASO
git -C ../LASO fetch origin 65bb0b849351d3322413644f546556e116509372
git -C ../LASO checkout --detach 65bb0b849351d3322413644f546556e116509372
cmake -S ../LASO -B ../LASO/build-postgres-e2e -G Ninja \
  -DCMAKE_BUILD_TYPE=Debug -DBUILD_TESTING=OFF -DLASO_INSTALL_SYSTEMD_UNIT=OFF
cmake --build ../LASO/build-postgres-e2e --target laso-server --parallel 2
npm ci
npx playwright install --with-deps chromium
```

Set isolated credentials in the environment (the harness does not print them):

```sh
export LASO_E2E_POSTGRES_DSN='host=127.0.0.1 port=55439 dbname=laso_web_test user=laso_web_test password=local_test_only'
export LASO_E2E_POSTGRES_SCHEMA=laso_web_test
export LASO_E2E_LASO_COUNT=2
export LASO_SOURCE_DIR=../LASO
export LASO_E2E_LASO_SERVER=../LASO/build-postgres-e2e/bin/laso-server
npm run test:e2e
```

The harness chooses free loopback ports and task-temporary LASO state, config,
and log directories. For the context-reduction case use a second new database
and schema and set `LASO_E2E_CONTEXT_REDUCTION=1`, then run:

```sh
LASO_E2E_POSTGRES_DSN='host=127.0.0.1 port=55439 dbname=laso_web_context user=laso_web_test password=local_test_only' \
LASO_E2E_POSTGRES_SCHEMA=laso_web_context LASO_E2E_LASO_COUNT=2 \
LASO_E2E_CONTEXT_REDUCTION=1 \
npm run test:e2e -- --grep 'PostgreSQL candidate'
```

Optional `LASO_E2E_POSTGRES_CTL`, `LASO_E2E_POSTGRES_DATA`,
`LASO_E2E_POSTGRES_PORT`, and `LASO_E2E_POSTGRES_SOCKET` can enable a local
PostgreSQL stop/start failure scenario. The harness accepts restart controls
only for a cluster data directory located under the isolated workspace. Hosted
CI does not control its PostgreSQL service; it tests LASO process restarts and
persistent database-backed recovery. An earlier local stop/start test against
the historical Core revision found LASO processes needed a restart after
PostgreSQL returned before API reads recovered; this has not been revalidated
against current Core.

## Historical queued-run observation (not revalidated on current Core)

An earlier combined-stack run against LASO commit
`568edd2c9934ad10553c822af977113227379931` observed a standalone run remain
`Queued` after LASO process restart, following successful context-reduction and
shared-session/restart scenarios. This is a historical finding for that Core
revision. It has not been revalidated against current Core
`65bb0b849351d3322413644f546556e116509372` and is not asserted as a current
limitation. The isolated ordinary/operator database and isolated reduction
database passed individually in that earlier run.

To run the combined full suite against current Core, configure a fresh dedicated
database and schema as above, then run:

```sh
LASO_E2E_CONTEXT_REDUCTION=1 LASO_E2E_LASO_COUNT=2 \
LASO_E2E_POSTGRES_DSN='host=127.0.0.1 port=55439 dbname=laso_web_repro user=laso_web_test password=local_test_only' \
LASO_E2E_POSTGRES_SCHEMA=laso_web_repro npm run test:e2e
```

The historical run used LASO
`568edd2c9934ad10553c822af977113227379931`, PostgreSQL 16.15, the
`recent-turns` reducer with `threshold_bytes: 1800`, `target_bytes: 1600`,
`max_input_bytes: 16384`, and `timeout_ms: 30000`. The context-generation test
and shared-session/restart test passed; the next standalone `hello` run remained
`Queued` at the browser's 30-second completion assertion. This result is kept
as a historical observation only; current Core behavior remains unverified
until the combined scenario is rerun against the pinned current revision.

The PostgreSQL lane also does not mutate schedules: its deterministic fixture
validates the supported empty-list state. LASO owns migration compatibility,
worker fencing, cross-instance ordering, and database recovery semantics.
