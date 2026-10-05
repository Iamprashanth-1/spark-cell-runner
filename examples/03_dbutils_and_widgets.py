# Databricks notebook source
# Example 03 — dbutils, widgets, display
# The extension shims dbutils locally, so this runs the same way it does on
# Databricks. Widget values are editable in the sidebar before running.

# COMMAND ----------
# Cell 1: widgets. The sidebar's "Notebook widgets" section shows these with
# editable values (from sparkCellRunner.widgetValues).
dbutils.widgets.text('environment', 'dev', 'Environment')
dbutils.widgets.dropdown('limit', '10', ['5', '10', '20'], 'Row limit')

environment = dbutils.widgets.get('environment')
row_limit = int(dbutils.widgets.get('limit'))
print('environment =', environment)
print('row_limit =', row_limit)

# COMMAND ----------
# Cell 2: display() — on Databricks this renders the rich table view; here it
# prints rows as text.
from pyspark.sql import functions as F

display(
    spark.range(1, row_limit + 1)
    .select('id', (F.col('id') * 10).alias('value'))
)

# COMMAND ----------
# Cell 3: dbutils.fs — lists the pool's warehouse (locally) or DBFS (remote).
for entry in dbutils.fs.ls('/'):
    print(entry.name, '(dir)' if entry.isDir() else f'{entry.size} bytes')

# COMMAND ----------
# Cell 4: secrets — locally the shim resolves values from
# sparkCellRunner.secretValues (keyed "scope/key") or environment variables.
scope = 'demo'
key = 'api_token'
value = dbutils.secrets.get(scope, key)
print(f'secret {scope}/{key} resolved:', '(set)' if value else '(empty — configure it in the sidebar settings)')
