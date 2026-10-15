# Databricks notebook source
# Welcome to the local Iceberg example for Spark Cell Runner.
#
# Switch the extension to local mode (Configuration panel -> "Local (Sail)")
# with a pool selected — or run headless with:
#   spark-cell-runner run examples/06_local_iceberg.py --pool <pool>
#
# Requires pysail 0.4+ (Sail's native Apache Iceberg support). The pool's
# warehouse directory is the table root; the explorer tree and the warehouse
# registry both recognize Iceberg tables (metadata/ with *.metadata.json).

# COMMAND ----------

# Write an Iceberg table by path into the pool warehouse.
warehouse = spark.conf.get('spark.sql.warehouse.dir').replace('\\', '/')
print('warehouse:', warehouse)

events_path = f'{warehouse}/demo.db/events_iceberg'

events = spark.createDataFrame(
    [
        (1, 'login', '2026-01-01'),
        (2, 'search', '2026-01-02'),
        (3, 'checkout', '2026-01-03'),
    ],
    'user_id INT, action STRING, event_date STRING',
)

events.write.format('iceberg').mode('overwrite').save(events_path)
print('wrote Iceberg table to', events_path)

# COMMAND ----------

# Read it back by path — native Iceberg read, no conversion.
spark.read.format('iceberg').load(events_path).show()

# COMMAND ----------

# Iceberg tables also work through plain SQL. Use a file:/// URL for the
# LOCATION: SQL string literals treat backslashes as escapes, so raw Windows
# paths break. (Sail's metastore is session-scoped; the warehouse registry
# re-registers on-disk tables — including Iceberg — under schema.table names.)
metrics_url = f'file:///{warehouse}/demo.db/metrics_iceberg'

spark.sql('CREATE SCHEMA IF NOT EXISTS demo')
spark.sql(f"""
CREATE TABLE IF NOT EXISTS demo.metrics_iceberg (metric STRING, value DOUBLE)
USING iceberg
LOCATION '{metrics_url}'
""")

spark.sql("INSERT INTO demo.metrics_iceberg VALUES ('latency_ms', 42.0)")
spark.sql('SELECT * FROM demo.metrics_iceberg').show()

# COMMAND ----------

# Time travel works on Iceberg snapshots (Sail 0.4+):
# spark.read.format('iceberg').option('snapshotId', '<id>').load(events_path)
print('done — check the explorer tree: the tables show format "iceberg"')
