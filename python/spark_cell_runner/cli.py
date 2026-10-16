#!/usr/bin/env python3
"""spark-cell-runner — headless engine for Databricks notebook cells and SQL.

pip-installable twin of the VS Code extension: runs Databricks notebook-source
.py cells and SQL against Databricks (Databricks Connect) or a local Sail
Spark pool, with Unity Catalog sync and a local Delta / Iceberg warehouse.
Pools, warehouses, and profiles are shared with the extension.

`scr` is a short alias for the same CLI (`scr pool create dev` etc.).

Examples:
  spark-cell-runner pool create dev && spark-cell-runner pool start dev
  spark-cell-runner run notebook.py --pool dev
  spark-cell-runner sql query.sql --pool dev
  spark-cell-runner sync --catalog main --mode schema --format iceberg
  spark-cell-runner explore --source local --level tables --pool dev
  spark-cell-runner preview ~/.spark-cell-runner/warehouse/dev/demo.db/orders
"""

import argparse
import os
import sys

try:
    from spark_cell_runner import __version__, bootstrap_builder, pool as pool_manager
except ImportError:  # vendored flat layout inside the VSIX
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import pool as pool_manager
    import bootstrap_builder

    try:
        from spark_cell_runner import __version__
    except ImportError:
        __version__ = 'dev'


def _fail(message, code=1):
    print(f'spark-cell-runner: {message}', file=sys.stderr)
    return code


def _script_dir():
    return os.path.dirname(os.path.abspath(__file__))


def _script_path(name):
    return os.path.join(_script_dir(), name)


# ---------------------------------------------------------------------------
# pool subcommand


def cmd_pool_list(_args):
    pools = pool_manager.list_pools()
    if not pools:
        print('No local pools. Create one with: spark-cell-runner pool create <name>')
        return 0
    for pool in pools:
        status = 'running' if pool.get('running') else 'stopped'
        print(f'{pool["name"]:<20} {status:<8} sc://127.0.0.1:{pool["port"]}')
        print(f'{"":<20} warehouse: {pool["warehousePath"]}')
    return 0


def cmd_pool_create(args):
    try:
        pool = pool_manager.create_pool(args.name, python_command=args.python, port=args.port)
    except (ValueError, OSError) as error:
        return _fail(str(error))
    print(f'Created pool "{pool["name"]}" (warehouse {pool["warehousePath"]}).')
    print(f'Start it with: spark-cell-runner pool start {pool["name"]}')
    return 0


def cmd_pool_start(args):
    try:
        pool_manager.start_pool(args.name)
    except (ValueError, TimeoutError, OSError) as error:
        return _fail(str(error))
    return 0


def cmd_pool_stop(args):
    if not pool_manager.stop_pool(args.name):
        return _fail(f'No local pool named "{args.name}" exists.')
    print(f'Stopped pool "{args.name}".')
    return 0


def cmd_pool_delete(args):
    if not pool_manager.delete_pool(args.name):
        return _fail(f'No local pool named "{args.name}" exists.')
    print(f'Deleted pool "{args.name}".')
    return 0


def cmd_pool_logs(args):
    pool = pool_manager.get_pool(args.name)
    if not pool:
        return _fail(f'No local pool named "{args.name}" exists.')
    log_file = pool.get('logFile') or os.path.join(pool_manager.logs_root(), f'{args.name}.log')
    if not os.path.exists(log_file):
        print(f'(no log yet at {log_file})')
        return 0
    with open(log_file, encoding='utf-8', errors='replace') as handle:
        tail = handle.readlines()[-args.tail:]
    sys.stdout.writelines(tail)
    return 0


# ---------------------------------------------------------------------------
# run subcommand


def cmd_run(args):
    try:
        with open(args.notebook, encoding='utf-8') as handle:
            text = handle.read()
    except OSError as error:
        return _fail(f'Could not read {args.notebook}: {error}')

    try:
        bootstrap, description = bootstrap_builder.build_bootstrap(
            pool=args.pool,
            serverless=args.serverless,
            cluster_id=args.cluster_id,
            profile=args.profile,
        )
    except ValueError as error:
        return _fail(str(error))

    print(f'[spark-cell-runner] executing {args.notebook} on {description}')

    namespace = {'__name__': '__main__'}
    exec(compile(bootstrap, '<bootstrap>', 'exec'), namespace, namespace)

    if 'spark' not in namespace:
        return _fail('The session never came up (see bootstrap messages above).')

    def on_cell(number, kind, _payload):
        label = {'skip': 'skipping', 'markdown': 'markdown'}.get(kind, kind)
        print(f'\n[spark-cell-runner] --- cell {number} ({label}) ---')

    try:
        executed = bootstrap_builder.run_notebook_cells(
            text, namespace, show=args.show, cell_selection=args.cells, on_cell=on_cell
        )
    except ValueError as error:
        return _fail(str(error))
    except Exception as error:
        import traceback
        traceback.print_exc()
        return _fail(f'cell failed: {error}')

    print(f'\n[spark-cell-runner] done: {executed} cell(s) executed on {description}')
    return 0


