#!/usr/bin/env python3
"""Unity Catalog -> local pool sync driver.

Spawned by the extension as a one-shot process (deliberately NOT the
persistent notebook session driver, so sync runs never pollute notebook
state). Reads Unity Catalog metadata over REST via the Databricks SDK and
recreates matching schemas/tables on the local Sail pool over Spark Connect.

Two modes:
  schema  Recreate empty Delta tables with identical columns/types (default,
          fast, no data movement, no cluster needed).
  data    Additionally copy table contents: Databricks session reads the
          remote table, the local pool writes it as Delta. Requires
          databricks-connect (or full pyspark + credentials) in this env.

Progress is streamed to stdout as JSON lines:
  {"type": "progress", "message": "...", "done": n, "total": m}
  {"type": "done", "ok": true, "synced": n, "failed": n, "summary": "..."}
  {"type": "error", "message": "..."}
"""

import argparse
import fnmatch
import json
import os
import sys
import time


def emit(payload):
    print(json.dumps(payload), flush=True)


def q(identifier):
    """Quote one SQL identifier part."""
    return '`' + identifier.replace('`', '``') + '`'


def full_name(catalog, schema, table):
    return f'{q(catalog)}.{q(schema)}.{q(table)}'


SYNCABLE_TABLE_TYPES = {'MANAGED', 'EXTERNAL', 'MANAGED_SHALLOW_CLONE', 'EXTERNAL_SHALLOW_CLONE'}


def discover_targets(w, args):
    """Return a list of (catalog, schema, table_name) to sync."""
    if args.catalog:
        catalogs = [args.catalog]
    else:
        catalogs = sorted(c.name for c in w.catalogs.list() if c.name)

    targets = []
    for catalog in catalogs:
        if args.schema:
            schemas = [args.schema]
        else:
            try:
                schemas = sorted(s.name for s in w.schemas.list(catalog_name=catalog) if s.name)
            except Exception as error:
                emit({"type": "progress", "message": f"skipping catalog {catalog}: {error}"})
                continue

        for schema in schemas:
            try:
                for table in w.tables.list(catalog_name=catalog, schema_name=schema):
                    if not table.name:
                        continue
                    if getattr(table, 'table_type', None) not in SYNCABLE_TABLE_TYPES:
                        continue  # views and streaming tables are skipped
                    if args.tables and not fnmatch.fnmatch(table.name, args.tables):
                        continue
                    targets.append((catalog, schema, table.name))
            except Exception as error:
                emit({"type": "progress", "message": f"skipping {catalog}.{schema}: {error}"})

    return targets


def unique_schemas(targets):
    seen = set()
    result = []
    for catalog, schema, _ in targets:
        key = (catalog, schema)
        if key not in seen:
            seen.add(key)
            result.append(key)
    return result


def sync_schema_only(local, w, catalog, schema, table, table_info):
    columns = getattr(table_info, 'columns', None) or []
    if not columns:
        return 'no columns returned; skipped'

    defs = ', '.join(f'{q(col.name)} {col.type_text}' for col in columns if col.name)
    comment = getattr(table_info, 'comment', None)
    suffix = f" COMMENT '{comment}'" if comment else ''
    local.sql(f'CREATE TABLE IF NOT EXISTS {full_name(catalog, schema, table)} ({defs}) USING DELTA{suffix}')
    return None


def connect_databricks(args):
    from databricks.connect import DatabricksSession

    if args.databricks_mode == 'serverless':
        return DatabricksSession.builder.serverless(True).getOrCreate()
    if args.databricks_mode == 'cluster' and args.cluster_id:
        return DatabricksSession.builder.clusterId(args.cluster_id).getOrCreate()
    raise SystemExit(
        json.dumps({"type": "error", "message": "data sync needs a Databricks cluster ID or serverless mode"})
    )


