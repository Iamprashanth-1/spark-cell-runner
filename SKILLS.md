# SKILLS.md

Step-by-step playbooks for an AI agent **operating** Spark Cell Runner — installing it, running notebooks and SQL on local pools, syncing Unity Catalog, and inspecting data. Each skill is a task an agent can execute end-to-end in a terminal (CLI alias: `scr`). For concepts and rules of thumb, read [AGENTS.md](AGENTS.md).

---

## Skill 1: Set Up and Verify the Toolchain

**Trigger:** first use in a fresh environment, or "is this working?"

1. Check install: `spark-cell-runner --version`. If missing: `pip install spark-cell-runner` (add `[databricks]` extra only if cloud runs are needed).
2. List pools: `spark-cell-runner pool list` — shows existing pools, ports, and whether they're running. Pools are shared globally in `~/.spark-cell-runner/pools/`, so a pool from any previous session may already exist.
3. If no pool exists, continue with Skill 2.
4. Smoke test: create/ensure a pool, then run `examples/01_hello_spark.py` against it (Skill 3).

**Success looks like:** `--version` prints 0.7.x; `pool list` shows at least one pool; the hello-spark run prints a Spark version and a small DataFrame.

## Skill 2: Create and Start a Local Spark Pool

**Trigger:** any local/offline execution task. A pool must exist and be running first.

```bash
spark-cell-runner pool create dev          # optional: --python <path-to-venv-python>
spark-cell-runner pool start dev           # blocks until sc://127.0.0.1:<port> is serving
```

1. **Choose a Python env:** default is the current interpreter. To pin one (recommended), pass `--python /path/to/venv/Scripts/python.exe` (Windows) or `/path/to/venv/bin/python`. That env needs `pysail` + `pyspark-client` — `pool create` does **not** install them, so run `pip install pysail pyspark-client` in that env first if unsure.
2. Start the pool; note the port from the output / manifest.
3. Confirm: `spark-cell-runner pool list` shows the pool running. Problems → `spark-cell-runner pool logs dev`.
4. Pool names must be simple identifiers; they become folder names under the warehouse.

**Verify:** `pool list` marks the pool as running; `pool logs` shows the Sail server listening on its port.

**Lifecycle notes:** pools are detached processes — they keep running after your terminal exits. `pool stop dev` kills by PID (forceful on Windows). `pool delete dev` removes only the manifest; the warehouse on disk is kept.

## Skill 3: Run a Databricks Notebook Offline

**Trigger:** "run this notebook", "execute these cells", "test this notebook without Databricks".

```bash
spark-cell-runner run my_notebook.py --pool dev                 # all cells
spark-cell-runner run my_notebook.py --pool dev --cells 1-3     # cells 1..3
spark-cell-runner run my_notebook.py --pool dev --cells 2       # one cell
spark-cell-runner run my_notebook.py --pool dev --no-show       # suppress SQL result tables
```

1. Confirm the file is **notebook-source format**: first line `# Databricks notebook source`, cells separated by `# COMMAND ----------`, magics written as `# MAGIC %sql ...`. Plain scripts → run with plain `python` instead.
2. Run it against a running pool. State (variables, DataFrames) is shared across cells within the run, Jupyter-style.
3. Read the output: each cell reports stdout/stderr; SQL cells print result tables unless `--no-show`.
4. To run the same notebook on real Databricks instead: `--profile <profile> --serverless` (or `--cluster-id <id>`). No `--pool` in that case.

**Verify:** exit code 0; expected prints/results appear; any tables written land in `~/.spark-cell-runner/warehouse/dev/` (check with Skill 5).

## Skill 4: Run SQL Against a Pool

**Trigger:** "run this query", "create a table", "query the warehouse".

```bash
spark-cell-runner sql query.sql --pool dev
spark-cell-runner sql --pool dev --limit 50        # or pipe: echo "SELECT 1" | spark-cell-runner sql -
```

1. Write the SQL to a temp `.sql` file (or pipe via `-`). Multiple statements run in order.
2. Tables are addressable by name as `sail.<schema>.<table>` (the warehouse registry re-registers on-disk tables), or by path with `delta.\`<path>\`` / `iceberg.\`<path>\``.
3. Results render as CSV; a failing statement stops the run and prints its real error.
4. **Windows:** for Iceberg `CREATE TABLE ... LOCATION`, use a `file:///` URL — backslashes in SQL string literals are escapes.

**Verify:** the CSV rows appear and no error line is printed.

## Skill 5: Explore What Exists (catalogs / schemas / tables)

**Trigger:** "what tables are there?", "show me the schema of X" — before writing any query.

