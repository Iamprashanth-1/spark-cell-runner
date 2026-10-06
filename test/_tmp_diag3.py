from pyspark.sql import SparkSession
spark = SparkSession.builder.remote('sc://127.0.0.1:64716').getOrCreate()
for q in ['SHOW SCHEMAS IN sail', 'SHOW TABLES IN sail.demo', 'DESCRIBE TABLE sail.demo.items']:
    print('==', q)
    spark.sql(q).show()
spark.stop()
