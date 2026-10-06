#!/usr/bin/env python3
"""Unity Catalog / local warehouse listing driver for the explorer tree.

One-shot process (like uc_sync.py): connects to either the local Sail pool
over Spark Connect or to Databricks over REST, and lists one level of the
catalog hierarchy. Streams a single JSON object on stdout:

  {"items": [{"name": "...", "kind": "catalog|schema|table|column",
              "detail": "..."}]}
  {"type": "error", "message": "..."}

Levels:
  catalogs        -> list catalogs
  schemas         -> list schemas in --catalog
  tables          -> list tables in --catalog.--schema
  table-details   -> columns of --catalog.--schema.--table
"""

import argparse
import json
import sys


def emit(payload):
    print(json.dumps(payload), flush=True)


def q(identifier):
    return '`' + identifier.replace('`', '``') + '`'


def fail(message):
    emit({"type": "error", "message": message})
    return 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', choices=['local', 'databricks'], required=True)
    parser.add_argument('--level', choices=['catalogs', 'schemas', 'tables', 'table-details'], required=True)
    parser.add_argument('--catalog', default='')
    parser.add_argument('--schema', default='')
    parser.add_argument('--table', default='')
    parser.add_argument('--pool', default='', help='sc://host:port for local source')
    parser.add_argument('--profile', default='')
    args = parser.parse_args()

    if args.source == 'local':
        if not args.pool:
            return fail('No pool URL provided for local exploration.')
        try:
            from pyspark.sql import SparkSession
            spark = SparkSession.builder.remote(args.pool).getOrCreate()
        except Exception as error:
            return fail(f'Could not connect to the local pool: {error}')

        try:
            if args.level == 'catalogs':
                items = [{"name": db.name, "kind": "catalog"} for db in spark.catalog.listDatabases()]
            elif args.level == 'schemas':
                # Spark namespaces catalogs as folders under the warehouse root;
                # local mode has a flat database list per pool.
                items = [{"name": db.name, "kind": "schema"} for db in spark.catalog.listDatabases()]
            elif args.level == 'tables':
                full = f'{q(args.catalog)}.{q(args.schema)}' if args.catalog else q(args.schema)
                items = [{"name": t.name, "kind": "table", "detail": t.tableType or ''}
                         for t in spark.catalog.listTables(full)]
            else:  # table-details
                full = f'{q(args.catalog)}.{q(args.schema)}.{q(args.table)}' if args.catalog \
                    else f'{q(args.schema)}.{q(args.table)}'
                items = [{"name": col.name, "kind": "column", "detail": col.type}
                         for col in spark.catalog.listColumns(full)]
            emit({"items": items})
            return 0
        except Exception as error:
            return fail(str(error))

    # ---- databricks source (REST metadata, no compute required) ----
    try:
        from databricks.sdk import WorkspaceClient
    except Exception as error:
        return fail(f'The Databricks SDK is unavailable in this environment: {error}')

    try:
        w = WorkspaceClient() if not args.profile else WorkspaceClient(profile=args.profile)
    except Exception as error:
        return fail(f'Could not authenticate to Databricks ({args.profile or "default profile"}): {error}')

    try:
        if args.level == 'catalogs':
            items = [{"name": c.name, "kind": "catalog", "detail": c.comment or ''}
                     for c in w.catalogs.list()]
        elif args.level == 'schemas':
            items = [{"name": s.name, "kind": "schema", "detail": s.comment or ''}
                     for s in w.schemas.list(catalog_name=args.catalog)]
        elif args.level == 'tables':
            items = [{"name": t.name, "kind": "table",
                      "detail": (t.table_type.value if t.table_type else '')}
                     for t in w.tables.list(catalog_name=args.catalog, schema_name=args.schema)]
        else:  # table-details
            info = w.tables.get(f'{args.catalog}.{args.schema}.{args.table}')
            items = [{"name": col.name, "kind": "column", "detail": col.type_text}
                     for col in (info.columns or [])]
        emit({"items": items})
        return 0
    except Exception as error:
        return fail(str(error))


if __name__ == '__main__':
    sys.exit(main())
