// Long-lived per-notebook Python sessions. Each session is a spawned python
// process running src/python/session_driver.py, which executes submitted code
// blocks over a JSON line protocol on stdio so state persists across cells
// (Jupyter-like) without re-importing or reconnecting every run.

const path = require('node:path');
const { spawn } = require('node:child_process');
const { NOTEBOOK_TYPE, BOOTSTRAP_CONNECT_UNAVAILABLE_MARKER } = require('./constants');
const { getConfiguration, stableStringify } = require('./config');
const { resolveCommandParts, createDatabricksChildEnv } = require('./pythonEnv');
const pyResources = require('./pyResources');
const state = require('./state');

async function getOrCreateNotebookSession(notebook, pythonCommand, output) {
  const notebookUri = notebook.uri || notebook;
  const key = getNotebookSessionKey(notebook);
  const configuration = getConfiguration();
  const signature = stableStringify({
    pythonCommand,
    databricksProfile: configuration.databricksProfile,
    clusterId: configuration.clusterId,
    useServerless: configuration.useServerless,
  });

  const existing = state.notebookSessions.get(key);
  if (existing && existing.signature === signature) {
    return existing;
  }
  if (existing) {
    disposeNotebookSessionResources(existing);
    state.notebookSessions.delete(key);
  }

  const commandParts = resolveCommandParts(pythonCommand);
  if (commandParts.length === 0) {
    throw new Error('sparkCellRunner.pythonCommand is empty.');
  }

  const childEnv = createDatabricksChildEnv();
  const session = {
    key,
    signature,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    initialized: false,
    bootstrapCode: '',
    runtimeDataCode: '',
    executedCells: new Set(),
    pending: new Map(),
    sequence: 0,
    stdoutBuffer: '',
    readySettled: false,
    child: spawn(commandParts[0], [...commandParts.slice(1), '-u', pyResources.getSessionDriverPath()], {
      cwd: path.dirname(notebookUri.fsPath || notebookUri.path),
      shell: false,
      env: childEnv,
    }),
  };

  session.ready = new Promise((resolve, reject) => {
    session.resolveReady = resolve;
    session.rejectReady = reject;
  });

  session.child.stdout.on('data', (chunk) => {
    session.stdoutBuffer += chunk.toString();
    const lines = session.stdoutBuffer.split(/\r?\n/);
    session.stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      try {
        const message = JSON.parse(line);
        if (message.type === 'ready') {
          if (!session.readySettled) {
            session.readySettled = true;
            session.resolveReady();
          }
        } else if (message.type === 'result') {
          const pending = session.pending.get(message.id);
          if (pending) {
            session.pending.delete(message.id);
            pending.resolve(message);
          }
        }
      } catch (error) {
        output.appendLine(`[session-parse-error] ${String(error)}: ${line}`);
      }
    }
  });

  session.child.stderr.on('data', (chunk) => {
    output.appendLine(`[session-stderr] ${chunk.toString().trimEnd()}`);
  });

  session.child.on('error', (error) => {
    if (!session.readySettled) {
      session.readySettled = true;
      session.rejectReady(error);
    }
    for (const pending of session.pending.values()) {
      pending.reject(error);
    }
    session.pending.clear();
  });

  session.child.on('close', (code) => {
    const error = new Error(`Notebook session exited with code ${code}`);
    if (!session.readySettled) {
      session.readySettled = true;
      session.rejectReady(error);
    }
    for (const pending of session.pending.values()) {
      pending.reject(error);
    }
    session.pending.clear();
    if (state.notebookSessions.get(key) === session) {
      state.notebookSessions.delete(key);
    }
  });

  state.notebookSessions.set(key, session);
  await session.ready;
  return session;
}

async function executeInNotebookSession(session, code) {
    const id = ++session.sequence;

    const payload = {
        type: 'exec',
        id,
        code: Buffer.from(code, 'utf8').toString('base64'),
    };

    const response = await new Promise((resolve, reject) => {
        session.pending.set(id, { resolve, reject });
        session.child.stdin.write(`${JSON.stringify(payload)}\n`);
    });

    return {
        exitCode: response.ok ? 0 : 1,
        stdout: response.stdout || '',
        stderr: response.stderr || '',
        ok: Boolean(response.ok),
    };
}

