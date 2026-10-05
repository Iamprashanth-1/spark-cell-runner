# Databricks notebook source

# MAGIC %md # Spark Cell Runner — test notebook
# MAGIC 
# MAGIC Open this file (F5 from the repo root launches the Extension Development Host
# MAGIC with the `test/` folder). Run cells with the notebook runner buttons, the
# MAGIC CodeLenses in the text editor view, or the sidebar actions.
# MAGIC 
# MAGIC The widget definitions below should also show up in the sidebar's Widgets card.
# MAGIC 
# MAGIC dbutils.widgets.text("env", "dev", "Environment")
# MAGIC dbutils.widgets.dropdown("region", "eu", ["eu", "us", "ap"], "Region")
# MAGIC 
# MAGIC print(f"hello from {dbutils.widgets.get('env')}-{dbutils.widgets.get('region')}")

# COMMAND ----------

x = 21 * 2

# COMMAND ----------

print(f"x = {x}")

# COMMAND ----------

# MAGIC %sql
# MAGIC SELECT 1 AS one, "two" AS two

# COMMAND ----------

from pysail.spark import SparkConnectServer
from pyspark.sql import SparkSession

server = SparkConnectServer()
server.start()
_, port = server.listening_address

spark = SparkSession.builder.remote(f"sc://localhost:{port}").getOrCreate()

# Run a simple query
spark.sql("SELECT 1 + 1").show()

# COMMAND ----------

spark.sql("SELECT 1 + 2").show()