def sync_data(local, remote, catalog, schema, table, limit):
    df = remote.table(f'{catalog}.{schema}.{table}')
    if limit > 0:
        df = df.limit(limit)
    pdf = df.toPandas()
    if pdf.empty:
        return 'remote table is empty; created schema only'
    local.createDataFrame(pdf).write.mode('overwrite').format('delta').saveAsTable(
        full_name(catalog, schema, table)
    )
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pool', required=True, help='Spark Connect URL of the local pool, sc://127.0.0.1:PORT')
    parser.add_argument('--mode', choices=['schema', 'data'], default='schema')
    parser.add_argument('--profile', default='')
    parser.add_argument('--catalog', default='')
    parser.add_argument('--schema', default='')
    parser.add_argument('--tables', default='', help='glob pattern for table names, e.g. dim_*')
    parser.add_argument('--limit', type=int, default=0, help='data mode: max rows per table, 0 = all')
    parser.add_argument('--databricks-mode', choices=['serverless', 'cluster'], default='serverless')
    parser.add_argument('--cluster-id', default='')
    args = parser.parse_args()

    if args.profile:
        os.environ['DATABRICKS_CONFIG_PROFILE'] = args.profile

    started = time.time()

    try:
        from databricks.sdk import WorkspaceClient
    except Exception as error:
        emit({"type": "error", "message": f"The Databricks SDK is unavailable in this environment: {error}"})
        return 1

    try:
        w = WorkspaceClient() if not args.profile else WorkspaceClient(profile=args.profile)
    except Exception as error:
        emit({
            "type": "error",
            "message": f"Could not authenticate to Databricks ({args.profile or 'default profile'}): {error}",
        })
        return 1

    emit({"type": "progress", "message": "Listing catalogs, schemas, and tables from Unity Catalog..."})
    try:
        targets = discover_targets(w, args)
    except Exception as error:
        emit({"type": "error", "message": f"Metadata listing failed: {error}"})
        return 1

    if not targets:
        emit({"type": "error", "message": "No matching tables found in Unity Catalog for the given filters."})
        return 1

    emit({"type": "progress", "message": f"Found {len(targets)} tables. Connecting to local pool {args.pool}..."})

    try:
        from pyspark.sql import SparkSession
        local = SparkSession.builder.remote(args.pool).getOrCreate()
    except Exception as error:
        emit({"type": "error", "message": f"Could not connect to the local pool: {error}"})
        return 1

    for catalog, schema in unique_schemas(targets):
        try:
            local.sql(f'CREATE SCHEMA IF NOT EXISTS {q(catalog)}.{q(schema)}')
        except Exception as error:
            emit({"type": "error", "message": f"Could not create schema {catalog}.{schema}: {error}"})
            return 1

    remote = None
    if args.mode == 'data':
        try:
            remote = connect_databricks(args)
        except SystemExit as error:
            emit(json.loads(str(error)))
            return 1
        except Exception as error:
            emit({"type": "error", "message": f"Databricks Connect is unavailable for data sync: {error}"})
            return 1

    synced = 0
    failed = 0
    total = len(targets)

    for index, (catalog, schema, table) in enumerate(targets):
        label = f'{catalog}.{schema}.{table}'
        emit({"type": "progress", "message": f"[{index + 1}/{total}] {label}", "done": index, "total": total})
        try:
            if args.mode == 'schema':
                info = w.tables.get(full_name(catalog, schema, table))
                skip_reason = sync_schema_only(local, w, catalog, schema, table, info)
            else:
                skip_reason = sync_data(local, remote, catalog, schema, table, args.limit)

            if skip_reason:
                emit({"type": "progress", "message": f"  {label}: {skip_reason}"})
            else:
                synced += 1
        except Exception as error:
            failed += 1
            emit({"type": "progress", "message": f"  FAILED {label}: {error}"})

    seconds = int(time.time() - started)
    emit({
        "type": "done",
        "ok": True,
        "synced": synced,
        "failed": failed,
        "summary": f"{synced}/{total} tables synced ({args.mode} mode) in {seconds}s"
                   + (f", {failed} failed" if failed else ''),
    })
    return 0


if __name__ == '__main__':
    sys.exit(main())
