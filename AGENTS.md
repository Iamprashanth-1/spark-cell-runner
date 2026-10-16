# AGENTS.md

How an AI agent (Claude, ZCode, etc.) **uses** Spark Cell Runner as a tool. This is not a development guide — it is the operating manual: install it, create a pool, run notebooks and SQL, sync tables, inspect results.

**Repo / git user:** `Iamprashanth-1` (`Iamprashanth-1/spark-cell-runner`, default branch `master`). Commits and PRs are authored as `Iamprashanth-1 <58625465+Iamprashanth-1@users.noreply.github.com>`.

---

## What this tool is

Spark Cell Runner runs **Databricks notebook-source `.py` files** (cells split by `# COMMAND ----------`, magics like `%sql`, `dbutils`, etc.) and **plain SQL** in two ways:

| | **Local pool mode (default choice)** | **Databricks mode** |
| --- | --- | --- |
| Engine | Local [Sail](https://github.com/lakehq/sail) Spark Connect server — offline, ~1 s startup | Databricks serverless or cluster via `databricks-connect` |
| Tables | Local Delta / Iceberg warehouse on disk | Real Unity Catalog |
| Needs network | **No** | Yes |

It exists as two interchangeable frontends over the same engine:

1. **CLI** (`pip install spark-cell-runner`, alias `scr`) — what an agent should use in a terminal.
2. **VS Code extension** — for interactive cell-by-cell work by a human (packages as a `.vsix`).

Pools, warehouses, and profiles are **shared** between the two: a pool created via the CLI shows up in the extension sidebar and vice versa.

## Installation (one-time)

```bash
# CLI only (local pools, offline notebooks, SQL, sync to local warehouse)
pip install spark-cell-runner

# CLI + Databricks cloud runs (needs databricks-connect)
pip install "spark-cell-runner[databricks]"
```

Verify: `spark-cell-runner --version` (or `scr --version`). Requires Python 3.9+.

**Before the first pool:** the CLI does **not** auto-install the engine — you must install it into the Python env you'll point the pool at: `pip install pysail pyspark-client` (pysail 0.4+ for Iceberg). Only the VS Code extension auto-installs these when creating a pool.

**VS Code extension** (for humans, not agents): install `PrashanthReddyMunagala.spark-cell-runner` from the Marketplace or a `.vsix` from GitHub Releases. Key settings (all `sparkCellRunner.*`): `connectionMode` (`databricks`|`local`), `localPool`, `pythonCommand`, `syncFormat`. Full settings table in `README.md`.

## Core concepts you must know

- **Pool** — a named local Sail Spark Connect server on `sc://127.0.0.1:<port>`. One warehouse per pool. State lives in `~/.spark-cell-runner/pools/<name>.json` (the **manifest**: name, python command, port, warehouse path, pid, log file). Pools survive terminal/VS Code restarts; they are detached processes.
- **Warehouse** — `~/.spark-cell-runner/warehouse/<pool>/`, holding local **Delta** (`_delta_log/` marker) and **Iceberg** (`metadata/*.metadata.json` marker) tables. The explorer, preview, and sync all read directly from disk — tables survive pool restarts.
- **Sail metastore is session-scoped** (known limitation): named tables created with `saveAsTable` / `CREATE TABLE` lose their names when the pool restarts, but the files are durable and get re-registered from disk into new sessions. For stable names, write to explicit paths: `df.write.format('delta').save('mydb/mytable')`.
- **Two table formats** — everything is Delta *and* Iceberg aware (pysail 0.4+). Pick with `--format delta|iceberg` where applicable.
- **Databricks auth** — a profile in `~/.databrickscfg`, referenced by `--profile`; or `--serverless`; or `--cluster-id <id>`.

## Command reference (CLI, alias `scr`)

```text
spark-cell-runner pool create <name> [--python <py>] [--port <port>]
spark-cell-runner pool start <name>          # blocks until the port is serving
spark-cell-runner pool stop <name>
spark-cell-runner pool list
spark-cell-runner pool logs <name>           # tail of the Sail server log
spark-cell-runner pool delete <name>         # manifest only; warehouse kept

spark-cell-runner run <notebook.py> [--pool <name>] [--cells all|3|1-3]
                                            [--show|--no-show]
spark-cell-runner run <notebook.py> --profile <p> --serverless   # Databricks mode
spark-cell-runner run <notebook.py> --cluster-id <id> --profile <p>

spark-cell-runner sql <file.sql> [--pool <name>] [--limit <n>]   # '-' = stdin

spark-cell-runner sync --catalog <c> [--schema <s>] [--tables <glob>]
                       --mode schema|data --format delta|iceberg
                       [--limit <rows>] [--pool <name>]
                       [--profile <p> | --serverless | --cluster-id <id>]

spark-cell-runner explore --source local|databricks
                  --level catalogs|schemas|tables|table-details
                  [--catalog <c>] [--schema <s>] [--table <t>] [--pool <name>]

spark-cell-runner preview <table-dir-on-disk> [--format auto|delta|iceberg] [--limit <n>]
```

## Rules of thumb for agents

1. **Default to local pools.** Unless the task explicitly needs real Databricks compute or live Unity Catalog data, work offline: create a pool, run against it. It is fast, deterministic, and needs no credentials.
2. **Check pool state before running:** `spark-cell-runner pool list`. Start it if it's stopped. If a run fails to connect, check `pool logs <name>` before anything else.
3. **Notebook files must be in notebook-source format** (`# Databricks notebook source` header, `# COMMAND ----------` separators). If a user hands you a plain script, run it with Python directly — not with `run`.
4. **Prefer `explore` + `preview` for "what's in this table?" questions** — both emit machine-readable output (JSON / CSV). Read warehouse directories from `~/.spark-cell-runner/warehouse/<pool>/` when the pool is stopped; preview works straight off disk.
5. **`sync --mode schema` needs no cluster** (metadata only, no compute). `--mode data` copies rows and needs Databricks auth (`--profile` + `--serverless` or `--cluster-id`).
6. **Never echo secrets.** Profiles contain tokens; `dbutils.secrets.get` values are locally shimmed. Don't print profile contents or secret values into logs, commits, or replies.
7. **Windows quirks:** Iceberg `LOCATION` SQL literals need `file:///` URLs (backslashes are escapes); pool stop uses `taskkill /T /F` on the manifest PID.
8. **Version identity:** CLI version and the VS Code extension version are bumped together (currently 0.7.1). Report the `--version` you're on when troubleshooting.

## State on disk

```text
~/.spark-cell-runner/
  pools/<name>.json        Pool manifest (engine, python env, port, warehouse, pid)
  pools/logs/<name>.log    Sail server stdout/stderr — first place to look on failure
  warehouse/<pool>/        Local Delta / Iceberg tables of that pool
```

## Troubleshooting quick table

| Symptom | Fix |
| --- | --- |
| Run can't connect to pool | Pool stopped — `pool start <name>`; verify port with `pool list`. |
| `No module named 'pyspark'` in local mode | Sessions run in the **pool's** Python env, not yours — install `pysail pyspark-client` into the env from the manifest, or recreate the pool. |
| Named table not found after pool restart | Expected (session-scoped metastore); registry re-registers from disk on new sessions — retry, or address by path. |
| Sync auth/SDK errors | Verify the profile (`databricks auth profiles`), pool running, and `--serverless`/`--cluster-id` chosen. |
| Explorer/preview shows nothing | Check the warehouse directory on disk — `~/.spark-cell-runner/warehouse/<pool>/`. |
| SQL shows no results | Results render as CSV in the output; add `--limit` and rerun. |

## Reference material

- `README.md` — full architecture, VS Code extension usage, settings table, examples.
- `examples/` — runnable sample notebooks (`01_hello_spark.py` … `06_local_iceberg.py`, `test.sql`).
- `PUBLISHING.md` — release flow (only if asked to release).
