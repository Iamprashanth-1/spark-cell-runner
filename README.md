# Spark Cell Runner (VS Code extension)

Run **Databricks notebook-source `.py` files** (and `.ipynb` notebooks)
cell-by-cell from VS Code — against a remote Databricks workspace through
**Databricks Connect**, or **fully offline** against a **local Spark pool**
powered by [**Apache Sail™ (lakehq/sail)**](https://github.com/lakehq/sail), a
Rust-based Spark engine that speaks the **Spark Connect** protocol natively.
Both modes give you a Jupyter-like experience backed by persistent
per-notebook Python sessions, with a Databricks compatibility shim so
notebook code runs unchanged.

```text
                          VS Code (this extension)
  ┌────────────────────────────────────────────────────────────────┐
  │  notebook editor / .py source     sidebar webview   commands   │
  │        │                                │                │      │
  │        ▼                                ▼                │      │
  │   scriptBuilder ──► session (JSON over stdio) ◄──── ─────┘      │
  │                          │                                      │
  │                     session_driver.py (persistent python proc) │
  │                          │   bootstrap.py + runtime_data.py     │
  └──────────────────────────┼──────────────────────────────────────┘
                             │
        ┌────────────────────┴─────────────────────┐
        ▼ databricks-connect                       ▼ Spark Connect (sc://127.0.0.1:<port>)
  Databricks serverless / cluster          Local Sail pool (lakehq/sail, Rust engine)
  (cloud, Unity Catalog)                   (offline, Delta warehouse on local disk)
                                                   │
                                     ┌─────────────┴──────────────┐
                                     ▼                            ▼
                              ~/.spark-cell-runner/warehouse   Docker/Podman
                              (local Delta tables)             stack (FileBrowser UI)
```

## Features

- **Cell-level execution** of Databricks notebook-source files: run current
  cell, run all, run-to-cursor, with per-cell decorations, CodeLenses, and a
  results panel (stdout / stderr / generated script).
- **Two connection modes**: Databricks (serverless or cluster via
  databricks-connect) or a **local Spark pool** that needs no cloud access.
- **Databricks compatibility shim**: `%sql` / `%sh` / `%pip` / `%fs` / `%md`
  magics, `%run` expansion, `dbutils` proxies (widgets, secrets, fs,
  notebook, library), `/Workspace/...` and `/Volumes/...` path translation.
- **Local Spark pools**: named Sail servers with manifests, logs, lifecycle
  control, and warehouse isolation — all managed from the sidebar.
- **Unity Catalog sync**: mirror dev catalogs/schemas/tables into the local
  warehouse (schema-only, or schema + data with a row limit).
- **Lakehouse container**: expose the warehouse to Docker/Podman Desktop as a
  browsable web UI.

## Quick start

1. Install the `.vsix` (see *Build and install* below) and open the
   **Spark Cell Runner** view in the activity bar.
2. Pick a Python environment (a venv with `databricks-connect` for cloud
   mode, or any venv for local mode — the extension offers to install
   `pysail` + `pyspark-client` into it).
3. Choose a connection mode in the sidebar's **Connection** section:
   - **Databricks** — set your cluster ID or enable serverless; needs a
     `~/.databrickscfg` profile.
   - **Local pool** — click *Create a local pool*, pick the venv and port,
     then *Start*. Runs are fully offline.
4. Open a notebook-source `.py` file and run cells.

## Architecture

### Run pipeline

1. **Parsing** (`parser.js`) — notebook-source `.py` files are split into
   cells on `# COMMAND ----------` separators; `# MAGIC` lines are decoded
   into magics (`%sql`, `%pip`, ...).
2. **Script building** (`scriptBuilder.js`) — each run compiles a flat
   Python script: prior-cell context (or replay of executed cells),
   translated magics, and expanded `%run` includes (parsed recursively and
   cached in `state.globalIncludeCache`).
3. **Session** (`session.js` + `src/python/session_driver.py`) — one
   long-lived Python process per notebook, speaking a JSON-line protocol over
   stdio (`{"type":"exec","id","code"}` → `{"type":"result","id","ok",...}`).
   State persists across cells, Jupyter-style. The session is keyed by
   notebook URI and a **config signature** (interpreter, profile, cluster,
   connection mode, pool) — changing any of those transparently recycles the
   process. In local mode the session runs in the pool's environment, so the
   interpreter shown in the status bar may differ from `pythonCommand`.
4. **Bootstrap** (`src/python/bootstrap.py`, assembled by `pyResources.js`)
   — executed inside the session on first use. It creates `spark`/`sql`
   (either `DatabricksSession.builder...` or
   `SparkSession.builder.remote("sc://127.0.0.1:<port>")` depending on
   `connectionMode`), installs the `dbutils` proxies, and monkeypatches
   `builtins.open` / `os.path` so Databricks-style paths resolve to mapped
   local folders (see `workspacePathMappings`).
5. **Results** (`runner.js`, `ui/decorations.js`, `ui/resultPanel.js`) —
   output is captured per cell into decorations and a results webview; the
   generated script and result text are written under `tempFolder`.

The session's wire protocol (JSON lines over stdio, defined by
`session_driver.py` and `session.js`) is deliberately tiny:

