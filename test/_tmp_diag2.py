from pyspark.sql import SparkSession
spark = SparkSession.builder.remote('sc://127.0.0.1:64716').getOrCreate()
spark.sql('CREATE SCHEMA IF NOT EXISTS sail.demo')
spark.range(5).write.mode('overwrite').format('delta').saveAsTable('sail.demo.items')
print('created sail.demo.items')
spark.stop()
