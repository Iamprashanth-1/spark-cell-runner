// Local Spark pool management. A "pool" is a persistent Sail Spark Connect
// server process (`python -m pysail spark server`) whose identity lives in a
// JSON manifest under <home>/.spark-cell-runner/pools/. Pools are shared
// across workspaces so the sidebar and notebook sessions can discover them
// even though the pool process is detached from the extension host.
//
// This module stays free of the vscode import so pool logic can be exercised
// from plain Node (see test/preview-ui.js style stubbing) — UI concerns live
// in commands.js and ui/sidebar.js.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const { resolveCommandParts } = require('./pythonEnv');

const POOL_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,39}$/;
const PORT_OPEN_TIMEOUT_MS = 600;
const START_TIMEOUT_MS = 60000;

function getPoolsRoot() {
  return path.join(os.homedir(), '.spark-cell-runner', 'pools');
}

function getLogsRoot() {
  return path.join(getPoolsRoot(), 'logs');
}

function getWarehouseRoot() {
  return path.join(os.homedir(), '.spark-cell-runner', 'warehouse');
}

function getPoolManifestPath(name) {
  return path.join(getPoolsRoot(), `${name}.json`);
}

function ensureDirs() {
  fs.mkdirSync(getPoolsRoot(), { recursive: true });
  fs.mkdirSync(getLogsRoot(), { recursive: true });
}

function isPidAlive(pid) {
  if (!pid || !Number.isFinite(pid)) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// Best-effort TCP probe of the Spark Connect port.
function probePort(port, host = '127.0.0.1', timeoutMs = PORT_OPEN_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function isPoolServing(pool) {
  if (!pool || !isPidAlive(pool.pid)) {
    return false;
  }
  return probePort(pool.port);
}

// Sync status used by the sidebar renderer (pid heuristic); a stale pid can
// occasionally show "running" until the next run probes the port for real.
function isPoolRunning(pool) {
  return Boolean(pool && isPidAlive(pool.pid));
}

function listPools() {
  const root = getPoolsRoot();

  let files;
  try {
    files = fs.readdirSync(root);
  } catch {
    return [];
  }

  const pools = [];
  for (const fileName of files) {
    if (!fileName.endsWith('.json')) {
      continue;
    }

    try {
      const raw = fs.readFileSync(path.join(root, fileName), 'utf8');
      const manifest = JSON.parse(raw);
      if (manifest && manifest.name && POOL_NAME_REGEX.test(manifest.name)) {
        pools.push({
          ...manifest,
          running: isPoolRunning(manifest),
          logFile: manifest.logFile || path.join(getLogsRoot(), `${manifest.name}.log`),
        });
      }
    } catch {
      // Skip unreadable manifests rather than breaking the whole sidebar.
    }
  }

  pools.sort((left, right) => left.name.localeCompare(right.name));
  return pools;
}

function getPool(name) {
  if (!name) {
    return undefined;
  }
  return listPools().find((pool) => pool.name === name);
}

function saveManifest(manifest) {
  ensureDirs();
  const { running, ...persisted } = manifest;
  fs.writeFileSync(
    getPoolManifestPath(manifest.name),
    `${JSON.stringify(persisted, null, 2)}\n`,
    'utf8'
  );
}

function createPool({ name, pythonCommand, port, engine = 'sail' }) {
  const trimmedName = String(name || '').trim();

  if (!POOL_NAME_REGEX.test(trimmedName)) {
    throw new Error(
      'Pool name must start with a letter or digit and use only letters, digits, dots, dashes, or underscores (max 40 chars).'
    );
  }

  if (getPool(trimmedName)) {
    throw new Error(`A local pool named "${trimmedName}" already exists.`);
  }

  if (!pythonCommand || !pythonCommand.trim()) {
    throw new Error('A Python command is required to create a local pool.');
  }

  const warehousePath = path.join(getWarehouseRoot(), trimmedName);
  fs.mkdirSync(warehousePath, { recursive: true });

  const manifest = {
    name: trimmedName,
    engine,
    pythonCommand: pythonCommand.trim(),
    port: Number(port),
    warehousePath,
    pid: null,
    createdAt: new Date().toISOString(),
    logFile: path.join(getLogsRoot(), `${trimmedName}.log`),
  };

  if (!Number.isInteger(manifest.port) || manifest.port < 1 || manifest.port > 65535) {
    throw new Error('Pool port must be an integer between 1 and 65535.');
  }

  saveManifest(manifest);
  return { ...manifest, running: false };
}

async function deletePool(name) {
  const pool = getPool(name);

  if (!pool) {
    return false;
  }

  if (pool.running) {
    await stopPool(name);
  }

  fs.rmSync(getPoolManifestPath(pool.name), { force: true });
  return true;
}

async function killPid(pid) {
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => resolve());
    });
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, 800));
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

function appendPoolLog(pool, text) {
  ensureDirs();
  fs.appendFileSync(pool.logFile, text, 'utf8');
}

