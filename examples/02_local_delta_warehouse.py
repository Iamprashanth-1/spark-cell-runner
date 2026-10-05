# Databricks notebook source
# Example 02 — Local Delta warehouse basics
# Best run with connectionMode = local: tables land in the pool's own
# warehouse folder (~/.spark-cell-runner/warehouse/<pool>) as Delta tables.

# COMMAND ----------
# Cell 1: create a schema. Locally this maps to a folder in the warehouse;
# on Databricks it is a real UC schema.
spark.sql('CREATE SCHEMA IF NOT EXISTS demo')

# COMMAND ----------
# Cell 2: write a Delta table with saveAsTable.
from pyspark.sql import functions as F

(
    spark.range(1, 501)
    .select(
        F.col('id'),
        (F.col('id') % 10).alias('customer_key'),
        (F.round(F.col('id') * 1.5, 2)).alias('amount'),
    )
    .write
    .mode('overwrite')
    .format('delta')
    .saveAsTable('demo.orders')
)
print('demo.orders written')

# COMMAND ----------
# Cell 3: read it back — the table survives across sessions because it is
# stored in the pool's warehouse directory.
print(spark.table('demo.orders').count(), 'rows in demo.orders')
spark.sql('SELECT customer_key, count(*) AS orders, sum(amount) AS total FROM demo.orders GROUP BY customer_key ORDER BY customer_key').show(10)

# COMMAND ----------
# Cell 4: Delta appends and updates.
from pyspark.sql import Row

new_rows = spark.createDataFrame([Row(id=9999, customer_key=7, amount=123.45)])
new_rows.write.mode('append').format('delta').saveAsTable('demo.orders')
print('after append:', spark.table('demo.orders').count(), 'rows')

# COMMAND ----------
# Cell 5: inspect table metadata.
spark.sql('DESCRIBE TABLE demo.orders').show()

# COMMAND ----------
# Cell 6: list what exists in this warehouse.
print('Databases:', [db.name for db in spark.catalog.listDatabases()])
print('Tables in demo:', [t.name for t in spark.catalog.listTables('demo')])