function disposeNotebookSession(uri, options) {
    const key = getNotebookSessionKey(uri);
    const session = state.notebookSessions.get(key);
    const preserveRunHistory = Boolean(options && options.preserveRunHistory);

    if (!session) {
        if (!preserveRunHistory) {
            state.notebookRunHistory.delete(key);
        }
        return;
    }

    disposeNotebookSessionResources(session);
    state.notebookSessions.delete(key);

    if (!preserveRunHistory) {
        state.notebookRunHistory.delete(key);
    }
}

function disposeNotebookSessionResources(session) {
    try {
        session.child.stdin.end();
    } catch {}

    try {
        session.child.kill();
    } catch {}
}

function disposeAllNotebookSessions() {
    for (const session of state.notebookSessions.values()) {
        disposeNotebookSessionResources(session);
    }
    state.notebookSessions.clear();
}

function getNotebookSessionKey(notebookOrUri) {
    const notebookType =
        notebookOrUri && notebookOrUri.notebookType
            ? notebookOrUri.notebookType
            : NOTEBOOK_TYPE;

    const uri =
        notebookOrUri && notebookOrUri.uri
            ? notebookOrUri.uri
            : notebookOrUri;

    if (!uri) {
        return notebookType;
    }

    if (uri.scheme === 'file' && uri.fsPath) {
        return `${notebookType}:${path.normalize(uri.fsPath).toLowerCase()}`;
    }

    return `${notebookType}:${uri.path || uri.toString()}`;
}

function getOrCreateNotebookRunHistory(key) {
    let history = state.notebookRunHistory.get(key);

    if (!history) {
        history = {
            executedCells: new Set(),
        };

        state.notebookRunHistory.set(key, history);
    }

    return history;
}

function getReplayExecutedCellIndices(runHistory, session, targetCellIndex) {
    const replayIndices = [];

    for (const index of runHistory.executedCells) {
        if (index < targetCellIndex && !session.executedCells.has(index)) {
            replayIndices.push(index);
        }
    }

    replayIndices.sort((left, right) => left - right);
    return replayIndices;
}

function extractBootstrapConnectError(initResult) {
    const marker = BOOTSTRAP_CONNECT_UNAVAILABLE_MARKER;

    const haystack = `${(initResult && initResult.stdout) || ''}\n${
        (initResult && initResult.stderr) || ''
    }`;

    const line = haystack
        .split(/\r?\n/)
        .find((entry) => entry.includes(marker));

    if (!line) {
        return undefined;
    }

    const detail = line
        .slice(line.indexOf(marker) + marker.length)
        .trim();

    return (
        detail ||
        'Databricks Connect is unavailable in the selected environment.'
    );
}

function filterNotebookStdout(stdout) {
    if (!stdout) {
        return '';
    }

    const filteredLines = stdout
        .split(/\r?\n/)
        .filter((line) => {
            const trimmed = line.trim();

            if (!trimmed) {
                return false;
            }

            if (
                trimmed.startsWith(
                    '[spark-cell-runner] Skipping dbutils.library.restartPython()'
                )
            ) {
                return false;
            }

            if (
                trimmed.startsWith(
                    '[spark-cell-runner] log_appinsights fallback:'
                )
            ) {
                return false;
            }

            if (
                trimmed ===
                '/Workspace/14194_BRIX/App_Configuration/dbconfig.json'
            ) {
                return false;
            }

            if (trimmed === 'Common Functions Init') {
                return false;
            }

            return true;
        });

    return filteredLines.join('\n').trim();
}

module.exports = {
    getOrCreateNotebookSession,
    executeInNotebookSession,
    disposeNotebookSession,
    disposeNotebookSessionResources,
    disposeAllNotebookSessions,
    getNotebookSessionKey,
    getOrCreateNotebookRunHistory,
    getReplayExecutedCellIndices,
    extractBootstrapConnectError,
    filterNotebookStdout,
};
