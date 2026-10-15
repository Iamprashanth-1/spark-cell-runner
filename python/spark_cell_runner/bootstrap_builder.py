#!/usr/bin/env python3
"""Builds the connection preamble for headless notebook execution.

Python analog of the extension's pyResources.buildBootstrapCode: returns
Python source that, when exec'd, binds ``spark``/``sql`` in the caller's
namespace — either a Spark Connect session pointed at a local Sail pool or a
DatabricksSession from databricks-connect.

Local pools additionally get:
  - spark.sql.warehouse.dir pinned to the pool's warehouse directory
  - on-disk Delta / Iceberg tables re-registered into the session metastore
    (Sail's metastore is session-scoped; the files are the durable truth)
"""

import json
import os
import sys

try:
    from spark_cell_runner import pool as pool_manager
    from spark_cell_runner import parser as notebook_parser
except ImportError:  # vendored flat layout inside the VSIX
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import pool as pool_manager
    import parser as notebook_parser


def resolve_pool_target(pool_ref):
    """Accepts a pool name or an sc:// URL; returns (target, pool_or_None).

    With no ref, resolves to the single existing pool if there is exactly one.
    """
    if pool_ref and pool_ref.startswith('sc://'):
        return pool_ref, None
    if pool_ref:
        pool = pool_manager.get_pool(pool_ref)
        if not pool:
            raise ValueError(
                f'No local pool named "{pool_ref}" exists. '
                f'Create one with: spark-cell-runner pool create {pool_ref}'
            )
        return f"sc://127.0.0.1:{pool['port']}", pool

    pools = pool_manager.list_pools()
    if len(pools) == 1:
        pool = pools[0]
        return f"sc://127.0.0.1:{pool['port']}", pool
    if not pools:
        raise ValueError(
            'No local pools exist. Create one with: spark-cell-runner pool create <name>'
        )
    raise ValueError(
        f'{len(pools)} pools exist; pass --pool with one of: '
        + ', '.join(p['name'] for p in pools)
    )


def build_local_bootstrap(target, warehouse_path=None):
    register_lines = []
    if warehouse_path:
        warehouse_json = json.dumps(warehouse_path.replace('\\', '/'))
        register_lines = [
            '    try:',
            '        from spark_cell_runner.table_formats import register_warehouse_tables',
            '        _registered, _skipped = register_warehouse_tables(spark, ' + warehouse_json + ')',
            '        if _registered:',
            "            print('[spark-cell-runner] registered %d warehouse table(s)' % len(_registered))",
            '    except Exception as registration_error:',
            "        print('[spark-cell-runner] warehouse table registration failed: %s' % registration_error)",
        ]

    return '\n'.join([
        'try:',
        '    from pyspark.sql import SparkSession',
        f"    _local_spark_target = '{target}'",
        "    spark = globals().get('spark') or SparkSession.builder.remote(_local_spark_target).getOrCreate()",
        "    sql = globals().get('sql') or spark.sql",
        '    try:',
        f"        spark.conf.set('spark.sql.warehouse.dir', {json.dumps(warehouse_path or '')})",
        '    except Exception:',
        '        pass',
        *register_lines,
        'except Exception as local_pool_error:',
        "    print(f'[spark-cell-runner] Local Spark pool bootstrap unavailable: {local_pool_error}')",
    ])


def build_databricks_bootstrap(serverless=False, cluster_id=None, profile=None):
    lines = [
        'try:',
        '    from databricks.connect import DatabricksSession',
    ]

    if profile:
        lines.insert(1, 'import os')
        lines.insert(2, f"os.environ['DATABRICKS_CONFIG_PROFILE'] = {json.dumps(profile)}")

    if serverless:
        lines.append('    _scr_builder = DatabricksSession.builder.serverless(True)')
    elif cluster_id:
        lines.append(f'    _scr_builder = DatabricksSession.builder.clusterId({json.dumps(cluster_id)})')
    else:
        lines.append('    spark = globals().get("spark") or DatabricksSession.builder.getOrCreate()')
        lines.append('    sql = globals().get("sql") or spark.sql')
        lines.extend([
            'except Exception as databricks_connect_error:',
            "    print(f'[spark-cell-runner] Databricks Connect bootstrap unavailable: {databricks_connect_error}')",
        ])
        return '\n'.join(lines)

    lines.extend([
        "    spark = globals().get('spark') or _scr_builder.getOrCreate()",
        "    sql = globals().get('sql') or spark.sql",
        'except Exception as databricks_connect_error:',
        "    print(f'[spark-cell-runner] Databricks Connect bootstrap unavailable: {databricks_connect_error}')",
    ])
    return '\n'.join(lines)


