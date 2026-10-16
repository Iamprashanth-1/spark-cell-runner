# spark-cell-runner (Python CLI)

Run Databricks notebook-source `.py` cells and SQL from the terminal — against
Databricks (Databricks Connect) or fully offline on a local
[Sail](https://github.com/lakehq/sail) Spark pool — with Unity Catalog sync and
a local Delta / Iceberg warehouse. This is the pip-installable twin of the
[Spark Cell Runner VS Code extension](https://marketplace.visualstudio.com/items?itemName=PrashanthReddyMunagala.spark-cell-runner);
pools, warehouses, and Databricks profiles are shared between the two.

```bash
pip install spark-cell-runner
```

The command is also installed as the short alias **`scr`** — same CLI, five
fewer characters: `scr pool create dev`.

## Quickstart

```bash
# 1. Create and start a local pool (offline engine, ~1s startup, no JVM)
scr pool create dev
scr pool start dev

# 2. Run a Databricks notebook export, cell by cell (scr ... works everywhere)
spark-cell-runner run my_notebook.py --pool dev

# 3. Run SQL
spark-cell-runner sql query.sql --pool dev
echo "SELECT 1" | spark-cell-runner sql - --pool dev

# 4. Mirror Unity Catalog schemas/tables into the local warehouse
spark-cell-runner sync --catalog main --schema sales --mode schema
spark-cell-runner sync --catalog main --mode data --format iceberg --limit 10000

# 5. Explore and preview (JSON / CSV)
spark-cell-runner explore --source local --level tables --pool dev
spark-cell-runner preview ~/.spark-cell-runner/warehouse/dev/demo.db/orders
```

## Open table formats: Delta + Iceberg

The local warehouse supports both open table formats natively (requires
`pysail >= 0.4`):

| | Delta | Iceberg |
|---|---|---|
| Write (Python) | `df.write.format('delta').save(path)` | `df.write.format('iceberg').save(path)` |
| Write (SQL) | `CREATE TABLE t ... USING delta LOCATION '...'` | `CREATE TABLE t ... USING iceberg LOCATION '...'` |
| Time travel | `VERSION AS OF 0` / `versionAsOf` option | `snapshotId` / `branch` / `tag` options |
| On-disk marker | `_delta_log/` | `metadata/*.metadata.json` |

A directory with either marker is a table: the warehouse registry re-registers
on-disk tables (both formats) into every new session, the Unity Catalog
explorer shows the format per table, and previews auto-detect the format.
The `sync` command and the extension's `sparkCellRunner.syncFormat` setting
choose the local format for UC sync (default `delta`).

## Running on Databricks instead

```bash
spark-cell-runner run my_notebook.py --serverless
spark-cell-runner run my_notebook.py --cluster-id 1234-567890 --profile DEFAULT
```

Requires the `databricks-connect` extra: `pip install "spark-cell-runner[databricks]"`.

## Shared state with the VS Code extension

- Pools: `~/.spark-cell-runner/pools/<name>.json` (create from either side)
- Warehouses: `~/.spark-cell-runner/warehouse/<pool>/`
- Databricks profiles: `~/.databrickscfg`

## Notebook magic support

`%sql` (shown via `result.show()`), `%md` (skipped), `%python`, `%pip`
(reported, not auto-installed), `%sh`, and `%run` (reported) are handled;
plain Python cells execute against the shared session namespace.

## Development

```bash
cd python
pip install -e ".[dev]"
pytest tests
```

MIT License — see the repository for details.
