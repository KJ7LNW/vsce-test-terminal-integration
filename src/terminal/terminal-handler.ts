import * as vscode from 'vscode';
import { inspect } from 'util';

export interface TerminalStats {
    pattern1Count: number;
    pattern2Count: number;
    pattern3Count: number;
    noMatchCount: number;
    runCount: number;
    lastMatch: string;
    lastMatchSource: string;
    lastMatchPattern: number;
}

export class TerminalHandler {
    private stats: TerminalStats = {
        pattern1Count: 0,
        pattern2Count: 0,
        pattern3Count: 0,
        noMatchCount: 0,
        runCount: 0,
        lastMatch: '',
        lastMatchSource: '',
        lastMatchPattern: 0
    };

    constructor(private readonly onOutput: (text: string) => void,
                private readonly onDebug: (text: string) => void) {}

    public resetStats(): void {
        this.stats = {
            pattern1Count: 0,
            pattern2Count: 0,
            pattern3Count: 0,
            noMatchCount: 0,
            runCount: 0,
            lastMatch: '',
            lastMatchSource: '',
            lastMatchPattern: 0
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

    public async executeCommand(command: string): Promise<void> {
        const terminal = vscode.window.createTerminal('Command Runner');
        terminal.show();

        const startDisposable = (vscode.window as any).onDidStartTerminalShellExecution?.(async (e: any) => {
            if (e.terminal === terminal) {
                try {
                    const stream = e.execution.read();
                    let outputBuffer = '';
                    let lastMatch = null;
                    let lastMatchSource = '';
                    let lastMatchPattern = 0;

                    for await (const data of stream) {
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
                            switch (matchSource) {
                                case 1: this.stats.pattern1Count++; break;
                                case 2: this.stats.pattern2Count++; break;
                                case 3: this.stats.pattern3Count++; break;
                            }
                            this.stats.lastMatch = match;
                            this.stats.lastMatchSource = data;
                            this.stats.lastMatchPattern = matchSource;
                        } else {
                            this.stats.noMatchCount++;
                        }
                    }

                    // Write final output and stats in one shot
                    this.onOutput(outputBuffer);

                    const countSummary = 
                        'Pattern Match Statistics:\n' +
                        `    Pattern 1 (VTE):        ${this.stats.pattern1Count}\n` +
                        `    Pattern 2 (VSCE):       ${this.stats.pattern2Count}\n` +
                        `    Pattern 3 (Fallback):   ${this.stats.pattern3Count}\n` +
                        `    No matches:             ${this.stats.noMatchCount}\n` +
                        `(Run ${this.stats.runCount})\n` +
                        '\n' +
                        '\n' +
                        (lastMatch ? 
                            `Last match (Pattern ${lastMatchPattern}):\n` +
                            `  Match: \n  ${inspect(lastMatch)}\n\n` +
                            `  From:  \n  ${inspect(lastMatchSource)}\n` : '');

                    this.onDebug(countSummary);

                    // Schedule next run if we haven't reached max runs
                    if (this.stats.runCount < 100) {
                        setTimeout(() => {
                            this.stats.runCount++;
                            terminal.sendText(command);
                        }, 100);
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

        try {
            await this.waitForShellIntegration(terminal);
            const shellIntegration = (terminal as any).shellIntegration;
            if (shellIntegration?.executeCommand) {
                shellIntegration.executeCommand(command);
            } else {
                terminal.sendText(command);
            }
        } catch (err) {
            terminal.sendText(command);
        }
    }
}
