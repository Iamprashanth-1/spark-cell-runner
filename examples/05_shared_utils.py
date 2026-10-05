# Databricks notebook source
# Shared helpers included by 05_notebook_with_run.py via %run.

# COMMAND ----------
DEFAULT_GREETING = 'hello from 05_shared_utils'

def greet(name):
    print(f'{DEFAULT_GREETING}, {name}!')

# COMMAND ----------
def with_run_tag(df, tag):
    """Adds a static column tagging rows with the given run label."""
    from pyspark.sql import functions as F
    return df.withColumn('run_tag', F.lit(tag))
