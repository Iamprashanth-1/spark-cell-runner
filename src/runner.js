// Run orchestration: executes notebook cells through a persistent session, both
// from the plain text editor view (runNotebookCells) and from the notebook
// editor controller (executeNotebookCells).

const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { NOTEBOOK_TYPE, JUPYTER_NOTEBOOK_TYPE } = require('./constants');
const { parseNotebookText, parseNotebookFromNotebookDocument, findCellIndexForLine } = require('./parser');
const { getConfiguration } = require('./config');
const pyResources = require('./pyResources');
const session = require('./session');
const scriptBuilder = require('./scriptBuilder');
const pythonEnv = require('./pythonEnv');
const poolManager = require('./poolManager');
const decorations = require('./ui/decorations');
const { showRunResultPanel, buildResultText } = require('./ui/resultPanel');
const state = require('./state');

const notebookControllers = new Map();

// Run one cell (or all cells up to the cursor) from a notebook-source .py file
// opened as a plain text editor.
async function runNotebookCells(document, output, line) {
    const runStartTime = Date.now();
    const parsed = parseNotebookText(document.uri.fsPath, document.getText());

    if (!parsed.isNotebookSource) {
        void vscode.window.showWarningMessage(
            "The active file is not a Databricks notebook-source Python file."
        );
        return;
    }

    const documentKey = session.getNotebookSessionKey({
        uri: document.uri,
        notebookType: NOTEBOOK_TYPE
    });

    // RECONSTRUCTED: the original snapshot ran parsed.cells.find(...) here, which
    // returns the cell object (or undefined) instead of its index, so a cursor-run
    // always fell through to the last cell.
    const targetCellIndex =
        line === undefined
            ? (parsed.cells.length > 0 ? parsed.cells[parsed.cells.length - 1].index : -1)
            : findCellIndexForLine(parsed.cells, line);

    const activeCell = parsed.cells.find((cell) => cell.index === targetCellIndex);

    const statusLine = activeCell ? activeCell.startLine : 0;
    const endLine = activeCell ? activeCell.endLine : statusLine;

    const label =
        line === undefined
            ? "all Databricks cells"
            : `Databricks cell ${targetCellIndex + 1}`;

    const configuration = getConfiguration();

    output.appendLine(
        `[perf] start cell=${targetCellIndex + 1} t=${Date.now() - runStartTime}ms`
    );

    if (
        configuration.injectDatabricksBootstrap &&
        configuration.connectionMode !== 'local' &&
        !configuration.useServerless &&
        !configuration.clusterId.trim()
    ) {
        const message =
            'Databricks cluster ID is required unless serverless mode is enabled. Run "Spark Cell Runner: Set Databricks Cluster ID" or "Spark Cell Runner: Enable Serverless".';

        output.show(true);
        output.appendLine(`\n[build-error] ${message}`);

        decorations.updateRunState(
            document,
            targetCellIndex,
            statusLine,
            endLine,
            "failure",
            "Cluster ID required"
        );

        void vscode.window.showErrorMessage(
            message,
            "Set Cluster ID",
            "Enable Serverless"
        ).then(async (selection) => {
            if (selection === "Set Cluster ID") {
                await vscode.commands.executeCommand(
                    "sparkCellRunner.setClusterId"
                );
            } else if (selection === "Enable Serverless") {
                await require('./config').updateWorkspaceSetting(
                    "useServerless",
                    true,
                    document
                );
            }
        });

        return;
    }

    if (configuration.injectDatabricksBootstrap && configuration.connectionMode === 'local') {
        const pool = poolManager.getPool(configuration.localPool);
        const serving = pool ? await poolManager.isPoolServing(pool) : false;

        if (!serving) {
            const message = pool
                ? `Local Spark pool "${pool.name}" is not running. Start it from the Spark Cell Runner sidebar.`
                : 'No local Spark pool is selected. Create one from the Spark Cell Runner sidebar.';

            output.show(true);
            output.appendLine(`\n[build-error] ${message}`);

            decorations.updateRunState(
                document,
                targetCellIndex,
                statusLine,
                endLine,
                'failure',
                'Local pool unavailable'
            );

            void vscode.window.showErrorMessage(
                message,
                pool ? 'Start Pool' : 'Create Pool'
            ).then(async (selection) => {
                if (selection === 'Start Pool') {
                    await vscode.commands.executeCommand(
                        'sparkCellRunner.startLocalPool',
                        pool.name
                    );
                } else if (selection === 'Create Pool') {
                    await vscode.commands.executeCommand(
                        'sparkCellRunner.createLocalPool'
                    );
                }
            });

            return;
        }
    }

    // In local mode the session runs in the pool's venv — the runner env may
    // not have the pyspark client needed for Spark Connect.
    const pythonCommand = poolManager.resolveSessionPythonCommand(
        await pythonEnv.resolvePythonCommand(document),
        configuration
    );

    output.appendLine(
        `[perf] resolvePythonCommand ${Date.now() - runStartTime}ms`
    );

    let built;

    try {
        const notebookLike = {
            uri: document.uri,
            notebookType: NOTEBOOK_TYPE
        };

        let currentSession = await session.getOrCreateNotebookSession(
            notebookLike,
            pythonCommand,
            output
        );

        output.appendLine(
            `[perf] getOrCreateSession ${Date.now() - runStartTime}ms`
        );

        const bootstrapCode = await pyResources.buildBootstrapCode();
        const runtimeDataCode = await pyResources.buildRuntimeDataCode();

        const runHistory = session.getOrCreateNotebookRunHistory(documentKey);

        output.appendLine(
            `[session] ${currentSession.key} seq=${currentSession.sequence} initialized=${currentSession.initialized}`
        );

        if (
            !currentSession.initialized ||
            currentSession.bootstrapCode !== bootstrapCode
        ) {
            const previousExecutedCells = new Set(currentSession.executedCells);

            session.disposeNotebookSession(
                document.uri,
                { preserveRunHistory: true }
            );

            currentSession = await session.getOrCreateNotebookSession(
                notebookLike,
                pythonCommand,
                output
            );

            currentSession.executedCells = previousExecutedCells;

            const initResult = await session.executeInNotebookSession(
                currentSession,
                bootstrapCode
            );

            output.appendLine(
                `[perf] bootstrap ${Date.now() - runStartTime}ms`
            );

            const bootstrapError =
                configuration.injectDatabricksBootstrap
                    ? session.extractBootstrapConnectError(initResult)
                    : undefined;

            if (bootstrapError) {
                const localHint =
                    bootstrapError.kind === 'local-pool' && /No module named/i.test(bootstrapError.detail)
                        ? ' Use the sidebar "Install Sail packages" action to install pysail and pyspark-client into the pool environment, then restart the session.'
                        : '';
                const message =
                    bootstrapError.kind === 'local-pool'
                        ? `Local Spark pool bootstrap failed: ${bootstrapError.detail}.${localHint}`
                        : `Databricks connect is not available in ${pythonCommand}: ${bootstrapError.detail}`;

                output.show(true);
                output.appendLine(`\n[build-error] ${message}`);

                session.disposeNotebookSession(
                    document.uri,
                    { preserveRunHistory: true }
                );

                decorations.updateRunState(
                    document,
                    targetCellIndex,
                    statusLine,
                    endLine,
                    "failure",
                    bootstrapError.kind === 'local-pool'
                        ? "Local pool unavailable"
                        : "Databricks Connect unavailable"
                );

                void vscode.window.showErrorMessage(
                    message,
                    "Select Environment"
                ).then(async (selection) => {
                    if (selection === "Select Environment") {
                        await pythonEnv.selectPythonEnvironment(document);
                    }
                });

                return;
            }

            await session.executeInNotebookSession(
                currentSession,
                runtimeDataCode
            );

            currentSession.runtimeDataCode = runtimeDataCode;
            currentSession.initialized = true;
            currentSession.bootstrapCode = bootstrapCode;

            output.appendLine(
                `[session] initialized ${currentSession.key}`
            );
        } else if (currentSession.runtimeDataCode !== runtimeDataCode) {
            await session.executeInNotebookSession(
                currentSession,
                runtimeDataCode
            );

            currentSession.runtimeDataCode = runtimeDataCode;

            output.appendLine(
                `[session] refreshed runtime data ${currentSession.key}`
            );
        } else {
            output.appendLine(
                `[session] reusing ${currentSession.key}`
            );
        }

        const replayExecutedCellIndices =
            line === undefined
                ? []
                : session.getReplayExecutedCellIndices(
                    runHistory,
                    currentSession,
                    targetCellIndex
                );

        built = await scriptBuilder.buildScriptForParsedNotebook(
            parsed.notebookPath,
            parsed.cells,
            output,
            targetCellIndex,
            undefined,
            {
                includePriorContext: line === undefined,
                injectBootstrap: false,
                replayExecutedCellIndices
            }
        );

        output.appendLine(
            `[perf] buildScript ${Date.now() - runStartTime}ms replay=${replayExecutedCellIndices.length}`
        );

        if (!built) {
            return;
        }

        if (built.unresolvedRunTargets.length > 0) {
            const message =
                `Unresolved %run targets: ${built.unresolvedRunTargets.join(", ")}`;

            output.show(true);
            output.appendLine(`\n[build-error] ${message}`);

            decorations.updateRunState(
                document,
                built.cellIndex,
                built.statusLine,
                built.endLine,
                "failure",
                "Unresolved %run dependencies"
            );

            void vscode.window.showErrorMessage(message);

            return;
        }

        decorations.updateRunState(
            document,
            built.cellIndex,
            built.statusLine,
            built.endLine,
            "running",
            `Running with ${path.basename(pythonCommand)}`
        );

        const result = await session.executeInNotebookSession(
            currentSession,
            built.script
        );

        output.appendLine(
            `[perf] executeInSession ${Date.now() - runStartTime}ms`
        );

        const notebookStdout =
            session.filterNotebookStdout(result.stdout || "");

        output.appendLine(
            `[exitcode] ${result.exitCode}`
        );

        if (notebookStdout) {
            output.appendLine("[stdout]");
            output.appendLine(notebookStdout);
        }

        if (result.stderr) {
            output.appendLine("[stderr]");
            output.appendLine(result.stderr.trimEnd());
        }

        const targetFolder = getTargetFolder(
            document,
            getConfiguration().tempFolder
        );

        const scriptPath = path.join(
            targetFolder,
            built.fileName
        );

        const resultText = buildResultText(
            built,
            {
                ...result,
                stdout: notebookStdout
            },
            scriptPath
        );

        const payload = {
            built,
            result: {
                ...result,
                stdout: notebookStdout
            },
            resultPath: path.join(
                targetFolder,
                built.resultFileName
            ),
            resultText,
            scriptPath
        };

        decorations.updateRunState(
            document,
            built.cellIndex,
            built.statusLine,
            built.endLine,
            result.exitCode === 0 ? "success" : "failure",
            result.exitCode === 0
                ? "Succeeded"
                : `Failed with exit code ${result.exitCode}`,
            payload
        );

        if (result.exitCode === 0) {
            for (const executedCellIndex of built.executedCellIndices) {
                currentSession.executedCells.add(executedCellIndex);
                runHistory.executedCells.add(executedCellIndex);
            }

            output.appendLine(
                `[perf] success total=${Date.now() - runStartTime}ms sessionCells=${currentSession.executedCells.size} historyCells=${runHistory.executedCells.size}`
            );
        } else {
            await fs.mkdir(
                targetFolder,
                { recursive: true }
            );

            await fs.writeFile(
                scriptPath,
                built.script,
                "utf8"
            );

            await fs.writeFile(
                payload.resultPath,
                resultText,
                "utf8"
            );

            output.appendLine(
                `[perf] failure total=${Date.now() - runStartTime}ms`
            );
        }

        if (result.exitCode !== 0) {
            await showRunResultPanel(payload);
        }
    } catch (error) {
        const message =
            error instanceof Error
                ? error.message
                : String(error);

        output.appendLine("[runner-error]");
        output.appendLine(message);

        const failureCellIndex =
            built ? built.cellIndex : targetCellIndex;

        const failureStatusLine =
            built ? built.statusLine : statusLine;

        const failureEndLine =
            built ? built.endLine : endLine;

        decorations.updateRunState(
            document,
            failureCellIndex,
            failureStatusLine,
            failureEndLine,
            "failure",
            "Failed to start runner"
        );

        void vscode.window.showErrorMessage(
            `Spark Cell Runner failed to start: ${message}`
        );
    }
}