# ---------------------------------------------------------------------------
# sql / sync / explore / preview subcommands delegate to the existing drivers,
# run as subprocesses so their JSON/stdin protocols stay unchanged.


def _run_driver(script_name, extra_args, stdin_text=None):
    import subprocess

    result = subprocess.run(
        [sys.executable, '-u', _script_path(script_name), *extra_args],
        input=stdin_text,
        text=True,
    )
    return result.returncode


def cmd_sql(args):
    if args.file == '-':
        sql_text = sys.stdin.read()
    else:
        try:
            with open(args.file, encoding='utf-8') as handle:
                sql_text = handle.read()
        except OSError as error:
            return _fail(f'Could not read {args.file}: {error}')

    if not sql_text.strip():
        return _fail('No SQL to execute.')

    try:
        target, _pool = bootstrap_builder.resolve_pool_target(args.pool)
    except ValueError as error:
        return _fail(str(error))

    driver_args = ['--pool', target, '--warehouse', _warehouse_for(args.pool), '--limit', str(args.limit)]
    return _run_driver('execute_sql.py', driver_args, stdin_text=sql_text)


def _warehouse_for(pool_ref):
    """Warehouse dir of the resolved pool (execute_sql re-registers tables)."""
    if pool_ref and pool_ref.startswith('sc://'):
        root = pool_manager.warehouse_root()
        pools = pool_manager.list_pools()
        serving = [p for p in pools if p.get('running')]
        if len(serving) == 1:
            return serving[0]['warehousePath']
        return root
    try:
        target, resolved = bootstrap_builder.resolve_pool_target(pool_ref)
    except ValueError:
        return pool_manager.warehouse_root()
    return resolved['warehousePath'] if resolved else pool_manager.warehouse_root()


def cmd_sync(args):
    driver_args = [
        '--pool', _require_pool_target(args.pool),
        '--mode', args.mode,
        '--format', args.format,
        '--catalog', args.catalog or '',
        '--schema', args.schema or '',
        '--tables', args.tables or '',
        '--limit', str(args.limit),
    ]
    if args.profile:
        driver_args.extend(['--profile', args.profile])
    if args.mode == 'data':
        driver_args.extend(['--databricks-mode', 'serverless' if args.serverless else 'cluster'])
        if args.cluster_id:
            driver_args.extend(['--cluster-id', args.cluster_id])
    return _run_driver('uc_sync.py', driver_args)


def _require_pool_target(pool_ref):
    try:
        target, _pool = bootstrap_builder.resolve_pool_target(pool_ref)
    except ValueError as error:
        raise SystemExit(_fail(str(error)))
    return target


def cmd_explore(args):
    driver_args = ['--source', args.source, '--level', args.level]
    if args.catalog:
        driver_args.extend(['--catalog', args.catalog])
    if args.schema:
        driver_args.extend(['--schema', args.schema])
    if args.table:
        driver_args.extend(['--table', args.table])
    if args.source == 'local':
        driver_args.extend(['--pool', _require_pool_target(args.pool)])
    elif args.profile:
        driver_args.extend(['--profile', args.profile])
    return _run_driver('uc_explore.py', driver_args)


def cmd_preview(args):
    driver_args = [
        '--pool', _require_pool_target(args.pool),
        '--path', args.path,
        '--format', args.format,
        '--limit', str(args.limit),
    ]
    return _run_driver('preview_table.py', driver_args)


# ---------------------------------------------------------------------------


