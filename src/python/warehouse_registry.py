#!/usr/bin/env python3
"""Registers on-disk Delta tables into the current session's metastore.

Sail's metastore is session-scoped: CREATE SCHEMA / saveAsTable names vanish
when the pool restarts, but the Delta files are durable. This helper walks the
warehouse directory and re-registers every Delta table under a predictable
name so schema.table queries work in the session:

  warehouse/demo.db/orders        -> demo.orders
  warehouse/spark-warehouse/x-uuid-> spark-warehouse.x
  warehouse/orders-uuid           -> default.orders   (unmanaged, session-created)

Naming: the table folder name with a trailing UUID stripped and non-word
characters replaced by underscores. Name collisions are skipped (first wins).
"""

import os
import re

_UUID_SUFFIX = re.compile(r'-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', re.I)


def q(identifier):
    return '`' + identifier.replace('`', '``') + '`'


def iter_delta_tables(warehouse_dir):
    """Yields (relative_path, absolute_path, schema, raw_name) for each table."""
    for root, dirs, _files in os.walk(warehouse_dir):
        if '_delta_log' in dirs and os.path.abspath(root) != os.path.abspath(warehouse_dir):
            rel = os.path.relpath(root, warehouse_dir).replace('\\', '/')
            location = root.replace('\\', '/')
            parts = rel.split('/')

            if len(parts) == 1:
                schema, raw_name = 'default', parts[0]
            elif len(parts) == 2 and parts[0].lower().endswith('.db'):
                schema, raw_name = parts[0][:-3], parts[1]
            elif len(parts) == 2 and parts[0] == 'spark-warehouse':
                schema, raw_name = 'spark-warehouse', parts[1]
            else:
                schema, raw_name = parts[0], parts[-1]

            # Don't descend into the table's data/log files.
            dirs.remove('_delta_log')
            yield rel, location, schema, raw_name
        else:
            dirs[:] = [d for d in dirs if not d.startswith('.') and d != '_delta_log']


def register_warehouse_tables(spark, warehouse_dir):
    """Registers all warehouse tables; returns (registered, skipped) lists."""
    registered = []
    skipped = []
    seen = set()

    for rel, location, schema, raw_name in iter_delta_tables(warehouse_dir):
        name = _UUID_SUFFIX.sub('', raw_name)
        name = re.sub(r'[^A-Za-z0-9_]', '_', name)

        if name in seen:
            skipped.append(f'{schema}.{name} (duplicate table name from {rel})')
            continue
        seen.add(name)

        try:
            spark.sql(f'CREATE SCHEMA IF NOT EXISTS {q(schema)}')
            spark.sql(
                f'CREATE TABLE IF NOT EXISTS {q(schema)}.{q(name)} '
                f"USING DELTA LOCATION '{location}'"
            )
            registered.append(f'{schema}.{name}')
        except Exception as error:
            skipped.append(f'{schema}.{name}: {str(error).split(chr(10))[0][:160]}')

    return registered, skipped