// Execute the selected cells of an open notebook document (notebook editor view).
async function executeNotebookCells(cells, notebook, output) {
    const orderedCells = [...cells].sort((left, right) => left.index - right.index);
    const notebookKey = session.getNotebookSessionKey(notebook);
    const parsedNotebook = parseNotebookFromNotebookDocument(notebook);
    const configuration = getConfiguration();
    const notebookPath =
        parsedNotebook.notebookPath || notebook.uri.fsPath || notebook.uri.path;
    const pythonCommand = poolManager.resolveSessionPythonCommand(
        await pythonEnv.resolvePythonCommand({ uri: notebook.uri }),
        configuration
    );
    const bootstrapCode = await pyResources.buildBootstrapCode();
    const runtimeDataCode = await pyResources.buildRuntimeDataCode();
    const runHistory = session.getOrCreateNotebookRunHistory(notebookKey);
    const sharedState = { includeCache: state.globalIncludeCache };

    if (
        configuration.injectDatabricksBootstrap &&
        configuration.connectionMode !== 'local' &&
        !configuration.useServerless &&
        !configuration.clusterId.trim()
    ) {
        appendSkippedNotebookOutputs(
            notebook,
            orderedCells,
            0,
            'Cluster ID required unless serverless mode is enabled.'
        );
        return;
    }

    if (configuration.injectDatabricksBootstrap && configuration.connectionMode === 'local') {
        const pool = poolManager.getPool(configuration.localPool);
        const serving = pool ? await poolManager.isPoolServing(pool) : false;

        if (!serving) {
            appendSkippedNotebookOutputs(
                notebook,
                orderedCells,
                0,
                pool
                    ? `Local Spark pool "${pool.name}" is not running. Start it from the Spark Cell Runner sidebar.`
                    : 'No local Spark pool is selected. Create one from the Spark Cell Runner sidebar.'
            );
            return;
        }
    }

    let currentSession = await session.getOrCreateNotebookSession(
        notebook,
        pythonCommand,
        output
    );

    output.appendLine(
        `[session] ${currentSession.key} seq=${currentSession.sequence} initialized=${currentSession.initialized}`
    );

    if (!currentSession.initialized || currentSession.bootstrapCode !== bootstrapCode) {
        const previousExecutedCells = new Set(currentSession.executedCells);

        session.disposeNotebookSession(notebook.uri, { preserveRunHistory: true });

        currentSession = await session.getOrCreateNotebookSession(
            notebook,
            pythonCommand,
            output
        );

        currentSession.executedCells = previousExecutedCells;

        const initResult = await session.executeInNotebookSession(
            currentSession,
            bootstrapCode
        );

        if (!initResult.ok) {
            appendSkippedNotebookOutputs(
                notebook,
                orderedCells,
                0,
                initResult.stderr || 'Notebook session bootstrap failed.'
            );
            return;
        }

        const bootstrapError = configuration.injectDatabricksBootstrap
            ? session.extractBootstrapConnectError(initResult)
            : undefined;

        if (bootstrapError) {
            session.disposeNotebookSession(notebook.uri, {
                preserveRunHistory: true
            });

            appendSkippedNotebookOutputs(
                notebook,
                orderedCells,
                0,
                bootstrapError.kind === 'local-pool'
                    ? `Local Spark pool bootstrap failed: ${bootstrapError.detail}. Use the sidebar "Install Sail packages" action if the pool environment is missing pyspark.`
                    : `Databricks Connect is not available in ${pythonCommand}: ${bootstrapError.detail}`
            );
            return;
        }

        currentSession.initialized = true;
        currentSession.bootstrapCode = bootstrapCode;

        await session.executeInNotebookSession(currentSession, runtimeDataCode);
        currentSession.runtimeDataCode = runtimeDataCode;

        output.appendLine(`[session] initialized ${currentSession.key}`);
    } else if (currentSession.runtimeDataCode !== runtimeDataCode) {
        await session.executeInNotebookSession(currentSession, runtimeDataCode);
        currentSession.runtimeDataCode = runtimeDataCode;
    }

    for (const cell of orderedCells) {
        // RECONSTRUCTED: the original snapshot read `cell.execution`, which is not
        // part of the VS Code API; executions must come from the controller.
        const notebookController = getNotebookController(notebook);
        const execution = notebookController
            ? notebookController.createNotebookCellExecution(cell)
            : undefined;

        if (execution) {
            execution.start(Date.now());
            execution.executionOrder = cell.index + 1;
        }

        try {
            const built = await scriptBuilder.buildScriptForParsedNotebook(
                notebookPath,
                parsedNotebook.cells,
                output,
                cell.index,
                sharedState,
                {
                    includePriorContext: false,
                    injectBootstrap: false,
                }
            );

            if (!built) {
                if (execution) {
                    execution.end(false, Date.now());
                }
                continue;
            }

            const result = await session.executeInNotebookSession(
                currentSession,
                built.script
            );

            const notebookStdout = session.filterNotebookStdout(result.stdout || '');
            const outputItems = [];

            if (notebookStdout) {
                outputItems.push(
                    vscode.NotebookCellOutputItem.text(
                        notebookStdout,
                        'text/plain'
                    )
                );
            }

            if (result.stderr) {
                outputItems.push(
                    vscode.NotebookCellOutputItem.stderr(result.stderr)
                );
            }

            if (outputItems.length === 0) {
                outputItems.push(
                    vscode.NotebookCellOutputItem.text(
                        '(no output)',
                        'text/plain'
                    )
                );
            }

            if (execution) {
                execution.replaceOutput([
                    new vscode.NotebookCellOutput(outputItems)
                ]);
            }

            const success = result.exitCode === 0;

            if (execution) {
                execution.end(success, Date.now());
            }

            if (!success) {
                appendSkippedNotebookOutputs(
                    notebook,
                    orderedCells,
                    cell.index + 1,
                    'Skipped because an earlier cell failed.'
                );
                break;
            }

            for (const executedCellIndex of built.executedCellIndices) {
                currentSession.executedCells.add(executedCellIndex);
                runHistory.executedCells.add(executedCellIndex);
            }
        } catch (error) {
            if (execution) {
                execution.replaceOutput([
                    new vscode.NotebookCellOutput([
                        vscode.NotebookCellOutputItem.error(
                            error instanceof Error
                                ? error
                                : new Error(String(error))
                        )
                    ])
                ]);

                execution.end(false, Date.now());
            }

            appendSkippedNotebookOutputs(
                notebook,
                orderedCells,
                cell.index + 1,
                'Skipped because an earlier cell failed.'
            );

            break;
        }
    }
}

