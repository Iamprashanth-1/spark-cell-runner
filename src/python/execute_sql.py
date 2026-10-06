#!/usr/bin/env python3
"""Execute SQL against the local Sail pool.

Reads the SQL text from STDIN, splits it into statements (semicolons outside
quotes/comments), executes them in order, and reports per-statement results as
JSON lines on stdout:

  {"type": "statement", "index": 0, "sql": "...", "ok": true,
   "csv": "col1,col2\\n...", "totalRows": 25, "shown": 25}
  {"type": "statement", "index": 1, "sql": "...", "ok": true}          (DDL/DML)
  {"type": "statement-error", "index": 2, "sql": "...", "message": "..."}
  {"type": "done", "ok": true, "executed": 3, "failed": 0}

Execution stops at the first failing statement (like an interactive console).
"""

import argparse
import csv
import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from warehouse_registry import register_warehouse_tables


def emit(payload):
    print(json.dumps(payload), flush=True)


def fail(message):
    emit({"type": "error", "message": message})
    return 1


def split_statements(sql_text):
    """Split on semicolons outside single quotes, double quotes, and comments."""
    statements = []
    current = []
    in_single = in_double = in_line_comment = in_block_comment = False

    lines = sql_text.split('\n')
    for line in lines:
        scanned = []
        index = 0
        while index < len(line):
            char = line[index]
            nxt = line[index + 1] if index + 1 < len(line) else ''

            if in_line_comment:
                scanned.append(char)
                index += 1
                continue
            if in_block_comment:
                scanned.append(char)
                if char == '*' and nxt == '/':
                    scanned.append(nxt)
                    index += 2
                    in_block_comment = False
                    continue
                index += 1
                continue

            if not in_single and not in_double and char == '-' and nxt == '-':
                in_line_comment = True
                scanned.append(char)
                index += 1
                continue
            if not in_single and not in_double and char == '/' and nxt == '*':
                in_block_comment = True
                scanned.append(char)
                index += 1
                continue
            if char == "'" and not in_double:
                in_single = not in_single
                scanned.append(char)
                index += 1
                continue
            if char == '"' and not in_single:
                in_double = not in_double
                scanned.append(char)
                index += 1
                continue
            if char == ';' and not in_single and not in_double:
                current.append(''.join(scanned))
                statements.append('\n'.join(current))
                current = []
                scanned = []
                index += 1
                continue

            scanned.append(char)
            index += 1

        # A line comment ends with the line.
        in_line_comment = False
        current.append(''.join(scanned))

    if current:
        statements.append('\n'.join(current))

    # Keep only statements with actual content (a trailing semicolon leaves an
    # empty or comment-only remainder).
    result = []
    for statement in statements:
        stripped = []
        for line in statement.split('\n'):
            code = line.split('--')[0] if '--' in line and not line.strip().startswith('--') else line
            if line.strip().startswith('--'):
                continue
            stripped.append(code)
        if any(part.strip().strip('/*').strip('*/').strip() for part in stripped):
            result.append(statement.strip())
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pool', required=True, help='sc://host:port of the local pool')
    parser.add_argument('--limit', type=int, default=200, help='max rows captured per statement')
    parser.add_argument('--warehouse', default='', help='warehouse dir of the active pool to register tables from')
    args = parser.parse_args()

    sql_text = sys.stdin.read()

    if not sql_text.strip():
        return fail('No SQL to execute.')

    try:
        from pyspark.sql import SparkSession
    except Exception as error:
        return fail(f'pyspark is unavailable in this environment: {error}')

    try:
        spark = SparkSession.builder.remote(args.pool).getOrCreate()
    except Exception as error:
        return fail(f'Could not connect to the local pool: {error}')

    # Re-register on-disk warehouse tables so schema.table names resolve.
    if args.warehouse:
        try:
            registered, _skipped = register_warehouse_tables(spark, args.warehouse)
            if registered:
                emit({"type": "progress", "message": f"registered {len(registered)} warehouse table(s) into the session"})
        except Exception:
            pass

    statements = split_statements(sql_text)
    executed = 0
    failed = 0

    for index, statement in enumerate(statements):
        preview = ' '.join(statement.split())[:160]
        try:
            # Spark Connect defers analysis until an action, so errors in the
            # statement surface here — anything thrown is a real failure.
            df = spark.sql(statement)
            rows = df.limit(args.limit).toPandas() if df.columns else None

            if rows is None:
                emit({"type": "statement", "index": index, "sql": preview, "ok": True})
            elif len(rows) > 0:
                buffer = io.StringIO()
                rows.to_csv(buffer, index=False, lineterminator='\n')
                emit({
                    "type": "statement",
                    "index": index,
                    "sql": preview,
                    "ok": True,
                    "csv": buffer.getvalue(),
                    "shown": len(rows),
                    "capped": len(rows) == args.limit,
                })
            else:
                emit({"type": "statement", "index": index, "sql": preview, "ok": True, "shown": 0})

            executed += 1
        except Exception as error:
            failed += 1
            emit({
                "type": "statement-error",
                "index": index,
                "sql": preview,
                "message": str(error).split('\n')[0][:400],
            })
            break

    emit({"type": "done", "ok": failed == 0, "executed": executed, "failed": failed})
    return 0 if failed == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