```text
--> {"type": "exec", "id": 3, "code": "<base64 python>"}
<-- {"type": "ready"}                                  (once, at startup)
<-- {"type": "result", "id": 3, "ok": true,
     "stdout": "...", "stderr": "..."}
```

Because both sides of the connection live in the selected Python environment,
the protocol is the only coupling point — swapping the Spark engine (Sail vs
Databricks) or the connection mode never changes it.

### Data and state on disk

```text
~/.spark-cell-runner/
  pools/
    <name>.json          Pool manifests (engine, env, port, warehouse, pid)
    logs/<name>.log      Sail server stdout/stderr per pool
  warehouse/
    <pool>/              Local Delta warehouse of that pool
      docker-compose.yml Generated lakehouse container stack
      .filebrowser.db    FileBrowser login database (container stack)
      .filebrowser-credentials.txt
                         Generated UI login, re-applied on every launch
      demo/...           Schemas and Delta tables written by notebooks
```

Everything above lives outside the workspace, so pools are shared across
projects and survive VS Code restarts. Generated scripts and result text
per workspace go to `<workspace>/sparkCellRunner.tempFolder` (default
`.spark-cell-runner/`).

## Examples

Runnable sample notebooks live in [`examples/`](examples/README.md):

- `01_hello_spark.py` — first Spark session, DataFrames, SQL (works in both modes).
- `02_local_delta_warehouse.py` — schemas and Delta tables in the local warehouse.
- `03_dbutils_and_widgets.py` — widgets, `dbutils.fs`, `display()`, secrets shim.
- `04_uc_sync_query.py` — querying tables synced from Unity Catalog, offline.
- `05_notebook_with_run.py` + `05_shared_utils.py` — `%run` includes.

Open any of them with *Spark Cell Runner: Open as Databricks Notebook* and
run cell-by-cell.

Python compatibility floor: **3.10** (all resources are compile-checked
against it).

### Local Spark pools

A pool is a detached Sail Spark Connect server
(`python -m pysail spark server --ip 127.0.0.1 --port <port>`) plus a JSON
manifest in `~/.spark-cell-runner/pools/<name>.json`:

```json
{
  "name": "local",
  "engine": "sail",
  "pythonCommand": "C:\\...\\.venv\\Scripts\\python.exe",
  "port": 51234,
  "warehousePath": "C:\\Users\\<you>\\.spark-cell-runner\\warehouse\\local",
  "pid": 12345,
  "logFile": "...\\pools\\logs\\local.log"
}
```

- Manifests live in the user home, so pools are shared across workspaces and
  survive VS Code restarts; the server process is detached from the
  extension host.
- `poolManager.js` handles creation (name validation, free-port selection,
  warehouse creation), start (health-checked by probing the Spark Connect
  port), stop (PID kill, `taskkill /T /F` on Windows), and per-pool logs.