function appendSkippedNotebookOutputs(notebook, cells, startIndex, message) {
    const notebookController = getNotebookController(notebook);

    if (!notebookController) {
        return;
    }

    for (const skippedCell of cells.slice(startIndex)) {
        const execution =
            notebookController.createNotebookCellExecution(skippedCell);

        execution.start(Date.now());
        execution.executionOrder = skippedCell.index + 1;

        execution.replaceOutput([
            new vscode.NotebookCellOutput([
                vscode.NotebookCellOutputItem.text(message, 'text/plain'),
            ]),
        ]);

        execution.end(false, Date.now());
    }
}

function createDatabricksNotebookController(notebookType, label, output) {
    const controller = vscode.notebooks.createNotebookController(
        `sparkCellRunner.controller.${notebookType}`,
        notebookType,
        label,
        async (cells, notebook) => {
            await executeNotebookCells(cells, notebook, output);
        },
    );

    controller.supportedLanguages = ['python'];
    controller.supportsExecutionOrder = true;

    controller.interruptHandler = async (notebook) => {
        const key = session.getNotebookSessionKey(notebook);
        const currentSession = state.notebookSessions.get(key);

        if (!currentSession) {
            return;
        }

        output.appendLine(
            `[interrupt] Stopping notebook session for ${notebook.uri.fsPath || notebook.uri.path}`
        );

        session.disposeNotebookSession(notebook.uri);
    };

    return controller;
}

