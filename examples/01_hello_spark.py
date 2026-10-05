# Databricks notebook source
# Example 01 — Hello Spark
# Runs identically against a local Sail pool or a Databricks cluster.

# COMMAND ----------
# Cell 1: the `spark` session is created by the extension's bootstrap.
# Verify the engine you are connected to.
print('Spark version:', spark.version)
print('Warehouse dir:', spark.conf.get('spark.sql.warehouse.dir', '(default)'))

# COMMAND ----------
# Cell 2: DataFrames — create a range and derive a column.
from pyspark.sql import functions as F

df = spark.range(1, 101).select('id', (F.col('id') * F.col('id')).alias('squared'))
df.show(5)
print('rows:', df.count())

# COMMAND ----------
# Cell 3: SQL — the `sql` helper is also injected by the bootstrap.
sql("""
SELECT
  count(*) AS total,
  min(squared) AS min_sq,
  max(squared) AS max_sq
FROM (
  SELECT id, id * id AS squared FROM RANGE(1, 101)
)
""").show()

# COMMAND ----------
# Cell 4: simple aggregation with grouping.
(
    spark.range(1, 21)
    .select((F.col('id') % 3).alias('bucket'), F.col('id'))
    .groupBy('bucket')
    .agg(F.count('*').alias('n'), F.sum('id').alias('id_sum'))
    .orderBy('bucket')
    .show()
)
