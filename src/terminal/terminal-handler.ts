import * as vscode from 'vscode';
import { inspect } from 'util';

const BENCHMARK_ITERATIONS = 1000;

export interface TerminalStats {
    patternCounts: number[];
    lastMatches: string[];
    lastMatchSources: string[];
    noMatchExamples: string[];  // Store all no-match examples
    total633DCount: number;  // Count of all \x1b\]633;D occurrences
    shellIntegrationWarnings: number;  // Count of shell integration unavailable warnings
    regexTimes: number[];  // Array of regex match execution times in ms
    indexTimes: number[];  // Array of string index match execution times in ms
    avgRegexTime: number;  // Average regex match time in ms
    avgIndexTime: number;  // Average string index match time in ms
    matchMismatches: string[];  // Store any mismatches between regex and string index matches
}

export interface CommandOptions {
    autoCloseTerminal: boolean;
    useShellIntegration: boolean;
    promptCommand?: string;
}

export class TerminalHandler {
    private stats: TerminalStats = {
        patternCounts: [0, 0, 0, 0],  // VTE, VSCE, Fallback, No Match
        lastMatches: ['', '', ''],  // Only 3 patterns need last matches
        lastMatchSources: ['', '', ''],  // Only 3 patterns need sources
        noMatchExamples: [],  // Array to collect all no-match examples
        total633DCount: 0,
        shellIntegrationWarnings: 0,
        regexTimes: [],
        indexTimes: [],
        avgRegexTime: 0,
        avgIndexTime: 0,
        matchMismatches: []
    };

    private terminal: vscode.Terminal | null = null;
    private isExecuting = false;
    private lastPromptCommand: string = 'sleep 0.1';
    
    constructor(private readonly onOutput: (text: string) => void,
                private readonly onDebug: (text: string) => void) {}

    public closeTerminal(): void {
        if (this.terminal) {
            this.terminal.dispose();
            this.terminal = null;
        }
    }

    public resetStats(): void {
        this.stats = {
            patternCounts: [0, 0, 0, 0],
            lastMatches: ['', '', ''],
            lastMatchSources: ['', '', ''],
            noMatchExamples: [],
            total633DCount: 0,
            shellIntegrationWarnings: 0,
            regexTimes: [],
            indexTimes: [],
            avgRegexTime: 0,
            avgIndexTime: 0,
            matchMismatches: []
        };
    }

    private benchmarkRegex(data: string, pattern: RegExp): { match: RegExpExecArray | null; time: number } {
        const start = performance.now();
        let match: RegExpExecArray | null = null;
        
        // Run multiple iterations for more accurate timing
        for (let i = 0; i < BENCHMARK_ITERATIONS; i++) {
            match = pattern.exec(data);
        }
        
        // Convert to microseconds (ms * 1000)
        const time = ((performance.now() - start) / BENCHMARK_ITERATIONS) * 1000;
        return { match, time };
    }

