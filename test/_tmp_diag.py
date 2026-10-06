from pyspark.sql import SparkSession
spark = SparkSession.builder.remote('sc://127.0.0.1:64716').getOrCreate()
for q in ['SHOW CATALOGS', 'SHOW SCHEMAS', 'SHOW SCHEMAS IN main', 'SHOW TABLES IN main.demo', 'SHOW TABLES IN demo']:
    try:
        print('==', q)
        spark.sql(q).show()
    except Exception as e:
        print('==', q, 'ERROR:', str(e).split(chr(10))[0][:120])
spark.stop()