```bash
spark-cell-runner explore --source local --level catalogs --pool dev
spark-cell-runner explore --source local --level schemas --pool dev --catalog main
spark-cell-runner explore --source local --level tables  --pool dev --catalog main --schema demo
spark-cell-runner explore --source local --level table-details --pool dev --catalog main --schema demo --table orders
```

- Output is **JSON** — parse it, don't eyeball it.
- `--source local` reads the pool's warehouse **from disk** (works even when the pool is stopped). `--source databricks` lists real Unity Catalog via REST (needs `--profile`, no compute).
- Each table carries a format label (`delta` or `iceberg`).

## Skill 6: Preview Rows of a Local Table

**Trigger:** "what's in this table?", "show me sample rows" — works directly off disk.

```bash
spark-cell-runner preview ~/.spark-cell-runner/warehouse/dev/demo.db/orders --limit 20
spark-cell-runner preview <path> --format iceberg --limit 20    # force format if auto-detect fails
```

1. Path = the table **directory** on disk (a `<schema>.db/<table>` folder under the warehouse).
2. Format is auto-detected from `_delta_log/` vs `metadata/*.metadata.json`.
3. Output is CSV.

## Skill 7: Mirror Unity Catalog Locally (Sync)

**Trigger:** "work with our Databricks tables offline", "pull down a dev table".

```bash
# Schema only — empty tables with identical columns/types; NO compute needed
spark-cell-runner sync --catalog main --mode schema --pool dev

# Schema + data (rows), needs Databricks auth
spark-cell-runner sync --catalog main --schema sales --tables dim_* \
  --mode data --limit 10000 --format delta \
  --profile mydev --serverless --pool dev
```

1. Filters: `--catalog`, `--schema`, `--tables <glob>`; narrow them — data mode copies rows.
2. `--format delta|iceberg` picks the local format (default `delta`; needs pysail 0.4+ for iceberg).
3. Auth: exactly one of `--profile <p> --serverless`, `--profile <p> --cluster-id <id>`, or (profile default) implicit serverless.
4. Progress streams as JSON lines; wait for completion before using the tables.

**Verify:** `explore --source local --level tables` shows the synced tables; `preview` returns rows (data mode).

## Skill 8: Run on Real Databricks (Cloud Mode)

**Trigger:** task explicitly requires real Databricks compute or live UC data.

1. Prereqs: `pip install "spark-cell-runner[databricks]"`; a working profile in `~/.databrickscfg` — create one with `databricks auth login --profile <name>` (OAuth) or a PAT, then check with `databricks auth profiles`.
2. Run: `spark-cell-runner run nb.py --profile mydev --serverless` or `--profile mydev --cluster-id 0123-...`.
3. Everything else (cells, magics, output format) is identical to Skill 3 — the engine is the only thing that changes.
4. Sync from cloud to local is Skill 7.

**Verify:** the run completes against the cluster; no `databricks-connect` version-mismatch errors.

## Skill 9: Browse the Warehouse in a Browser UI

**Trigger:** human wants to visually browse table files (extension feature).

1. This is VS Code-extension-only: sidebar → pool → *Launch Lakehouse Container* (needs Docker or Podman).
2. It starts a `filebrowser/filebrowser` container bound-mounting the pool warehouse, localhost-only.
3. URL and credentials are printed on launch; the generated password is stored in `<warehouse>/<pool>/.filebrowser-credentials.txt`.
4. Stop it with *Stop Lakehouse Container*. Compute stays in the pool; the container is only a file browser.

## Skill 10: Diagnose and Recover

**Trigger:** anything fails. Order of operations:

1. **Read the pool log first:** `spark-cell-runner pool logs <name>` (full file: `~/.spark-cell-runner/pools/logs/<name>.log`).
2. **Check the manifest** `~/.spark-cell-runner/pools/<name>.json` — is the env the one you expect? Is the port stale?
3. `No module named 'pyspark'` → the pool's env lacks deps; install `pysail pyspark-client` into the env named in the manifest.
4. Connection refused → pool stopped; `pool start`. Port already in use → stop the other pool or recreate with `--port`.
5. Named table missing after restart → expected (session-scoped metastore); tables re-register from disk — retry, or address by path (Skill 4 fallback).
6. Still broken → `pool stop` + `pool start` for a clean Sail process (data on disk is safe; only the metastore resets).

## Skill 11: Clean Up

**Trigger:** "remove the test setup", end of a session.

```bash
spark-cell-runner pool stop dev      # kill the server process
spark-cell-runner pool delete dev    # drop the manifest (warehouse kept on disk)
```

- Deleting the warehouse itself = `rm -rf ~/.spark-cell-runner/warehouse/<pool>/` — **destructive, confirm with the user first.**
- Workspace temp outputs land in `<workspace>/.spark-cell-runner/` (gitignored) and can be removed freely.
