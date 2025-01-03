import * as vscode from 'vscode';
import { inspect } from 'util';

export interface TerminalStats {
    pattern2OnlyCount: number;
    neitherCount: number;
    bothCount: number;
    runCount: number;
    lastBothMatch: string;
    lastBothSource: string;
    lastPattern2OnlyMatch: string;
    lastPattern2OnlySource: string;
}

export class TerminalHandler {
    private stats: TerminalStats = {
        pattern2OnlyCount: 0,
        neitherCount: 0,
        bothCount: 0,
        runCount: 0,
        lastBothMatch: '',
        lastBothSource: '',
        lastPattern2OnlyMatch: '',
        lastPattern2OnlySource: ''
    };

    constructor(private readonly onOutput: (text: string) => void,
                private readonly onDebug: (text: string) => void) {}

    public resetStats(): void {
        this.stats = {
            pattern2OnlyCount: 0,
            neitherCount: 0,
            bothCount: 0,
            runCount: 0,
            lastBothMatch: '',
            lastBothSource: '',
            lastPattern2OnlyMatch: '',
            lastPattern2OnlySource: ''
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
                    for await (const data of stream) {
                        let match1 = data.match(/\x1b\]633;C\x07(.*?)\x1b\]633;D(?:;(\d+))?/s)?.[1];
                        let match2 = data.match(/.*\x1b\]633;C\x07(.*)$/s)?.[1];

                        this.onOutput(inspect(data));

                        // Update pattern match counts and store matches with source
                        if (!match1 && match2) {
                            this.stats.neitherCount++;  // "not found" means only pattern2 matched
                            this.stats.lastPattern2OnlyMatch = match2;
                            this.stats.lastPattern2OnlySource = data;
                        } else if (!match1 && !match2) {
                            this.stats.pattern2OnlyCount++;  // no matches
                        } else if (match1 && match2) {
                            this.stats.bothCount++;
                            this.stats.lastBothMatch = match1;
                            this.stats.lastBothSource = data;
                        }

                        const countSummary = 
                            'OSC ] 633;D\n' +
                            `    found:     ${this.stats.bothCount}\n` +
                            `    not found: ${this.stats.neitherCount}\n` +
                            `    neither:   ${this.stats.pattern2OnlyCount}\n` +
                            `(Run ${this.stats.runCount})\n` +
                            '\n' +
                            '\n' +
                            (this.stats.lastBothMatch ? 
                                `Last 633;D found match:\n` +
                                `  Match: \n  ${inspect(this.stats.lastBothMatch)}\n\n` +
                                `  From:  \n  ${inspect(this.stats.lastBothSource)}\n\n` : '') +
                            (this.stats.lastPattern2OnlyMatch ? 
                                `Last 633;D not found match:\n` +
                                `  Match: \n  ${inspect(this.stats.lastPattern2OnlyMatch)}\n\n` +
                                `  From:  \n  ${inspect(this.stats.lastPattern2OnlySource)}` : '');

                        this.onDebug(countSummary);

                        // Schedule next run if we haven't reached max runs
                        if (this.stats.runCount < 100) {
                            setTimeout(() => {
                                this.stats.runCount++;
                                terminal.sendText(command);
                            }, 100);
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