- The server's working directory is pinned to its warehouse, so managed
  tables and `spark-warehouse/` defaults land inside the pool's own folder.
- `bootstrap.py` sets `spark.sql.warehouse.dir` to the warehouse path, so
  `saveAsTable` writes local Delta tables. Schema must exist first
  (`CREATE SCHEMA IF NOT EXISTS ...`), matching Databricks behavior.
- Pools are selected via `sparkCellRunner.localPool`; the sidebar card shows
  status and offers start/stop/logs/delete/switch. Installing `pysail`
  happens into a venv you choose (never silently into a random interpreter).
- In local mode, notebook sessions deliberately run in the **pool's own
  Python environment** — that's where the matching `pyspark` client lives —
  regardless of the general `pythonCommand` setting.

### Why Sail?

The local pool runs **[Sail](https://github.com/lakehq/sail)** (PyPI package
`pysail`) as the Spark engine:

- **No JVM, no cluster** — Sail is a single Rust process installed with
  `pip install pysail`; a pool starts serving Spark Connect in about a second.
- **Spark Connect protocol** — notebook sessions are ordinary PySpark clients
  (`SparkSession.builder.remote("sc://127.0.0.1:<port>")`), the same protocol
  Databricks uses, so cell code stays engine-agnostic.
- **Delta tables on local disk** — Sail writes Delta-format tables into the
  pool's warehouse directory; that's what the lakehouse container browses and
  what UC sync populates.
- **Swappable by design** — the pool manifest records `engine`, and the
  bootstrap only needs a Spark Connect endpoint, so a future pool can point
  at any Spark-Connect-compatible engine without touching notebook code.

### Unity Catalog explorer

A second tree view, **Unity Catalog**, browses catalogs/schemas/tables/columns
from one of two sources — switch with the swap button in the view title:

- **Databricks** — real Unity Catalog over the REST SDK (no compute needed;
  uses `databricksProfile`). Right-click a table → *Sync This Table* to pull
  just that table into the local pool (schema or schema+data).
- **Local warehouse** — reads the pool's Delta **files on disk** directly.
  Sail's metastore is session-scoped (tables created in one session vanish
  from the catalog in the next), but the Delta files are durable, so the
  explorer always shows what actually exists — the same view the lakehouse
  container gives you. No pool connection required.
- **Auto** (default) — local when the pool is running, Databricks otherwise.

The Python environment picker is also connection-mode aware: in local mode it
validates `pysail` + `pyspark` (Sail pool ready), in Databricks mode it
validates `databricks-connect` and workspace auth — so you always see the
requirements that actually apply to the mode you picked.

### Unity Catalog sync

`ucSync.js` spawns `src/python/uc_sync.py` as a one-shot process (deliberately
separate from notebook sessions). It reads metadata over REST with the
Databricks SDK and writes to the pool over Spark Connect, streaming JSON
progress lines back to the extension.

- **schema mode** — recreates catalogs/schemas and *empty* Delta tables with
  identical columns/types. No cluster needed; notebooks run end-to-end with
  local data only.
- **data mode** — additionally copies rows: a Databricks session reads the
  remote table (honoring `useServerless`/`clusterId`), the pool writes it as
  Delta. Use `syncRowLimit` for dev-sized samples.
- Filters (`syncCatalog`, `syncSchema`, `syncTables` glob, mode, limit) are
  workspace settings, so syncs are reproducible per project.

### Lakehouse container

`containerManager.js` detects Docker, then Podman, and generates a Compose
project `spark-cell-runner-<pool>` that bind-mounts the pool warehouse into
`filebrowser/filebrowser`. Compute stays native via the pool; no JVM images
are pulled. Historically this stack used MinIO, which had to be abandoned
when MinIO revoked anonymous access to its container images (quay.io 401,
Docker Hub org removed).

When the stack is running:

