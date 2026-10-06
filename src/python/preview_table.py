#!/usr/bin/env python3
"""Preview rows of a Delta table on disk through the local Sail pool.

Path-based (`spark.read.format('delta').load(...)`) on purpose: Sail's
metastore is session-scoped, so registered table names vanish between
sessions — the files are the durable truth.

Prints CSV (header + rows) to stdout:
  {"type": "error", "message": "..."} on failure.
"""

import argparse
import csv
import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def fail(message):
    print(json.dumps({"type": "error", "message": message}), flush=True)
    return 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pool', required=True, help='sc://host:port of the local pool')
    parser.add_argument('--path', required=True, help='Local path of the Delta table directory')
    parser.add_argument('--limit', type=int, default=20)
    args = parser.parse_args()

    try:
        from pyspark.sql import SparkSession
    except Exception as error:
        return fail(f'pyspark is unavailable in this environment: {error}')

    try:
        spark = SparkSession.builder.remote(args.pool).getOrCreate()
    except Exception as error:
        return fail(f'Could not connect to the local pool: {error}')

    try:
        df = spark.read.format('delta').load(args.path)

        total = df.count()
        rows = df.limit(args.limit).toPandas()

        buffer = io.StringIO()
        rows.to_csv(buffer, index=False, lineterminator='\n')

        emit_payload = {
            "csv": buffer.getvalue(),
            "totalRows": total,
            "columns": list(rows.columns),
            "shown": len(rows),
        }
        print(json.dumps(emit_payload), flush=True)
        return 0
    except Exception as error:
        return fail(str(error))


if __name__ == '__main__':
    sys.exit(main())