function getNotebookController(notebook) {
    return notebookControllers.get(notebook.notebookType) ||
        notebookControllers.get(NOTEBOOK_TYPE);
}

function registerNotebookControllers(context, output) {
    // Own notebook type: drives .py notebook-source files.
    const sparkController = createDatabricksNotebookController(NOTEBOOK_TYPE, 'Spark Connect Runner', output);
    notebookControllers.set(sparkController.notebookType, sparkController);
    context.subscriptions.push(sparkController);

    // jupyter-notebook type: makes "Spark Connect Runner" available as a kernel
    // OPTION for .ipynb files alongside the Jupyter extension's environments.
    // It is not forced as the default — pick it from the kernel picker when you
    // want a cell to run through the local Databricks session; VS Code remembers
    // the choice per notebook.
    const jupyterController = createDatabricksNotebookController(JUPYTER_NOTEBOOK_TYPE, 'Spark Connect Runner', output);
    notebookControllers.set(jupyterController.notebookType, jupyterController);
    context.subscriptions.push(jupyterController);
}

function getTargetFolder(document, configuredFolder) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);

    if (workspaceFolder) {
        return path.join(workspaceFolder.uri.fsPath, configuredFolder);
    }

    return path.join(path.dirname(document.uri.fsPath), configuredFolder);
}

module.exports = {
    runNotebookCells,
    executeNotebookCells,
    createDatabricksNotebookController,
    registerNotebookControllers,
    getNotebookController,
    getTargetFolder,
};
