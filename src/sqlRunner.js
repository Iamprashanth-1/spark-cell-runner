// SQL runner: executes .sql files or selections against the active local pool
// via src/python/execute_sql.py (SQL text over stdin, JSON lines back), and
// renders per-statement results into a read-only editor tab.

const path = require('node:path');
const fs = require('node:fs');
const vscode = require('vscode');
const poolManager = require('./poolManager');
const { getConfiguration } = require('./config');
const { resolveCommandParts } = require('./pythonEnv');
const state = require('./state');

// Splits SQL into statements the same way execute_sql.py does, tracking line
// numbers so CodeLenses can be attached per statement.
function splitStatements(sqlText) {
  const statements = [];
  let current = { lines: [], startLine: 0 };
  let lineIndex = 0;
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;
  let started = false;

  const lines = sqlText.split('\n');

  for (lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    let charIndex = 0;

    while (charIndex < line.length) {
      const char = line[charIndex];
      const next = line[charIndex + 1] || '';

      if (inLineComment) {
        break;
      }
      if (inBlockComment) {
        if (char === '*' && next === '/') {
          inBlockComment = false;
          charIndex += 2;
          continue;
        }
        charIndex += 1;
        continue;
      }

      if (!inSingle && !inDouble && char === '-' && next === '-') {
        inLineComment = true;
        break;
      }
      if (!inSingle && !inDouble && char === '/' && next === '*') {
        inBlockComment = true;
        charIndex += 2;
        continue;
      }
      if (char === "'" && !inDouble) {
        inSingle = !inSingle;
        started = true;
        charIndex += 1;
        continue;
      }
      if (char === '"' && !inSingle) {
        inDouble = !inDouble;
        started = true;
        charIndex += 1;
        continue;
      }
      if (char === ';' && !inSingle && !inDouble) {
        current.lines.push(line);
        if (statementHasContent(current.lines)) {
          statements.push({ text: current.lines.join('\n'), startLine: current.startLine });
        }
        current = { lines: [], startLine: lineIndex + 1 };
        started = false;
        charIndex += 1;
        continue;
      }

      if (!started && !/\s/.test(char)) {
        started = true;
      }
      charIndex += 1;
    }

    inLineComment = false;
    current.lines.push(line);
  }

  if (statementHasContent(current.lines)) {
    statements.push({ text: current.lines.join('\n'), startLine: current.startLine });
  }

  return statements;
}

function statementHasContent(lines) {
  for (const line of lines) {
    let stripped = line;
    if (stripped.includes('--')) {
      const head = stripped.split('--')[0];
      if (head.trim()) {
        stripped = head;
      }
    }
    const withoutBlocks = stripped.replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (withoutBlocks) {
      return true;
    }
  }
  return false;
}

// Executes the given SQL on the pool; resolves with { ok, statements, summary }.
async function runSqlOnPool(sqlText, { limit = 200 } = {}) {
  const configuration = getConfiguration();
  const pool = poolManager.getPool(configuration.localPool);

  if (!pool) {
    throw new Error('No local Spark pool is selected. Create one from the Configuration panel.');
  }

  if (!(await poolManager.isPoolServing(pool))) {
    throw new Error(`Local Spark pool "${pool.name}" is not running. Start it from the Configuration panel.`);
  }

  const commandParts = resolveCommandParts(
    poolManager.resolveSessionPythonCommand(configuration.pythonCommand, configuration)
  );
  const scriptPath = path.join(__dirname, 'python', 'execute_sql.py');

  return new Promise((resolve, reject) => {
    const child = require('node:child_process').spawn(
      commandParts[0],
      [...commandParts.slice(1), scriptPath, '--pool', `sc://127.0.0.1:${pool.port}`, '--limit', String(limit)],
      { shell: false, windowsHide: true }
    );

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.stdin.on('error', () => {});
    child.on('error', reject);

    child.on('close', () => {
      const lines = stdout.split('\n').filter((line) => line.trim());
      const statements = [];
      let done;

      for (const line of lines) {
        try {
          const message = JSON.parse(line);

          if (message.type === 'statement' || message.type === 'statement-error') {
            statements.push(message);
          } else if (message.type === 'done') {
            done = message;
          } else if (message.type === 'error') {
            reject(new Error(message.message));
            return;
          }
        } catch {
          // Non-JSON noise goes to the output channel below.
          if (state.output) {
            state.output.appendLine(`[sql] ${line.trimEnd()}`);
          }
        }
      }

      if (!done) {
        reject(new Error(`SQL execution ended unexpectedly. ${stderr.trim().split('\n').pop() || ''}`));
        return;
      }

      resolve({ ok: done.ok, executed: done.executed, failed: done.failed, statements });
    });

    child.stdin.write(sqlText);
    child.stdin.end();
  });
}

// Renders results into a read-only editor tab.
async function showSqlResults(results, sourceLabel) {
  const output = state.output;

  if (!output) {
    return;
  }

  output.appendLine('');
  output.appendLine(`[sql] ${sourceLabel} - ${results.executed} statement(s) executed, ${results.failed} failed`);

  for (const statement of results.statements) {
    output.appendLine(`[sql] -- [${statement.index + 1}] ${statement.sql}`);

    if (statement.type === 'statement-error') {
      output.appendLine(`[sql]    ERROR: ${statement.message}`);
    } else if (statement.csv) {
      output.appendLine(`[sql]    ${statement.shown} rows${statement.capped ? ' (reached the limit - may have more)' : ''}`);
      for (const line of statement.csv.trimEnd().split('\n')) {
        output.appendLine(`[sql]    ${line}`);
      }
    } else if (statement.shown === 0) {
      output.appendLine('[sql]    (0 rows)');
    } else {
      output.appendLine('[sql]    (ok, no result set)');
    }
  }

  output.show(true);
}

// Shared entry point for the commands: reads SQL from the source and runs it.
async function executeSql(sqlText, sourceLabel, { limit } = {}) {
  state.output.show(true);

  const results = await runSqlOnPool(sqlText, { limit });
  await showSqlResults(results, sourceLabel);

  if (results.failed > 0) {
    void vscode.window.showWarningMessage(
      `SQL finished with ${results.failed} failed statement(s). See the results tab.`
    );
  }

  return results;
}

module.exports = {
  splitStatements,
  statementHasContent,
  runSqlOnPool,
  showSqlResults,
  executeSql,
};