    private benchmarkStringIndex(data: string, prefix: string, suffix: string | null): { match: string | null; time: number } {
        const start = performance.now();
        let match: string | null = null;
        
        // Run multiple iterations for more accurate timing
        for (let i = 0; i < BENCHMARK_ITERATIONS; i++) {
            const startIndex = data.indexOf(prefix);
            if (startIndex === -1) {
                continue;
            }
            
            const contentStart = startIndex + prefix.length;
            
            if (suffix === null) {
                // When suffix is null, just take everything after the prefix
                match = data.slice(contentStart);
            } else {
                const endIndex = data.indexOf(suffix, contentStart);
                if (endIndex === -1) {
                    continue;
                }
                match = data.slice(contentStart, endIndex);
            }
        }
        
        // Convert to microseconds (ms * 1000)
        const time = ((performance.now() - start) / BENCHMARK_ITERATIONS) * 1000;
        return { match, time };
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

        const promptCommand = (options.promptCommand || 'sleep 0.1').trim();

        // Handle prompt command changes first
        if (this.terminal && promptCommand !== this.lastPromptCommand) {
            this.terminal.dispose();
            this.terminal = null;
        }

        // Create new terminal if needed
        if (!this.terminal) {
            const env: { [key: string]: string } = {};
            if (promptCommand.trim()) {
                env.PROMPT_COMMAND = promptCommand;
            }
            this.terminal = vscode.window.createTerminal({
                name: 'Command Runner',
                env
            });
            this.lastPromptCommand = promptCommand;
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

                    let output = '';
                    for await (const data of stream) {
                        output += data;
                    }

                    // Count total occurrences of \x1b\]633;D in complete output
                    const dMatches = output.match(/\x1b\]633;D/gs);
                    if (dMatches) {
                        this.stats.total633DCount += dMatches.length;
                    }

                    // Try patterns in sequence and short circuit on first match
                    let match = null;
                    let matchSource = 0;
                    let regexResult2: { match: RegExpExecArray | null; time: number } = { match: null, time: 0 };
                    let indexResult2: { match: string | null; time: number } = { match: null, time: 0 };

                    // Pattern 1: Command completed notification (VTE)
                    const pattern1 = /\x1b\]633;C\x07(.*?)\x1b\]777;notify;Command completed/s;
                    
                    // Benchmark both approaches for Pattern 1
                    const regexResult1 = this.benchmarkRegex(output, pattern1);
                    const indexResult1 = this.benchmarkStringIndex(
                        output,
                        '\x1b]633;C\x07',
                        '\x1b]777;notify;Command completed'
                    );
                    
                    // Validate matches are identical
                    const regexMatch1 = regexResult1.match?.[1];
                    const indexMatch1 = indexResult1.match;
                    if (regexMatch1 !== null && indexMatch1 !== null && regexMatch1 !== indexMatch1) {
                        this.stats.matchMismatches.push(
                            `Pattern 1 mismatch:\n` +
                            `  Regex: ${regexMatch1}\n` +
                            `  Index: ${indexMatch1}`
                        );
                    }
                    
                    this.stats.regexTimes.push(regexResult1.time);
                    this.stats.indexTimes.push(indexResult1.time);
                    
                    // Update averages
                    this.stats.avgRegexTime = this.stats.regexTimes.reduce((a, b) => a + b, 0) / this.stats.regexTimes.length;
                    this.stats.avgIndexTime = this.stats.indexTimes.reduce((a, b) => a + b, 0) / this.stats.indexTimes.length;

                    if (regexMatch1 !== null && regexMatch1 !== undefined) {
                        match = regexMatch1;
                        matchSource = 1;
                    }
                    
                    // Pattern 2: Basic command completion (VSCE)
                    if (match === null) {
                        const pattern2 = /\x1b\]633;C\x07(.*?)\x1b\]633;D/s;
                        
                        // Debug exact positions
                        const startPos = output.indexOf('\x1b]633;C\x07');
                        const endPos = output.indexOf('\x1b]633;D', startPos);
                        this.onDebug(`Pattern 2 sequence positions:
                            Start sequence at: ${startPos}
                            End sequence at: ${endPos}
                            Characters between: "${output.substring(startPos + 8, endPos)}"`);
                        
                        const regexResult2 = this.benchmarkRegex(output, pattern2);
                        const indexResult2 = this.benchmarkStringIndex(
                            output,
                            '\x1b]633;C\x07',
                            '\x1b]633;D'
                        );
                        
                        // Debug match attempts
                        this.onDebug(`Pattern 2 match attempts:
                            Regex result: ${inspect(regexResult2.match)}
                            Index result: ${inspect(indexResult2.match)}
                            Full pattern: ${inspect(pattern2)}
                            Full output: ${inspect(output)}`);
                        
                        // Extract and validate matches
                        const regexMatch2 = regexResult2.match?.[1];
                        const indexMatch2 = indexResult2.match;
                        
                        if (regexMatch2 !== null && regexMatch2 !== undefined) {
                            if (indexMatch2 !== null && regexMatch2 !== indexMatch2) {
                                this.stats.matchMismatches.push(
                                    `Pattern 2 mismatch:\n` +
                                    `  Regex: ${regexMatch2}\n` +
                                    `  Index: ${indexMatch2}`
                                );
                            }
                            
                            this.stats.regexTimes.push(regexResult2.time);
                            this.stats.indexTimes.push(regexResult2.time);
                            
                            match = regexMatch2;
                            matchSource = 2;
                        }
                    }
                    
                    // Pattern 3: Fallback pattern
                    if (match === null) {
                        const pattern3 = /\x1b\]633;C\x07(.*)$/s;
                        
                        const regexResult3 = this.benchmarkRegex(output, pattern3);
                        const indexResult3 = this.benchmarkStringIndex(
                            output,
                            '\x1b]633;C\x07',
                            null // null means match to end
                        );
                        
                        // Extract and validate matches
                        const regexMatch3 = regexResult3.match?.[1];
                        const indexMatch3 = indexResult3.match;
                        
                        if (regexMatch3 !== null && regexMatch3 !== undefined) {
                            if (indexMatch3 !== null && regexMatch3 !== indexMatch3) {
                                this.stats.matchMismatches.push(
                                    `Pattern 3 mismatch:\n` +
                                    `  Regex: ${regexMatch3}\n` +
                                    `  Index: ${indexMatch3}`
                                );
                            }
                            
                            this.stats.regexTimes.push(regexResult3.time);
                            this.stats.indexTimes.push(regexResult3.time);
                            
                            match = regexMatch3;
                            matchSource = 3;
                        }
                    }

                    // Buffer the output with detailed matching info
                    if (match !== null) {
                        lastMatch = match;
                        lastMatchSource = output;
                        lastMatchPattern = matchSource;
                        outputBuffer = `Match found (Pattern ${matchSource}):\n${inspect(match)}\n\nFrom:\n${inspect(output)}\n\n` +
                            `Pattern 2 Details:\n` +
                            `Regex match: ${inspect(regexResult2?.match?.[1])}\n` +
                            `Index match: ${inspect(indexResult2?.match)}\n`;
                    } else {
                        outputBuffer = `No match found in:\n${inspect(output)}\n\n` +
                            `Pattern 2 Details:\n` +
                            `Regex match: ${inspect(regexResult2?.match?.[1])}\n` +
                            `Index match: ${inspect(indexResult2?.match)}\n`;
                    }

                    // Update stats
                    if (match !== null && typeof match === 'string') {
                        this.stats.patternCounts[matchSource - 1]++;
                        this.stats.lastMatches[matchSource - 1] = match;
                        this.stats.lastMatchSources[matchSource - 1] = output;
                    } else {
                        this.stats.patternCounts[3]++;
                        this.stats.noMatchExamples.push(output);
                    }

                    // Write final output and stats in one shot
                    this.onOutput(outputBuffer);

                    const countSummary = 
                        'Pattern Match Statistics:\n' +
                        (this.stats.matchMismatches.length > 0 ?
                            'Match Validation Issues:\n' +
                            this.stats.matchMismatches.map(msg => `  ${msg}`).join('\n') + '\n\n' : '') +
                        `    Pattern 1 (VTE):        ${this.stats.patternCounts[0]}\n` +
                        `    Pattern 2 (VSCE):       ${this.stats.patternCounts[1]}\n` +
                        `    Pattern 3 (Fallback):   ${this.stats.patternCounts[2]}\n` +
                        `    No matches:             ${this.stats.patternCounts[3]}\n` +
                        `    Total 633;D count:      ${this.stats.total633DCount}\n` +
                        `    shIntegration warnings: ${this.stats.shellIntegrationWarnings}\n` +
                        `    Avg Regex Time:         ${this.stats.avgRegexTime.toFixed(3)}µs\n` +
                        `    Avg String Index Time:  ${this.stats.avgIndexTime.toFixed(3)}µs\n` +
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

                    if (options.autoCloseTerminal) {
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
