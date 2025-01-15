import * as vscode from 'vscode';
import { inspect } from 'util';

export interface TerminalStats {
    patternCounts: number[];
    runCount: number;
    lastMatches: string[];
    lastMatchSources: string[];
    noMatchExamples: string[];  // Store all no-match examples
    total633DCount: number;  // Count of all \x1b\]633;D occurrences
    shellIntegrationWarnings: number;  // Count of shell integration unavailable warnings
}

export interface CommandOptions {
    autoCloseTerminal: boolean;
    useShellIntegration: boolean;
}

export class TerminalHandler {
    private stats: TerminalStats = {
        patternCounts: [0, 0, 0, 0],  // VTE, VSCE, Fallback, No Match
        runCount: 0,
        lastMatches: ['', '', ''],  // Only 3 patterns need last matches
        lastMatchSources: ['', '', ''],  // Only 3 patterns need sources
        noMatchExamples: [],  // Array to collect all no-match examples
        total633DCount: 0,
        shellIntegrationWarnings: 0
    };

    private terminal: vscode.Terminal | null = null;
    private isExecuting = false;

    constructor(private readonly onOutput: (text: string) => void,
                private readonly onDebug: (text: string) => void) {}

    public resetStats(): void {
        this.stats = {
            patternCounts: [0, 0, 0, 0],
            runCount: 0,
            lastMatches: ['', '', ''],
            lastMatchSources: ['', '', ''],
            noMatchExamples: [],
            total633DCount: 0,
            shellIntegrationWarnings: 0
        };
    }

