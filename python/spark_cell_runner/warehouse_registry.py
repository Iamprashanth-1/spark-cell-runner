#!/usr/bin/env python3
"""Registers on-disk Delta and Iceberg tables into the current session's metastore.

Backward-compatible facade over ``table_formats``, which holds the shared
detection/walk/registration logic for both open table formats:

  warehouse/demo.db/orders        -> demo.orders
  warehouse/spark-warehouse/x-uuid-> spark-warehouse.x
  warehouse/orders-uuid           -> default.orders   (unmanaged, session-created)

Naming: the table folder name with a trailing UUID stripped and non-word
characters replaced by underscores. Name collisions are skipped (first wins).
"""

try:
    from spark_cell_runner.table_formats import (
        FORMAT_DELTA,
        FORMAT_ICEBERG,
        detect_table_format,
        iter_warehouse_tables,
        register_warehouse_tables,
    )
except ImportError:  # vendored flat layout inside the VSIX
    from table_formats import (  # noqa: F401
        FORMAT_DELTA,
        FORMAT_ICEBERG,
        detect_table_format,
        iter_warehouse_tables,
        register_warehouse_tables,
    )
