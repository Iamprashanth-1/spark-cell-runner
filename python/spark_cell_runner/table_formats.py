#!/usr/bin/env python3
"""Open table format helpers for the local warehouse.

The local Sail pool writes path-based lakehouse tables into the pool's
warehouse directory. Two formats are supported, both natively in Sail 0.4+:

  delta    a ``_delta_log`` folder marks the table root
  iceberg  a ``metadata`` folder with ``*.metadata.json`` files marks the
           table root (the v1/v2 on-disk layout)

Detection drives three things: re-registering on-disk tables into a fresh
session's metastore (the metastore is session-scoped, the files are durable),
format-aware table previews, and the explorer tree's disk scan.
"""

import os
import re

FORMAT_DELTA = 'delta'
FORMAT_ICEBERG = 'iceberg'

_UUID_SUFFIX = re.compile(r'-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', re.I)


def q(identifier):
    """Quote one SQL identifier part."""
    return '`' + identifier.replace('`', '``') + '`'


def full_name(catalog, schema, table):
    return f'{q(catalog)}.{q(schema)}.{q(table)}'


def detect_table_format(dir_path):
    """Returns 'delta', 'iceberg', or None for a candidate table directory."""
    if os.path.isdir(os.path.join(dir_path, '_delta_log')):
        return FORMAT_DELTA

    metadata_dir = os.path.join(dir_path, 'metadata')
    if os.path.isdir(metadata_dir):
        try:
            for name in os.listdir(metadata_dir):
                if name.endswith('.metadata.json'):
                    return FORMAT_ICEBERG
        except OSError:
            pass

    return None


def to_file_url(path):
    """Absolute filesystem path -> file:/// URL (Iceberg locations are URLs).

    Windows drives become file:///C:/...; POSIX paths file:///tmp/...
    """
    path = path.replace('\\', '/')
    if path.startswith('file:'):
        return path
    if not path.startswith('/'):
        path = '/' + path
    return 'file://' + path


def table_location(location, fmt):
    """The LOCATION literal to use when registering a table of this format."""
    if fmt == FORMAT_ICEBERG:
        return to_file_url(location)
    return location


def iter_warehouse_tables(warehouse_dir):
    """Yields (rel_path, location, schema, raw_name, format) for each table.

    Walks the warehouse and classifies every table directory by format. The
    schema grouping mirrors Databricks conventions:

      warehouse/demo.db/orders          -> demo.orders        (delta or iceberg)
      warehouse/spark-warehouse/x-uuid  -> spark-warehouse.x
      warehouse/orders-uuid             -> default.orders     (unmanaged)
    """
    for root, dirs, _files in os.walk(warehouse_dir):
        fmt = detect_table_format(root)

        if fmt and os.path.abspath(root) != os.path.abspath(warehouse_dir):
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

            # Don't descend into the table's own data/log files.
            if fmt == FORMAT_DELTA:
                dirs.remove('_delta_log')
            else:
                dirs.remove('metadata')

            yield rel, location, schema, raw_name, fmt
        else:
            dirs[:] = [d for d in dirs if not d.startswith('.')]


def table_display_name(raw_name):
    """'orders-f731c9ab-...' -> 'orders'; other junk -> SQL-safe name."""
    name = _UUID_SUFFIX.sub('', raw_name)
    return re.sub(r'[^A-Za-z0-9_]', '_', name)


def register_warehouse_tables(spark, warehouse_dir):
    """Registers all on-disk Delta and Iceberg tables into the session.

    Returns (registered, skipped) lists of table names / skip reasons.
    Name collisions are skipped (first walk-order wins).
    """
    registered = []
    skipped = []
    seen = set()

    for rel, location, schema, raw_name, fmt in iter_warehouse_tables(warehouse_dir):
        name = table_display_name(raw_name)

        if name in seen:
            skipped.append(f'{schema}.{name} (duplicate table name from {rel})')
            continue
        seen.add(name)

        try:
            spark.sql(f'CREATE SCHEMA IF NOT EXISTS {q(schema)}')
            spark.sql(
                f'CREATE TABLE IF NOT EXISTS {q(schema)}.{q(name)} '
                f"USING {fmt.upper()} LOCATION '{table_location(location, fmt)}'"
            )
            registered.append(f'{schema}.{name}')
        except Exception as error:
            skipped.append(f'{schema}.{name}: {str(error).split(chr(10))[0][:160]}')

    return registered, skipped
