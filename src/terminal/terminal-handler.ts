import * as vscode from 'vscode';
import { inspect } from 'util';

const BENCHMARK_ITERATIONS = 1000;

export interface TerminalStats {
    patternCounts: number[];
    lastMatches: (string | undefined)[];
    lastMatchSources: (string | undefined)[];
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
    enableVTEChecks?: boolean;
}

export class TerminalHandler {
    private tryPattern(
        output: string,
        patternNumber: number,
        pattern: RegExp,
        prefix: string,
        suffix?: string
    ): { match: string | undefined; matchSource: number } {
        const regexResult = this.benchmarkRegex(output, pattern);
        const indexResult = this.benchmarkStringIndex(output, prefix, suffix);
        
        // Debug output only for mismatches
        
        // Extract matches
        const regexMatch = regexResult.match?.[1];
        const indexMatch = indexResult.match;
        
        // Record mismatch if either matched but they disagree
        if (regexMatch !== undefined || indexMatch !== undefined) {
            if (regexMatch !== indexMatch) {
                this.stats.matchMismatches.push(
                    `Pattern ${patternNumber} mismatch:\n` +
                    `  Regex: ${regexMatch}\n` +
                    `  Index: ${indexMatch}`
                );
            }
        }

        // Return match only if both approaches agree
        if (regexMatch !== undefined && indexMatch !== undefined && regexMatch === indexMatch) {
            
            this.stats.regexTimes.push(regexResult.time);
            this.stats.indexTimes.push(indexResult.time);
            
            return { match: regexMatch, matchSource: patternNumber };
        }
        
        return { match: undefined, matchSource: 0 };
    }

    private stats: TerminalStats = {
        patternCounts: [0, 0, 0, 0],  // VTE, VSCE, Fallback, No Match
        lastMatches: Array(3),  // Only 3 patterns need last matches
        lastMatchSources: Array(3),  // Only 3 patterns need sources
        noMatchExamples: [],  // Array to collect all no-match examples
        total633DCount: 0,
        shellIntegrationWarnings: 0,
        regexTimes: [],
        indexTimes: [],
        avgRegexTime: 0,
        avgIndexTime: 0,
        matchMismatches: []
    };

    private terminal?: vscode.Terminal;
    private isExecuting = false;
    private lastPromptCommand: string = 'sleep 0.050';
    
    constructor(private readonly onOutput: (text: string) => void,
                private readonly onDebug: (text: string) => void) {}

    public closeTerminal(): void {
        if (this.terminal) {
            this.terminal.dispose();
            this.terminal = undefined;
        }
    }