| | |
| --- | --- |
| **Warehouse UI URL** | `http://localhost:<port>` (the port is picked automatically at first launch and shown in the sidebar and launch notification) |
| **Username** | `admin` |
| **Password** | Auto-generated on first launch — stored in `<warehouse>/<pool>/.filebrowser-credentials.txt` and shown in the launch notification |

> **Why not `admin`/`admin`?** Recent FileBrowser releases generate a random
> admin password on first boot and require 12+ character passwords, so fixed
> defaults are rejected. Instead, the extension owns the credentials: it
> generates a password once, stores it in the credentials file next to the
> warehouse, and re-applies it to FileBrowser on every launch while the
> server is stopped. To change the password, edit the `password:` line in the
> credentials file and relaunch the stack (or change it in the FileBrowser UI
> — but the next launch re-applies the file's value). The stack listens on
> localhost only; do not port-forward or share it beyond your machine.

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `pythonCommand` | `python` | Interpreter (path or command) used for sessions, pools, and sync. |
| `tempFolder` | `.spark-cell-runner` | Workspace folder for generated scripts and results. |
| `injectDatabricksBootstrap` | `true` | Inject the bootstrap that creates `spark`/`sql`/`dbutils`. |
| `databricksProfile` | *(empty)* | `~/.databrickscfg` profile for Databricks auth. |
| `clusterId` | *(empty)* | Cluster ID for databricks-connect runs. |
| `useServerless` | `false` | Use serverless instead of `clusterId`. |
| `connectionMode` | `databricks` | `databricks` or `local` (Sail pool). |
| `localPool` | *(empty)* | Name of the active local pool. |
| `workspacePathMappings` | `{}` | Map `/Workspace/...`-style paths to local folders. |
| `secretValues` | `{}` | Local replacements for `dbutils.secrets.get`, keyed `scope/key`. |
| `widgetValues` | `{}` | Values for `dbutils.widgets`, editable in the sidebar. |
| `openPyFilesAsNotebook` | `false` | Open `.py` files directly in the notebook view. |
| `syncCatalog` / `syncSchema` / `syncTables` | *(empty)* | UC sync filters (empty = all). |
| `syncMode` | `schema` | `schema` or `data`. |
| `syncRowLimit` | `0` | Max rows per table in data mode (0 = unlimited). |

## Commands

All commands are under the **Spark Cell Runner** category:

| Command | Purpose |
| --- | --- |
| `Open as Databricks Notebook` | Open a `.py` source file in the notebook view. |
| `Run Current Cell` / `Run All Cells` / `Run Notebook to Current Cell` | Cell execution. |
| `Preview Current Cell Script` | Inspect the generated flat script. |
| `Show Cell Output` | Reopen the results panel for a cell. |
| `Restart Notebook Session` | Recycle the persistent Python process. |
| `Select Python Environment` / `Set Python Path` / `Use Active VS Code Interpreter` | Interpreter management. |
| `Set Cluster ID` / `Toggle Serverless Mode` / `Set Connection Mode` | Connection targets. |
| `Create / Start / Stop / Delete Local Spark Pool`, `Show Pool Logs` | Pool lifecycle. |
| `Install Local Pool Packages` | Install `pysail` + `pyspark-client` into a venv you pick. |
| `Sync Unity Catalog to Local Pool` | Schema/data sync from dev UC. |
| `Launch / Stop Lakehouse Container`, `Open Warehouse UI` | Docker/Podman stack. |

## Project layout

```
src/
  extension.js        Entry point: activate()/deactivate() wiring only
  constants.js        Shared constants and magic-line regexes
  state.js            Shared mutable singletons (sessions, caches, sync result)
  config.js           sparkCellRunner configuration access + helpers
  commands.js         All vscode.commands registrations
  parser.js           Notebook-source parsing, cell splitting, magic handling
  serializer.js       Notebook <-> "# Databricks notebook source" .py serialization
  codelens.js         Run / preview CodeLenses in the text editor view
  navigation.js       Go to Definition / Find References remapping for cells
  scriptBuilder.js    Generated-script construction, %run expansion, magic translation
  session.js          Persistent per-notebook python sessions (JSON stdio protocol)
  runner.js           Run orchestration + notebook controllers
  pythonEnv.js        Interpreter discovery, Databricks Connect validation, child env
  poolManager.js      Local Spark pool manifests + Sail server lifecycle
  ucSync.js           Unity Catalog -> local pool sync orchestration
  containerManager.js Docker/Podman compose stack (FileBrowser over the warehouse)
  pyResources.js      Loads the Python templates and injects settings
  python/
    bootstrap.py      Session bootstrap: spark/sql, dbutils proxies, path translation
    runtime_data.py   Per-run widget/secret/path-mapping values (template)
    session_driver.py Long-lived python process executing code blocks over stdio
    uc_sync.py        One-shot UC -> pool sync driver (JSON progress on stdout)
  ui/
    sidebar.js        Activity-bar webview (sections: connection, pools, sync,
                      lakehouse, widgets, actions; plus a settings view)
    statusBar.js      Status bar item (interpreter / profile / cluster)
    decorations.js    Per-cell run state decorations + run-state store
    resultPanel.js    Results webview (summary / stdout / stderr / script)
examples/             Runnable sample notebooks (see examples/README.md)
test/                 Sample notebooks, UI previews (npm run preview:ui)
```

## Build and install the extension

Requires Node.js and the [vsce](https://github.com/microsoft/vscode-vsce) CLI
(one-time setup):

```bash
npm install -g @vscode/vsce
```

Build a `.vsix` package from the repo root:

```bash
npm run package        # or: vsce package
```

Install it into VS Code (uninstall any older version first so cached assets
such as the icon refresh cleanly):

```bash
code --uninstall-extension PrashanthReddyMunagala.spark-cell-runner
code --install-extension spark-cell-runner-0.3.1.vsix
```

Then fully quit and restart VS Code (not just **Developer: Reload Window**) —
the Extensions view caches extension icons until a full restart. To uninstall:
`code --uninstall-extension PrashanthReddyMunagala.spark-cell-runner`.

> No build/compile step is needed — the extension is plain CommonJS JavaScript
> plus Python resources in `src/python/`, which `vsce` packages as-is
> (see `.vscodeignore`).

## Development and testing

- `npm run preview:ui` renders the sidebar and results-panel HTML to
  `test/preview/` — open it in a browser to iterate on the UI with no reload.
- **F5** launches an Extension Development Host on the `test/` workspace with
  sample notebooks (widgets, `%sql`, `%run`).
- JS changes need an extension-host reload (**Ctrl+R** in the dev host);
  `src/python/*.py` template changes are picked up on the next run.
- Python resources must stay compatible with **Python 3.10+** — avoid
  Python-3.12-only f-string syntax (nested same-type quotes) and check with
  `py -3.10 -m py_compile src/python/*.py`.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `SyntaxError: f-string: unmatched '('` or similar at bootstrap | The runner environment is older than Python 3.12 and the bootstrap regressed to 3.12-only syntax — update the extension; fixed since 0.3.0. |
| `NameError: dcr_original_isfile` at bootstrap | Fixed since 0.3.0 (definition was used before assignment). |
| `Databricks Connect bootstrap unavailable` | The selected env lacks `databricks-connect`, or auth failed. Pick another env or switch to a local pool. |
| `Local Spark pool "x" did not open port ...` | The Sail server failed to boot — check the pool log (sidebar → *Pool logs*), often a missing `pysail` install or a port conflict. |
| `quay.io ... 401 Unauthorized` when launching the lakehouse stack | Old extension version using MinIO images; update — the stack now uses `filebrowser/filebrowser`. |
| Sync fails with SDK/auth errors | Verify the `databricksProfile` works (`databricks auth login`), and that the pool is running. |
| The "open .py as notebook" toggle doesn't change how files open | The toggle writes `workbench.editorAssociations` (workspace settings; falls back to user settings when no folder is open). If a User-level `*.py` association overrides it, remove that entry — workspace should win. Fully restart VS Code after switching. |

## License

[MIT](LICENSE)
