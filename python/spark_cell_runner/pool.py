#!/usr/bin/env python3
"""Local Sail Spark pool management, shared with the VS Code extension.

A "pool" is a persistent Sail Spark Connect server (`python -m pysail spark
server`) whose identity lives in a JSON manifest under
``~/.spark-cell-runner/pools/<name>.json`` — the same manifests the extension
reads and writes, so pools created either way are visible in both.

Manifest fields (kept identical to poolManager.js):
  name, engine, pythonCommand, port, warehousePath, pid, createdAt, logFile
"""

import json
import os
import re
import socket
import subprocess
import sys
import time
from datetime import datetime, timezone

POOL_NAME_REGEX = re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9._-]{0,39}$')
START_TIMEOUT_SECS = 60


def home_root():
    return os.path.join(os.path.expanduser('~'), '.spark-cell-runner')


def pools_root():
    return os.path.join(home_root(), 'pools')


def logs_root():
    return os.path.join(pools_root(), 'logs')


def warehouse_root():
    return os.path.join(home_root(), 'warehouse')


def pool_manifest_path(name):
    return os.path.join(pools_root(), f'{name}.json')


def ensure_dirs():
    os.makedirs(pools_root(), exist_ok=True)
    os.makedirs(logs_root(), exist_ok=True)


def is_pid_alive(pid):
    if not pid or not isinstance(pid, int):
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False


def probe_port(port, host='127.0.0.1', timeout=0.6):
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def is_pool_serving(pool):
    if not pool or not is_pid_alive(pool.get('pid')):
        return False
    return probe_port(pool.get('port'))


def find_free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def list_pools():
    try:
        names = os.listdir(pools_root())
    except OSError:
        return []

    pools = []
    for file_name in names:
        if not file_name.endswith('.json'):
            continue
        try:
            with open(os.path.join(pools_root(), file_name), encoding='utf-8') as handle:
                manifest = json.load(handle)
        except (OSError, ValueError):
            continue
        if manifest and manifest.get('name') and POOL_NAME_REGEX.match(manifest['name']):
            manifest['running'] = is_pool_serving(manifest)
            pools.append(manifest)

    pools.sort(key=lambda pool: pool['name'])
    return pools


def get_pool(name):
    if not name:
        return None
    for pool in list_pools():
        if pool['name'] == name:
            return pool
    return None


def save_manifest(manifest):
    ensure_dirs()
    persisted = {key: value for key, value in manifest.items() if key != 'running'}
    with open(pool_manifest_path(manifest['name']), 'w', encoding='utf-8') as handle:
        json.dump(persisted, handle, indent=2)
        handle.write('\n')


def create_pool(name, python_command=None, port=None, engine='sail'):
    trimmed = str(name or '').strip()

    if not POOL_NAME_REGEX.match(trimmed):
        raise ValueError(
            'Pool name must start with a letter or digit and use only letters, '
            'digits, dots, dashes, or underscores (max 40 chars).'
        )
    if get_pool(trimmed):
        raise ValueError(f'A local pool named "{trimmed}" already exists.')

    python_command = (python_command or sys.executable).strip()
    if not python_command:
        raise ValueError('A Python command is required to create a local pool.')

    if port is None:
        port = find_free_port()
    port = int(port)
    if not 1 <= port <= 65535:
        raise ValueError('Pool port must be an integer between 1 and 65535.')

    ensure_dirs()
    warehouse_path = os.path.join(warehouse_root(), trimmed)
    os.makedirs(warehouse_path, exist_ok=True)

    manifest = {
        'name': trimmed,
        'engine': engine,
        'pythonCommand': python_command,
        'port': port,
        'warehousePath': warehouse_path,
        'pid': None,
        'createdAt': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.') +
                     f'{datetime.now(timezone.utc).microsecond // 1000:03d}Z',
        'logFile': os.path.join(logs_root(), f'{trimmed}.log'),
    }
    save_manifest(manifest)
    return manifest


def delete_pool(name):
    pool = get_pool(name)
    if not pool:
        return False
    if pool.get('pid') and is_pid_alive(pool['pid']):
        stop_pool(name)
    try:
        os.remove(pool_manifest_path(pool['name']))
    except OSError:
        pass
    return True


def kill_pid(pid):
    if sys.platform == 'win32':
        subprocess.run(
            ['taskkill', '/PID', str(pid), '/T', '/F'],
            capture_output=True,
            check=False,
        )
        return
    try:
        os.kill(pid, 15)
    except OSError:
        return
    time.sleep(0.8)
    try:
        os.kill(pid, 9)
    except OSError:
        pass


def append_pool_log(pool, text):
    ensure_dirs()
    with open(pool['logFile'], 'a', encoding='utf-8') as handle:
        handle.write(text)


def start_pool(name):
    pool = get_pool(name)
    if not pool:
        raise ValueError(f'No local pool named "{name}" exists.')

    if is_pool_serving(pool):
        return {**pool, 'running': True}

    ensure_dirs()
    os.makedirs(pool['warehousePath'], exist_ok=True)

    command = pool['pythonCommand'].split() or [sys.executable]
    append_pool_log(pool, f"\n=== start {datetime.now(timezone.utc).isoformat()} pid-tbd ===\n")

    env = {
        **os.environ,
        'SAIL_SPARK__SESSION_TIMEOUT_SECS': '3600',
        'RUST_LOG': 'info',
    }

    log_handle = open(pool['logFile'], 'a', encoding='utf-8')
    popen_kwargs = {
        'stdin': subprocess.DEVNULL,
        'stdout': log_handle,
        'stderr': log_handle,
        'cwd': pool['warehousePath'],
        'env': env,
    }
    if sys.platform == 'win32':
        popen_kwargs['creationflags'] = (
            subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
        )
    else:
        popen_kwargs['start_new_session'] = True

    try:
        child = subprocess.Popen(
            [*command, '-m', 'pysail', 'spark', 'server', '--ip', '127.0.0.1', '--port', str(pool['port'])],
            **popen_kwargs,
        )
    finally:
        log_handle.close()

    print(f'[pool] started "{pool["name"]}" (pid {child.pid}) on sc://127.0.0.1:{pool["port"]}, '
          f'waiting for the port to open...')

    manifest = {**pool, 'pid': child.pid}
    save_manifest(manifest)

    deadline = time.time() + START_TIMEOUT_SECS
    while time.time() < deadline:
        if probe_port(pool['port']):
            print(f'[pool] "{pool["name"]}" is serving on sc://127.0.0.1:{pool["port"]}')
            return {**manifest, 'running': True}
        time.sleep(0.5)

    kill_pid(child.pid)
    save_manifest({**pool, 'pid': None})
    raise TimeoutError(
        f'Local pool "{pool["name"]}" did not open port {pool["port"]} within '
        f'{START_TIMEOUT_SECS}s. Check the pool log: {pool["logFile"]}'
    )


def stop_pool(name):
    pool = get_pool(name)
    if not pool:
        return False

    if pool.get('pid'):
        kill_pid(pool['pid'])

    save_manifest({**pool, 'pid': None})
    return True