def build_bootstrap(pool=None, serverless=False, cluster_id=None, profile=None):
    """Returns (bootstrap_source, execution_description).

    Selection rules: an explicit --serverless/--cluster-id goes to Databricks;
    an explicit --pool (name or sc:// URL) goes local; with neither, local is
    used when exactly one pool exists, otherwise Databricks defaults.
    """
    if serverless or cluster_id:
        return build_databricks_bootstrap(serverless, cluster_id, profile), 'databricks'

    if pool:
        target, resolved = resolve_pool_target(pool)
        warehouse = resolved.get('warehousePath') if resolved else None
        description = f'local pool {resolved["name"]}' if resolved else target
        return build_local_bootstrap(target, warehouse), description

    try:
        target, resolved = resolve_pool_target(None)
    except ValueError:
        return build_databricks_bootstrap(False, None, profile), 'databricks'

    warehouse = resolved.get('warehousePath') if resolved else None
    description = f'local pool {resolved["name"]}' if resolved else target
    return build_local_bootstrap(target, warehouse), description


def parse_cell_selection(spec, total):
    """Parses 'all', '3', or '1-3' into a set of 1-based cell indices."""
    if not spec or spec == 'all':
        return set(range(1, total + 1))

    selected = set()
    for part in spec.split(','):
        part = part.strip()
        if not part:
            continue
        if '-' in part:
            start, _, end = part.partition('-')
            try:
                lo, hi = int(start), int(end)
            except ValueError:
                raise ValueError(f'Bad cell range: {part}')
            selected.update(range(lo, hi + 1))
        else:
            try:
                selected.add(int(part))
            except ValueError:
                raise ValueError(f'Bad cell number: {part}')

    invalid = [n for n in selected if n < 1 or n > total]
    if invalid:
        raise ValueError(f'Cell number(s) outside 1..{total}: {sorted(invalid)}')
    return selected


def run_notebook_cells(text, namespace, show=True, cell_selection='all', on_cell=None):
    """Executes parsed notebook cells against a prepared namespace.

    The namespace must already have `spark` bound (via the bootstrap source).
    A plain .py file (no notebook header) is executed whole. Returns the
    number of executed cells; raises on cell failure.
    """
    cells, is_source = notebook_parser.parse_notebook_text(text)

    if not is_source:
        exec(compile(text, '<script>', 'exec'), namespace, namespace)
        return 1

    selected = parse_cell_selection(cell_selection, len(cells))
    executed = 0

    for cell in cells:
        number = cell.index + 1
        if number not in selected:
            continue

        kind, payload = notebook_parser.classify_cell(cell.lines)

        if on_cell:
            on_cell(number, kind, payload)

        if kind in ('skip', 'markdown'):
            continue

        if kind == 'python':
            exec(compile(payload, f'<cell {number}>', 'exec'), namespace, namespace)
        elif kind == 'sql':
            result = namespace['spark'].sql(payload)
            if show:
                result.show()
        elif kind == 'pip':
            print('[spark-cell-runner] %pip cells are skipped headless; '
                  'install into the session environment yourself: pip install '
                  + ' '.join(payload))
        elif kind == 'sh':
            import subprocess
            completed = subprocess.run(payload, shell=True)
            if completed.returncode != 0:
                print(f'[spark-cell-runner] %sh exited with code {completed.returncode}')
        elif kind == 'run':
            print(f'[spark-cell-runner] %run {payload} is not supported headless yet; skipping')

        executed += 1

    return executed
