import * as vscode from 'vscode';

class TerminalCommandRunner implements vscode.WebviewViewProvider {
    public static readonly viewType = 'terminalCommands';
    private _view?: vscode.WebviewView;
    private runCount: number = 0;
    private foundPattern1: boolean = false;
    private foundPattern2: boolean = false;

    constructor(private readonly _extensionUri: vscode.Uri) {}

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getWebviewContent();

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(async message => {
            switch (message.command) {
                case 'runCommand':
                    this.runCount = 1;
                    this.foundPattern1 = false;
                    this.foundPattern2 = false;
                    const terminal = vscode.window.createTerminal('Command Runner');
                    terminal.show();
                    
                    // Set up shell execution handlers
                    const startDisposable = (vscode.window as any).onDidStartTerminalShellExecution?.(async (e: any) => {
                        if (e.terminal === terminal) {
                            try {
                                const stream = e.execution.read();
                                for await (const data of stream) {
                                    // Check for shell integration patterns
                                    let match1 = data.match(/\x1b\]633;C\x07(.*?)\x1b\]633;D(?:;(\d+))?/s)?.[1];
                                    let match2 = data.match(/.*\x1b\]633;C\x07(.*)$/s)?.[1];

                                    const debugInfo = `[Run ${this.runCount}] Pattern matching results:
  Pattern 1 (C..D): ${match1 !== undefined ? `matched: "${match1}"` : "no match"}
  Pattern 2 (fallback): ${match2 !== undefined ? `matched: "${match2}"` : "no match"}
  Raw data: ${JSON.stringify(data)}
`;

                                    if (this._view) {
                                        this._view.webview.postMessage({
                                            type: 'output',
                                            text: data
                                        });
                                        this._view.webview.postMessage({
                                            type: 'debug',
                                            text: debugInfo
                                        });

                                        // Check if we found both patterns
                                        if (this.runCount < 100 && (!this.foundPattern1 || !this.foundPattern2)) {
                                            if (match1) this.foundPattern1 = true;
                                            if (match2) this.foundPattern2 = true;
                                            
                                            // Schedule next run if needed
                                            if (!this.foundPattern1 || !this.foundPattern2) {
                                                setTimeout(() => {
                                                    this.runCount++;
                                                    terminal.sendText(message.text);
                                                }, 100);
                                            }
                                        }
                                    }
                                }
                            } catch (err) {
                                console.error('Error reading stream:', err);
                            }
                        }
                    });

                    const endDisposable = (vscode.window as any).onDidEndTerminalShellExecution?.(async (e: any) => {
                        if (e.terminal === terminal) {
                            startDisposable?.dispose();
                            endDisposable?.dispose();
                        }
                    });

                    // Try shell integration first
                    try {
                        await this.waitForShellIntegration(terminal);
                        const shellIntegration = (terminal as any).shellIntegration;
                        if (shellIntegration?.executeCommand) {
                            shellIntegration.executeCommand(message.text);
                        } else {
                            // Fallback to sendText if shell integration is not available
                            terminal.sendText(message.text);
                        }
                    } catch (err) {
                        // Fallback to sendText if shell integration fails
                        terminal.sendText(message.text);
                    }
                    break;
            }
        });
    }

    private async waitForShellIntegration(terminal: vscode.Terminal): Promise<void> {
        return new Promise((resolve, reject) => {
            const timeout = 4000;
            const startTime = Date.now();
            
            const checkIntegration = () => {
                const hasShellIntegration = (terminal as any).shellIntegration !== undefined;
                const hasExecuteCommand = (terminal as any).shellIntegration?.executeCommand !== undefined;
                
                console.log('Shell integration check:', {
                    hasShellIntegration,
                    hasExecuteCommand,
                    cwd: (terminal as any).shellIntegration?.cwd?.toString()
                });

                if (hasShellIntegration && hasExecuteCommand) {
                    resolve();
                    return;
                }

                if (Date.now() - startTime > timeout) {
                    reject(new Error('Shell integration timeout'));
                    return;
                }

                setTimeout(checkIntegration, 100);
            };

            checkIntegration();
        });
    }

    private _getWebviewContent() {
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Terminal Command Runner</title>
            <style>
                body {
                    padding: 20px;
                    color: var(--vscode-foreground);
                    background-color: var(--vscode-editor-background);
                }
                .output-container {
                    display: flex;
                    flex-direction: column;
                    gap: 10px;
                }
                .output-label {
                    font-weight: bold;
                    margin-top: 10px;
                }
                #command-input {
                    width: 100%;
                    padding: 8px;
                    margin-bottom: 10px;
                    background-color: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border: 1px solid var(--vscode-input-border);
                }
                #run-button {
                    padding: 8px 16px;
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    cursor: pointer;
                }
                #output, #debug-output {
                    margin-top: 20px;
                    padding: 10px;
                    background-color: var(--vscode-terminal-background);
                    color: var(--vscode-terminal-foreground);
                    font-family: monospace;
                    white-space: pre-wrap;
                    min-height: 200px;
                    max-height: 400px;
                    overflow-y: auto;
                }
            </style>
        </head>
        <body>
            <input type="text" id="command-input" placeholder="Enter command...">
            <button id="run-button">Run Command</button>
            <div class="output-container">
                <div class="output-label">Command Output:</div>
                <div id="output"></div>
                <div class="output-label">Pattern Matching Results:</div>
                <div id="debug-output"></div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();
                const commandInput = document.getElementById('command-input');
                const runButton = document.getElementById('run-button');
                const output = document.getElementById('output');
                const debugOutput = document.getElementById('debug-output');

                // Set default command
                commandInput.value = 'echo a';
                
                runButton.addEventListener('click', () => {
                    const command = commandInput.value.trim() || 'echo a';
                    output.textContent = ''; // Clear previous output
                    debugOutput.textContent = ''; // Clear previous debug output
                    vscode.postMessage({
                        command: 'runCommand',
                        text: command
                    });
                });

                // Handle messages from the extension
                window.addEventListener('message', event => {
                    const message = event.data;
                    switch (message.type) {
                        case 'output':
                            output.textContent += message.text;
                            output.scrollTop = output.scrollHeight;
                            break;
                        case 'debug':
                            debugOutput.textContent += message.text + '\\n';
                            debugOutput.scrollTop = debugOutput.scrollHeight;
                            break;
                    }
                });

                // Handle Enter key in input
                commandInput.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') {
                        runButton.click();
                    }
                });
            </script>
        </body>
        </html>`;
    }
}

export function activate(context: vscode.ExtensionContext) {
    const provider = new TerminalCommandRunner(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(TerminalCommandRunner.viewType, provider)
    );
}

export function deactivate() {}