// Starts the detached Sail server and waits for the Spark Connect port to
// open. Resolves with the updated manifest or throws with a pointer to logs.
async function startPool(name, output) {
  const pool = getPool(name);

  if (!pool) {
    throw new Error(`No local pool named "${name}" exists.`);
  }

  if (await isPoolServing(pool)) {
    return pool;
  }

  const commandParts = resolveCommandParts(pool.pythonCommand);

  if (commandParts.length === 0) {
    throw new Error(
      `Could not resolve the Python command "${pool.pythonCommand}" for pool "${pool.name}".`
    );
  }

  ensureDirs();
  fs.mkdirSync(pool.warehousePath, { recursive: true });

  const startedLine = `\n=== start ${new Date().toISOString()} pid-tbd ===\n`;
  appendPoolLog(pool, startedLine);

  const logFd = fs.openSync(pool.logFile, 'a');
  const child = spawn(
    commandParts[0],
    [
      ...commandParts.slice(1),
      '-m',
      'pysail',
      'spark',
      'server',
      '--ip',
      '127.0.0.1',
      '--port',
      String(pool.port),
    ],
    {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
      // Default managed-table locations (spark-warehouse/ etc.) resolve
      // against the server's cwd, so pin it to the pool warehouse.
      cwd: pool.warehousePath,
      env: {
        ...process.env,
        SAIL_SPARK__SESSION_TIMEOUT_SECS: '3600',
        RUST_LOG: 'info',
      },
    }
  );

  child.on('error', (error) => {
    appendPoolLog(pool, `=== spawn error: ${String(error)} ===\n`);
  });

  child.unref();
  fs.closeSync(logFd);

  if (output) {
    output.appendLine(
      `[pool] started "${pool.name}" (pid ${child.pid}) on sc://127.0.0.1:${pool.port}, waiting for the port to open...`
    );
  }

  const manifest = { ...pool, pid: child.pid };
  saveManifest(manifest);

  // Probe the port on a deadline; Sail boots fast but the first start on a
  // cold machine (antivirus scans, pip startup) can take a while.
  let serving = false;
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probePort(pool.port)) {
      serving = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (!serving) {
    await killPid(child.pid);
    saveManifest({ ...pool, pid: null });
    throw new Error(
      `Local pool "${pool.name}" did not open port ${pool.port} within ${Math.round(START_TIMEOUT_MS / 1000)}s. ` +
        `Check the pool log: ${pool.logFile}`
    );
  }

  if (output) {
    output.appendLine(`[pool] "${pool.name}" is serving on sc://127.0.0.1:${pool.port}`);
  }

  return { ...manifest, running: true };
}

async function stopPool(name) {
  const pool = getPool(name);

  if (!pool) {
    return false;
  }

  if (pool.pid) {
    await killPid(pool.pid);
  }

  saveManifest({ ...pool, pid: null });
  return true;
}

async function waitForPortClosed(port, deadline = Date.now() + 5000) {
  while (Date.now() < deadline) {
    if (!(await probePort(port))) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

// In local mode, notebook sessions must run under the pool's own Python
// environment — that's the one guaranteed to have the pyspark client (and
// matching version) for Spark Connect. Falls back to the caller-provided
// command for databricks mode or when no pool is selected.
function resolveSessionPythonCommand(fallback, configuration) {
  if (configuration && configuration.connectionMode === 'local') {
    const pool = getPool(configuration.localPool);
    if (pool && pool.pythonCommand) {
      return pool.pythonCommand;
    }
  }
  return fallback;
}

// The pool env needs BOTH pysail (server) and a pyspark client (for the
// session driver and the sync driver to connect over Spark Connect).
async function isSailInstalled(pythonCommand) {
  const commandParts = resolveCommandParts(pythonCommand);

  if (commandParts.length === 0) {
    return false;
  }

  return new Promise((resolve) => {
    const child = spawn(commandParts[0], [...commandParts.slice(1), '-c', 'import pysail, pyspark'], {
      shell: false,
    });

    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

async function installSail(pythonCommand, output) {
  const commandParts = resolveCommandParts(pythonCommand);

  if (commandParts.length === 0) {
    throw new Error(`Could not resolve the Python command "${pythonCommand}".`);
  }

  if (output) {
    output.appendLine(`[pool] installing pysail and pyspark-client into ${pythonCommand}...`);
  }

  return new Promise((resolve, reject) => {
    execFile(
      commandParts[0],
      [...commandParts.slice(1), '-m', 'pip', 'install', 'pysail', 'pyspark-client'],
      { windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (output) {
          if (stdout) {
            output.appendLine(stdout.trimEnd());
          }
          if (stderr) {
            output.appendLine(stderr.trimEnd());
          }
        }

        if (error) {
          reject(new Error(`pip install failed: ${error.message}`));
          return;
        }

        resolve({ ok: true });
      }
    );
  });
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

module.exports = {
  POOL_NAME_REGEX,
  getPoolsRoot,
  getLogsRoot,
  getWarehouseRoot,
  listPools,
  getPool,
  createPool,
  deletePool,
  startPool,
  stopPool,
  isPoolRunning,
  isPoolServing,
  resolveSessionPythonCommand,
  isSailInstalled,
  installSail,
  findFreePort,
  probePort,
};