    public resetStats(): void {
        this.stats = {
            patternCounts: [0, 0, 0, 0],
            lastMatches: Array(3),
            lastMatchSources: Array(3),
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

    private benchmarkRegex(data: string, pattern: RegExp): { match: RegExpExecArray | undefined; time: number } {
        const start = performance.now();
        let match: RegExpExecArray | null = null;
        
        // Run multiple iterations for more accurate timing
        for (let i = 0; i < BENCHMARK_ITERATIONS; i++) {
            match = pattern.exec(data);
        }
        
        // Convert to microseconds (ms * 1000)
        const time = ((performance.now() - start) / BENCHMARK_ITERATIONS) * 1000;
        
        return { 
            match: match === null ? undefined : match,
            time 
        };
    }

    private stringIndexMatch(data: string, prefix: string, suffix?: string): string | undefined {
        const startIndex = data.indexOf(prefix);
        if (startIndex === -1) {
            return undefined;
        }
        
        const contentStart = startIndex + prefix.length;
        
        if (suffix === undefined) {
            // When suffix is undefined, match to end
            return data.slice(contentStart);
        }
        
        const endIndex = data.indexOf(suffix, contentStart);
        if (endIndex === -1) {
            return undefined;
        }
        return data.slice(contentStart, endIndex);
    }

    private benchmarkStringIndex(data: string, prefix: string, suffix?: string): { match: string | undefined; time: number } {
        const start = performance.now();
        let match: string | undefined;
        
        // Run multiple iterations for more accurate timing
        for (let i = 0; i < BENCHMARK_ITERATIONS; i++) {
            match = this.stringIndexMatch(data, prefix, suffix);
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

        const promptCommand = (options.promptCommand || 'sleep 0.050').trim();

        // Handle prompt command changes first
        if (this.terminal && promptCommand !== this.lastPromptCommand) {
            this.terminal.dispose();
            this.terminal = undefined;
        }

        // Create new terminal if needed
        if (!this.terminal) {
            const env: { [key: string]: string } = {};
            if (promptCommand.trim()) {
                env.PROMPT_COMMAND = promptCommand;
            }
            if (!options.enableVTEChecks) {
                env.VTE_VERSION = "0";
            }
            this.terminal = vscode.window.createTerminal({
                name: 'Command Runner',
                env
            });
            this.lastPromptCommand = promptCommand;
        }
        this.terminal.show();

        const startDisposable = (vscode.window as any).onDidStartTerminalShellExecution?.(async (e: any) => {
            try {
                const stream = e.execution.read();
                
                if (e.terminal === this.terminal) {
                    let outputBuffer = '';
                    let lastMatch: string | undefined;
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
                    let match: string | undefined;
                    let matchSource = 0;

                    // Pattern 1: Command completed notification (VTE)
                    if (options.enableVTEChecks) {
                        const result1 = this.tryPattern(
                            output,
                            1,
                            // by regex
                            /\x1b\]633;C\x07(.*?)\x1b\]777;notify;Command completed/s,

                            // by index 
                            '\x1b]633;C\x07',
                            '\x1b]777;notify;Command completed'
                        );
                        match = result1.match;
                        matchSource = result1.matchSource;
                    }

                    // Pattern 2: Basic command completion (VSCE)
                    if (match === undefined) {
                        const result2 = this.tryPattern(
                            output,
                            2,
                            // by regex
                            /\x1b\]633;C\x07(.*?)\x1b\]633;D/s,

                            // by index
                            '\x1b]633;C\x07',
                            '\x1b]633;D'
                        );
                        match = result2.match;
                        matchSource = result2.matchSource;
                    }

                    // Pattern 3: Fallback pattern
                    if (match === undefined) {
                        const result3 = this.tryPattern(
                            output,
                            3,
                            // by regex
                            /\x1b\]633;C\x07(.*)$/s,

                            // by index, match to end (ie, undefined)
                            '\x1b]633;C\x07',
                            undefined
                        );
                        match = result3.match;
                        matchSource = result3.matchSource;
                    }

                    // Update averages after all patterns have been tried
                    this.stats.avgRegexTime = this.stats.regexTimes.reduce((a, b) => a + b, 0) / this.stats.regexTimes.length;
                    this.stats.avgIndexTime = this.stats.indexTimes.reduce((a, b) => a + b, 0) / this.stats.indexTimes.length;

                    // Buffer the output with match info
                    outputBuffer = match !== undefined ?
                        `Match found (Pattern ${matchSource}):\n${inspect(match)}\n\nFrom:\n${inspect(output)}` :
                        `No match found in:\n${inspect(output)}`;

                    // Update stats
                    if (match !== undefined && typeof match === 'string') {
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
                        `    Avg String Index Time:  ${this.stats.avgIndexTime.toFixed(3)}µs (${(this.stats.avgRegexTime / this.stats.avgIndexTime).toFixed(1)}x faster)\n` +
                        '\n' +
                        'Example matches:\n' +
                        (this.stats.lastMatches[0] !== undefined ? 
                            `Pattern 1 (VTE):\n` +
                            `  Match: \n  ${inspect(this.stats.lastMatches[0])}\n\n` +
                            `  From:  \n  ${inspect(this.stats.lastMatchSources[0])}\n\n` : '') +
                        (this.stats.lastMatches[1] !== undefined ? 
                            `Pattern 2 (VSCE):\n` +
                            `  Match: \n  ${inspect(this.stats.lastMatches[1])}\n\n` +
                            `  From:  \n    ${inspect(this.stats.lastMatchSources[1])}\n\n` : '') +
                        (this.stats.lastMatches[2] !== undefined ? 
                            `Pattern 3 (Fallback):\n` +
                            `  Match: \n  ${inspect(this.stats.lastMatches[2])}\n\n` +
                            `  From:  \n    ${inspect(this.stats.lastMatchSources[2])}\n\n` : '') +
                        (this.stats.noMatchExamples.length > 0 ? 
                            `No match examples:\n` +
                            this.stats.noMatchExamples.map((example, i) => 
                                `  ${i + 1}. ${inspect(example)}`
                            ).join('\n') + '\n' : '');

                    this.onDebug(countSummary);

                    if (options.autoCloseTerminal) {
                        this.terminal?.dispose();
                        this.terminal = undefined;
                    }
                }
            } catch (err) {
                console.error('Error reading stream:', err);
            }
        });

        const endDisposable = (vscode.window as any).onDidEndTerminalShellExecution?.(async (e: any) => {
            if (e.terminal === this.terminal) {
                startDisposable?.dispose();
                endDisposable?.dispose();
                this.isExecuting = false;
                if (options.autoCloseTerminal) {
                    this.terminal?.dispose();
                        this.terminal = undefined;
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
