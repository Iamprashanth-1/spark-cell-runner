# Spark Cell Runner — Examples

Databricks notebook-source `.py` files you can open with the extension
(`Spark Cell Runner: Open as Databricks Notebook`, or enable
*Open .py as notebook* in the sidebar) and run cell-by-cell.

| File | What it demonstrates | Works in |
| --- | --- | --- |
| `01_hello_spark.py` | First Spark session: ranges, SQL, DataFrames | Local pool and Databricks |
| `02_local_delta_warehouse.py` | Creating schemas and Delta tables in the local warehouse, inserting and querying | Local pool |
| `03_dbutils_and_widgets.py` | `dbutils.widgets`, `dbutils.fs`, `display()`, secrets placeholders | Local pool and Databricks |
| `04_uc_sync_query.py` | Querying tables synced from Unity Catalog | Local pool (after a UC sync) |
| `05_notebook_with_run.py` + `05_shared_utils.py` | `%run` notebook includes and shared functions | Local pool and Databricks |

## Running locally

1. Sidebar → **Connection** → switch to **Local pool**.
2. Create a pool (pick a venv — the extension offers to install
   `pysail` + `pyspark-client` into it) and start it.
3. Open any example above and run cells with the CodeLens buttons or
   right-click → *Run Current Cell*.

All examples write only inside the pool's own warehouse
(`~/.spark-cell-runner/warehouse/<pool>`), so they are safe to re-run and
easy to reset (delete the warehouse folder).
