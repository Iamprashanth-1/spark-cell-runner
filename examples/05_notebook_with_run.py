# Databricks notebook source
# Example 05 — %run includes and shared code
# Demonstrates the %run magic: 05_notebook_with_run.py includes
# 05_shared_utils.py, and its functions become available in this notebook.

# COMMAND ----------
# Cell 1: pull in the shared notebook. The extension resolves and inlines it
# (the include cache lives across runs).
# MAGIC %run ./05_shared_utils

# COMMAND ----------
# Cell 2: use the included helpers.
print('greeting from shared notebook:', DEFAULT_GREETING)
greet('Spark Cell Runner')

# COMMAND ----------
# Cell 3: shared transformations.
from pyspark.sql import functions as F

df = spark.range(1, 11).select('id')
tagged = with_run_tag(df, 'example-05')
tagged.show()