def build_arg_parser():
    # Show whichever name the user invoked: `scr --help` reads better than
    # `spark-cell-runner --help` when the alias is the entry point.
    invoked_name = os.path.basename(sys.argv[0]) if sys.argv else 'spark-cell-runner'

    parser = argparse.ArgumentParser(
        prog=invoked_name if invoked_name in ('scr', 'spark-cell-runner') else 'spark-cell-runner',
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument('--version', action='version', version=f'spark-cell-runner {__version__}')

    sub = parser.add_subparsers(dest='command')

    pool = sub.add_parser('pool', help='manage local Sail Spark pools (shared with the extension)')
    pool_sub = pool.add_subparsers(dest='pool_command')

    p_create = pool_sub.add_parser('create', help='create a named pool')
    p_create.add_argument('name')
    p_create.add_argument('--python', default=sys.executable, help='Python command for the pool server')
    p_create.add_argument('--port', type=int, default=None)
    p_create.set_defaults(func=cmd_pool_create)

    p_start = pool_sub.add_parser('start', help='start a pool and wait for its port')
    p_start.add_argument('name')
    p_start.set_defaults(func=cmd_pool_start)

    p_stop = pool_sub.add_parser('stop', help='stop a running pool')
    p_stop.add_argument('name')
    p_stop.set_defaults(func=cmd_pool_stop)

    p_list = pool_sub.add_parser('list', help='list pools')
    p_list.set_defaults(func=cmd_pool_list)

    p_delete = pool_sub.add_parser('delete', help='delete a pool manifest (warehouse is kept)')
    p_delete.add_argument('name')
    p_delete.set_defaults(func=cmd_pool_delete)

    p_logs = pool_sub.add_parser('logs', help='show the tail of a pool log')
    p_logs.add_argument('name')
    p_logs.add_argument('--tail', type=int, default=50)
    p_logs.set_defaults(func=cmd_pool_logs)

    run = sub.add_parser('run', help='run a Databricks notebook-source .py file cell by cell')
    run.add_argument('notebook')
    run.add_argument('--pool', default=None, help='pool name or sc:// URL (default: the only pool)')
    run.add_argument('--serverless', action='store_true', help='run on Databricks serverless')
    run.add_argument('--cluster-id', default=None, help='run on a Databricks cluster')
    run.add_argument('--profile', default=None, help='Databricks config profile')
    run.add_argument('--cells', default='all', help="cells to run: 'all', '3', or '1-3'")
    run.add_argument('--show', action='store_true', help='show SQL cell results (default: yes)')
    run.add_argument('--no-show', dest='show', action='store_false')
    run.set_defaults(func=cmd_run, show=True)

    sql = sub.add_parser('sql', help='execute a .sql file (or - for stdin) on a pool')
    sql.add_argument('file')
    sql.add_argument('--pool', default=None)
    sql.add_argument('--limit', type=int, default=100)
    sql.set_defaults(func=cmd_sql)

    sync = sub.add_parser('sync', help='sync Unity Catalog schemas/tables into the local warehouse')
    sync.add_argument('--pool', default=None)
    sync.add_argument('--mode', choices=['schema', 'data'], default='schema')
    sync.add_argument('--format', choices=['delta', 'iceberg'], default='delta',
                      help='local table format (Sail writes both natively)')
    sync.add_argument('--catalog', default='')
    sync.add_argument('--schema', default='')
    sync.add_argument('--tables', default='', help='glob pattern, e.g. dim_*')
    sync.add_argument('--limit', type=int, default=0)
    sync.add_argument('--profile', default='')
    sync.add_argument('--serverless', action='store_true')
    sync.add_argument('--cluster-id', default='')
    sync.set_defaults(func=cmd_sync)

    explore = sub.add_parser('explore', help='list catalogs/schemas/tables (JSON)')
    explore.add_argument('--source', choices=['local', 'databricks'], default='local')
    explore.add_argument('--level', choices=['catalogs', 'schemas', 'tables', 'table-details'],
                         default='tables')
    explore.add_argument('--catalog', default='')
    explore.add_argument('--schema', default='')
    explore.add_argument('--table', default='')
    explore.add_argument('--pool', default=None)
    explore.add_argument('--profile', default='')
    explore.set_defaults(func=cmd_explore)

    preview = sub.add_parser('preview', help='preview rows of a local Delta/Iceberg table (CSV)')
    preview.add_argument('path', help='table directory on disk')
    preview.add_argument('--pool', default=None)
    preview.add_argument('--format', choices=['auto', 'delta', 'iceberg'], default='auto')
    preview.add_argument('--limit', type=int, default=20)
    preview.set_defaults(func=cmd_preview)

    return parser


def main(argv=None):
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    if not getattr(args, 'func', None):
        parser.print_help()
        return 0

    return args.func(args)


if __name__ == '__main__':
    sys.exit(main())