    private async waitForShellIntegration(terminal: vscode.Terminal): Promise<void> {
        return new Promise((resolve, reject) => {
            const timeout = 4000;
            const startTime = Date.now();
            
            const checkIntegration = () => {
                const hasShellIntegration = (terminal as any).shellIntegration !== undefined;
                const hasExecuteCommand = (terminal as any).shellIntegration?.executeCommand !== undefined;
                
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

    public async executeCommand(command: string, options: CommandOptions): Promise<void> {
        // Prevent concurrent executions
        if (this.isExecuting) {
            this.onOutput('Command execution in progress, please wait...');
            return;
        }
        this.isExecuting = true;

        // Create terminal if it doesn't exist
        if (!this.terminal) {
            this.terminal = vscode.window.createTerminal('Command Runner');
        }
        this.terminal.show();

        const startDisposable = (vscode.window as any).onDidStartTerminalShellExecution?.(async (e: any) => {
            if (e.terminal === this.terminal) {
                try {
                    const stream = e.execution.read();
                    let outputBuffer = '';
                    let lastMatch = null;
                    let lastMatchSource = '';
                    let lastMatchPattern = 0;

                    for await (const data of stream) {
                        // Count total occurrences of \x1b\]633;D
                        const dMatches = data.match(/\x1b\]633;D/gs);
                        if (dMatches) {
                            this.stats.total633DCount += dMatches.length;
                        }

                        // Try patterns in sequence and short circuit on first match
                        let match = null;
                        let matchSource = 0;

                        // Pattern 1: Command completed notification (VTE)
                        match = data.match(/\x1b\]633;C\x07(.*?)\x1b\]777;notify;Command completed/s)?.[1];
                        if (match) {
                            matchSource = 1;
                        }
                        
                        // Pattern 2: Basic command completion (VSCE)
                        if (!match) {
                            match = data.match(/\x1b\]633;C\x07(.*?)\x1b\]633;D/s)?.[1];
                            if (match) {
                                matchSource = 2;
                            }
                        }
                        
                        // Pattern 3: Fallback pattern
                        if (!match) {
                            match = data.match(/\x1b\]633;C\x07(.*)$/s)?.[1];
                            if (match) {
                                matchSource = 3;
                            }
                        }

                        // Buffer the output
                        if (match) {
                            lastMatch = match;
                            lastMatchSource = data;
                            lastMatchPattern = matchSource;
                            outputBuffer = `Match found (Pattern ${matchSource}):\n${inspect(match)}\n\nFrom:\n${inspect(data)}`;
                        } else {
                            outputBuffer = `No match found in:\n${inspect(data)}`;
                        }

                        // Update stats
                        if (match) {
                            this.stats.patternCounts[matchSource - 1]++;
                            this.stats.lastMatches[matchSource - 1] = match;
                            this.stats.lastMatchSources[matchSource - 1] = data;
                        } else {
                            this.stats.patternCounts[3]++;
                            this.stats.noMatchExamples.push(data);
                        }
                    }

                    // Write final output and stats in one shot
                    this.onOutput(outputBuffer);

                    const countSummary = 
                        'Pattern Match Statistics:\n' +
                        `    Pattern 1 (VTE):        ${this.stats.patternCounts[0]}\n` +
                        `    Pattern 2 (VSCE):       ${this.stats.patternCounts[1]}\n` +
                        `    Pattern 3 (Fallback):   ${this.stats.patternCounts[2]}\n` +
                        `    No matches:             ${this.stats.patternCounts[3]}\n` +
                        `    Total 633;D count:      ${this.stats.total633DCount}\n` +
                        `    shIntegration warnings: ${this.stats.shellIntegrationWarnings}\n` +
                        `(Run ${this.stats.runCount})\n` +
                        '\n' +
                        'Example matches:\n' +
                        (this.stats.lastMatches[0] ? 
                            `Pattern 1 (VTE):\n` +
                            `  Match: \n  ${inspect(this.stats.lastMatches[0])}\n` +
                            `  From:  \n  ${inspect(this.stats.lastMatchSources[0])}\n\n` : '') +
                        (this.stats.lastMatches[1] ? 
                            `Pattern 2 (VSCE):\n` +
                            `  Match: \n  ${inspect(this.stats.lastMatches[1])}\n` +
                            `  From:  \n  ${inspect(this.stats.lastMatchSources[1])}\n\n` : '') +
                        (this.stats.lastMatches[2] ? 
                            `Pattern 3 (Fallback):\n` +
                            `  Match: \n  ${inspect(this.stats.lastMatches[2])}\n` +
                            `  From:  \n  ${inspect(this.stats.lastMatchSources[2])}\n\n` : '') +
                        (this.stats.noMatchExamples.length > 0 ? 
                            `No match examples:\n` +
                            this.stats.noMatchExamples.map((example, i) => 
                                `  ${i + 1}. ${inspect(example)}`
                            ).join('\n') + '\n' : '');

                    this.onDebug(countSummary);

                    // Schedule next run if we haven't reached max runs
                    if (this.stats.runCount < 100) {
                        setTimeout(() => {
                            this.stats.runCount++;
                            this.terminal?.sendText(command);
                        }, 100);
                    } else if (options.autoCloseTerminal) {
                        this.terminal?.dispose();
                        this.terminal = null;
                    }
                } catch (err) {
                    console.error('Error reading stream:', err);
                }
            }
        });

        const endDisposable = (vscode.window as any).onDidEndTerminalShellExecution?.(async (e: any) => {
            if (e.terminal === this.terminal) {
                startDisposable?.dispose();
                endDisposable?.dispose();
                this.isExecuting = false;
                if (options.autoCloseTerminal) {
                    this.terminal?.dispose();
                    this.terminal = null;
                }
            }
        });

        try {
            await this.waitForShellIntegration(this.terminal!);
            const shellIntegration = (this.terminal as any).shellIntegration;
            if (options.useShellIntegration) {
                if (!shellIntegration?.executeCommand) {
                    this.onOutput('Warning: Shell integration not available, falling back to sendText\n\n');
                    this.stats.shellIntegrationWarnings++;
                    this.terminal?.sendText(command);
                } else {
                    shellIntegration.executeCommand(command);
                }
            } else {
                this.terminal?.sendText(command);
            }
        } catch (err) {
            this.terminal?.sendText(command);
        }
    }
}
