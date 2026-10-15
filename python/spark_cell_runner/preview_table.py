#!/usr/bin/env python3
"""Preview rows of a Delta or Iceberg table on disk through the local Sail pool.

Path-based (`spark.read.format(...).load(...)`) on purpose: Sail's
metastore is session-scoped, so registered table names vanish between
sessions — the files are the durable truth.

The format is auto-detected from the directory layout (`_delta_log` ->
delta, `metadata/*.metadata.json` -> iceberg) unless --format says
otherwise.

Prints CSV (header + rows) to stdout:
  {"type": "error", "message": "..."} on failure.
"""

import argparse
import csv
import io
import json
import os
import sys

try:
    from spark_cell_runner.table_formats import FORMAT_DELTA, detect_table_format
except ImportError:  # vendored flat layout inside the VSIX
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from table_formats import FORMAT_DELTA, detect_table_format


def fail(message):
    print(json.dumps({"type": "error", "message": message}), flush=True)
    return 1


def resolve_format(args):
    if args.format != 'auto':
        return args.format
    detected = detect_table_format(args.path)
    return detected or FORMAT_DELTA


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pool', required=True, help='sc://host:port of the local pool')
    parser.add_argument('--path', required=True, help='Local path of the table directory')
    parser.add_argument('--format', choices=['auto', 'delta', 'iceberg'], default='auto',
                        help='Table format; auto-detects from the directory by default')
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

    table_format = resolve_format(args)

    try:
        df = spark.read.format(table_format).load(args.path)

        total = df.count()
        rows = df.limit(args.limit).toPandas()

        buffer = io.StringIO()
        rows.to_csv(buffer, index=False, lineterminator='\n')

        emit_payload = {
            "csv": buffer.getvalue(),
            "totalRows": total,
            "columns": list(rows.columns),
            "shown": len(rows),
            "format": table_format,
        }
        print(json.dumps(emit_payload), flush=True)
        return 0
    except Exception as error:
        return fail(str(error))


if __name__ == '__main__':
    sys.exit(main())
