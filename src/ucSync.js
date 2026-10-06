// Unity Catalog -> local pool sync orchestration. Spawns src/python/uc_sync.py
// as a one-shot process and parses its JSON progress lines. Sync results are
// kept in shared state so the sidebar can render the last sync summary.

const path = require('node:path');
const { spawn } = require('node:child_process');
const poolManager = require('./poolManager');
const { resolveCommandParts } = require('./pythonEnv');
const { getConfiguration } = require('./config');
const state = require('./state');

function buildSyncArgs(configuration, pool, overrides = {}) {
  const args = [
    '--pool', `sc://127.0.0.1:${pool.port}`,
    '--mode', overrides.mode || configuration.syncMode || 'schema',
    '--catalog', configuration.syncCatalog || '',
    '--schema', configuration.syncSchema || '',
    '--tables', configuration.syncTables || '',
    '--limit', String(configuration.syncRowLimit || 0),
  ];

  if (configuration.databricksProfile) {
    args.push('--profile', configuration.databricksProfile);
  }

  const mode = overrides.mode || configuration.syncMode || 'schema';
  if (mode === 'data') {
    args.push('--databricks-mode', configuration.useServerless ? 'serverless' : 'cluster');
    if (configuration.clusterId) {
      args.push('--cluster-id', configuration.clusterId);
    }
  }

  return args;
}

// Runs one sync. onProgress(message, done, total) is invoked for each JSON
// progress line; overrides.mode temporarily overrides sparkCellRunner.syncMode
// for this run without touching the setting. The final result resolves with
// { ok, synced, failed, summary }.
async function runSync(output, onProgress, overrides = {}) {
  const configuration = getConfiguration();
  const pool = poolManager.getPool(configuration.localPool);

  if (!pool) {
    throw new Error('No local Spark pool is selected. Create one from the Configuration panel first.');
  }

  const commandParts = resolveCommandParts(
    poolManager.resolveSessionPythonCommand(configuration.pythonCommand, configuration)
  );

  if (commandParts.length === 0) {
    throw new Error(`Could not resolve the Python command "${configuration.pythonCommand}".`);
  }

  if (!(await poolManager.isPoolServing(pool))) {
    throw new Error(`Local Spark pool "${pool.name}" is not running. Start it before syncing.`);
  }

  const scriptPath = path.join(__dirname, 'python', 'uc_sync.py');
  const args = buildSyncArgs(configuration, pool, overrides);
  const result = { ok: false, synced: 0, failed: 0, summary: '', messages: [] };

  state.lastSyncResult = { ...result, running: true };
  if (output) {
    output.appendLine(`[sync] starting UC sync (${configuration.syncMode || 'schema'} mode) via ${configuration.pythonCommand}`);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(commandParts[0], [...commandParts.slice(1), scriptPath, ...args], {
      shell: false,
      windowsHide: true,
    });

    let stdoutBuffer = '';

    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }

        let message;
        try {
          message = JSON.parse(line);
        } catch {
          result.messages.push(line);
          if (output) {
            output.appendLine(`[sync] ${line.trimEnd()}`);
          }
          continue;
        }

        if (message.type === 'progress') {
          result.messages.push(message.message);
          if (output) {
            output.appendLine(`[sync] ${message.message}`);
          }
          if (onProgress) {
            onProgress(message.message, message.done, message.total);
          }
        } else if (message.type === 'done') {
          result.ok = Boolean(message.ok);
          result.synced = message.synced || 0;
          result.failed = message.failed || 0;
          result.summary = message.summary || '';
        } else if (message.type === 'error') {
          reject(new Error(message.message));
          return;
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString().trimEnd();
      if (text && output) {
        output.appendLine(`[sync-stderr] ${text}`);
      }
    });

    child.on('error', (error) => {
      state.lastSyncResult = { ...result, running: false, error: error.message };
      reject(error);
    });

    child.on('close', (code) => {
      result.exitCode = code;
      result.running = false;

      if (!result.summary) {
        result.summary = code === 0 ? 'sync finished' : `sync exited with code ${code}`;
        result.ok = code === 0;
      }

      state.lastSyncResult = { ...result };
      if (output) {
        output.appendLine(`[sync] ${result.summary}`);
      }
      resolve(result);
    });
  });
}

module.exports = { runSync };
