# Databricks notebook source
# Example 04 — Query tables synced from Unity Catalog
# Prerequisite: run "Spark Cell Runner: Sync Unity Catalog to Local Pool"
# (sidebar → Unity Catalog sync) with connectionMode = local. This notebook
# then joins the *local copies* of your dev tables — no cloud access needed.

# COMMAND ----------
# Cell 1: see what the sync brought over. Schema-only sync creates empty
# Delta tables with the real column layout; data mode copies rows too.
dbs = [db.name for db in spark.catalog.listDatabases()]
print('Databases:', dbs)

# COMMAND ----------
# Cell 2: inspect a synced table's columns without touching the cloud.
# Replace with a table your sync created, e.g. 'main.sales.customers'.
TABLE = 'main.sales.customers'  # <-- adjust after syncing

try:
    spark.sql(f'DESCRIBE TABLE {TABLE}').show()
except Exception as error:
    print(f'{TABLE} not found — run the UC sync first, or edit TABLE above.')
    print('error:', error)

# COMMAND ----------
# Cell 3: prototype the real query against local data.
# Everything below is plain Spark SQL, identical to what will run in prod.
query = """
SELECT
  c.customer_segment,
  count(*) AS orders,
  sum(o.amount) AS revenue
FROM main.sales.orders o
JOIN main.sales.customers c ON o.customer_key = c.customer_key
GROUP BY c.customer_segment
ORDER BY revenue DESC
"""

try:
    spark.sql(query).show()
except Exception as error:
    print('Run the UC sync for main.sales first (schema or data mode), then re-run this cell.')
    print('error:', error)
