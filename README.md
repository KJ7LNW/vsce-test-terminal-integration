# VSCode Terminal Integration Test Extension

## Overview

This VSCode extension provides a test harness for investigating terminal command execution and shell integration behavior, focusing on a race condition between command completion sequences and their consumers.

## Features

- Interactive command execution interface
- Configurable prompt command testing
- Shell integration testing capabilities
- Pattern matching analysis for command completion sequences
- Performance metrics for different matching approaches
- Detailed statistics and debug output

## Installation

1. Clone this repository
2. Run `npm install` to install dependencies
3. Open in VSCode and press F5 to run the extension
4. Open the "Terminal Commands" view from the Activity Bar (the vertical bar on the far left of VSCode containing icons for Explorer, Search, etc.)

## Usage

The extension provides a webview interface with:

- Command input field with preset command options
- Configurable `$PROMPT_COMMAND` setting with preset (or manually set) options to test how different PROMPT_COMMAND delays affect command completion detection:
  - `sleep 0.1` - adds 100ms delay after each command
  - `sleep 0` - minimal delay after each command
  - `true` - no-op command after each command
  - `#` - comment, effectively disables PROMPT_COMMAND
- Options for auto-closing terminals and shell integration
- Real-time command output display
- Pattern matching statistics

### Known Issues with VSCode shell integration:
Note: The following test cases demonstrate behaviors that are reliably reproducible on the author's system. Due to the timing-sensitive nature of these race conditions, actual behavior may vary slightly on different systems or under different load conditions.

- **Race Condition Test Cases**
     1. Testing with 'echo a' and varying PROMPT_COMMAND:
         - Command: `echo a` with PROMPT_COMMAND=`true`
            - Fails: output is lost
            - Bash builtin executes too quickly
        - Command: `echo a` with PROMPT_COMMAND=`/bin/true`
          - Works: output is preserved
          - Binary provides sufficient timing delay
     2. Testing with 'echo a' and varying command path:
        - Command: `echo a` with PROMPT_COMMAND=`#`
          - Fails: output is lost
        - Command: `/bin/echo a` with PROMPT_COMMAND=`#`
          - Works: output is preserved
          - Binary provides sufficient timing delay
     3. Testing with empty string and varying command path:
        - Command: `echo ""` with PROMPT_COMMAND=`#`
          - Fails: CR/LF output is lost
          - Bash builtin executes too quickly
        - Command: `/bin/echo ""` with PROMPT_COMMAND=`#`
          - Works: CR/LF is preserved
          - Binary provides sufficient timing delay

### Running Tests

1. Enter a command or select from the dropdown, or type your own custom command 
2. Configure `PROMPT_COMMAND` if needed
3. Click "Run Command" to execute
4. View results in the output and statistics panels
5. Use "Reset Stats" to clear counters

### Pattern Matching Statistics

The extension tracks three pattern types for command completion. A key test case that demonstrates the race condition is running `echo a` with PROMPT_COMMAND set to `#`:
- This combination reliably triggers the race condition because:
  1. `echo a` outputs data immediately
  2. `#` as PROMPT_COMMAND provides no delay
  3. The barrier releases before the terminal processes the output
  4. Result: command output is lost and "Fallback" pattern matches but `a` is not captured; counters are adjusted accordingly.

The extension attempts to match patterns in this order:

1. VTE Pattern: First priority when enabled (disabled by default)
    - Only attempted if enabled and VTE is installed (e.g., as `/etc/profile.d/vte.*`)
    - Matches `\x1b]633;C\x07<CONTENT>\x1b]777;notify;Command completed` sequence
    - VTE patterns are tried first because they are more reliable, but are separate from VSCode terminal integration
    - If no match is found, continues to VSCode pattern
    - Can be enabled/disabled via the "Enable VTE pattern matching" checkbox
    - When disabled (default), environment variable VTE_VERSION=0 is set to prevent VTE functionality
      - This disables VTE even when it is installed in your system
      - VSCode pattern matching is used instead
    - When enabled and VTE is installed in your system:
      - VTE pattern matching will be attempted
2. VSCode Pattern: Second priority
    - Matches `\x1b]633;C\x07<CONTENT>\x1b]633;D` sequence
    - Attempted if VTE pattern is disabled or did not match
    - If no match is found, continues to fallback pattern
3. Fallback Pattern: Last resort
   - Matches `\x1b]633;C\x07<CONTENT>` sequence to end of output; this handles the race condition when `\x1b]633;D` is lost, thus there is no terminating sequence in this match.
   - Only attempted if both VTE and VSCode patterns did not match
   - When using `echo a` with PROMPT_COMMAND=`#`, this pattern matches
   - However, the command output (`a`) is lost because the barrier releases too early
   - The pattern matches the sequence but cannot capture the output
   - This demonstrates that the race condition affects command output capture

Statistics show:
- Match counts for each pattern type
- No-match cases (indicates a bug)
- Total 633;D sequence occurrences (to track lost command-end escape sequences)
- Shell integration warnings (these should not happen)
- Performance metrics for regex vs string index matching to see which implementation is faster for large outputs 

## Race Condition Documentation

### PROMPT_COMMAND and Shell Integration

VSCode's terminal integration preserves PROMPT_COMMAND while adding shell integration:

1. When a terminal starts:
   - Original PROMPT_COMMAND is stored as __vsc_prompt_cmd_original
   - VSCode's shell integration functions are declared
   - These functions wrap commands with OSC 633;C and 633;D sequences

2. Using PROMPT_COMMAND to control the race:
   - `sleep 0.1` adds delay between command output and 633;D
   - This delay allows write callback to complete
   - Without delay (e.g. with `#`), the barrier releases before shell integration internals queue it to the consumer 
   - The delay works around the race condition
   - Shell functions execute __vsc_prompt_cmd_original
   - Command output remains wrapped with VSCode sequences
   - Only sequence emission timing is affected

VSCode's terminal integration relies on PROMPT_COMMAND to detect command completion:

1. The test harness allows configuring PROMPT_COMMAND to simulate different timing scenarios:
   - Longer delays (sleep 0.1) make command completion more reliable but slower
   - Minimal delays (sleep 0, true, #) may expose race conditions
   - Each option affects when the 633;D sequence is emitted

2. When a command runs, the sequence is:
   - Command starts → OSC 633;C emitted
   - Command executes
   - PROMPT_COMMAND executes (with configured delay)
   - Command completes → OSC 633;D emitted

#### Command Finished Sequence

The OSC 633;D sequence indicates command completion in the terminal:

```
OSC 633 ; D [; <ExitCode>] ST
```

Where:
- 633 identifies this as a VSCode shell integration sequence
- D indicates command finished
- Optional ExitCode parameter provides the command's exit status
- ST is the string terminator (\x07)

### Barrier Purpose

The barrier is used to:
1. Block terminal operations while a command is executing
2. Release when the command finishes to allow pending operations to proceed
3. Ensure consumers see all command output before continuing

The barrier is critical for features that need to process command output, like task execution and command tracking.

## Empirical Evidence

Testing with the terminal handler shows the race condition through pattern matching statistics. The test works by:

1. Running commands that emit command completion sequences
2. Attempting to match the sequences using three different patterns:
   - VTE Pattern: Most reliable, matches VTE notification sequences (must be disabled to test VSCode race condition)
   - VSCode Pattern: Matches VSCode command completion sequences
   - Fallback Pattern: Matches remaining command completion cases
3. Tracking match statistics:
   - Pattern match counts for each type
   - No-match cases indicating potential race conditions
   - Total 633;D sequence occurrences to detect lost sequences
   - Performance metrics comparing regex vs string index matching

The implementation uses both regex and string index matching approaches to validate results:
```typescript
// Example from terminal-handler.ts
const regexResult = this.benchmarkRegex(output, pattern);
const indexResult = this.benchmarkStringIndex(output, prefix, suffix);
```

When mismatches occur between regex and string index matching, they are recorded:
```typescript
if (regexMatch !== indexMatch) {
    this.stats.matchMismatches.push(
        `Pattern ${patternNumber} mismatch:\n` +
        `  Regex: ${regexMatch}\n` +
        `  Index: ${indexMatch}`
    );
}
```

The statistics show:
- Pattern match counts revealing which completion sequences are detected
- Performance comparisons showing which matching method is faster
- Shell integration warnings indicating potential setup issues
- Total sequence counts to track sequence loss

This data provides evidence of the race condition in practice.

## Data Flow

### 1. Process Data Arrival
When terminal data containing the sequence arrives, it is handled in `TerminalInstance._onProcessData`:

```typescript
private _onProcessData(ev: IProcessDataEvent): void {
    const execIndex = ev.data.indexOf('\x1b]633;C\x07');
    if (execIndex !== -1) {
        if (ev.trackCommit) {
            // Split at sequence boundary
            this._writeProcessData(ev.data.substring(0, execIndex + '\x1b]633;C\x07'.length));
            ev.writePromise = new Promise<void>(r =>
                this._writeProcessData(ev.data.substring(execIndex + '\x1b]633;C\x07'.length), r)
            );
        }
    }
}
```

### 2. Data Write to Terminal
The data is written to xterm.js in `TerminalInstance._writeProcessData`:

```typescript
private _writeProcessData(data: string, cb?: () => void) {
    this._onWillData.fire(data);
    const messageId = ++this._latestXtermWriteData;
    this.xterm?.raw.write(data, () => {
        this._latestXtermParseData = messageId;
        this._processManager.acknowledgeDataEvent(data.length);
        cb?.();
        this._onData.fire(data);  // AsyncIterable consumers listen to this
    });
}
```

### 3. Sequence Parsing
The sequence is parsed immediately by xterm.js's parser and handled in `ShellIntegrationAddon._doHandleVSCodeSequence`:

```typescript
case VSCodeOscPt.CommandFinished: {
    const arg0 = args[0];
    const exitCode = arg0 !== undefined ? parseInt(arg0) : undefined;
    this._createOrGetCommandDetection(this._terminal).handleCommandFinished(exitCode);
    return true;
}
```

## Race Condition

The sequence of events is:

1. Process data arrives containing OSC 633 ; D
2. Data is written to xterm.js
3. xterm.js parser immediately processes the sequence
4. Command finished handler is called which releases the barrier
5. Write callback completes and fires onData event
6. AsyncIterable consumers receive the data

The key issue is that steps 3-4 happen before step 5-6. This means:

- The barrier is released in step 4
- But consumers don't receive the data until step 6
- There is no guarantee consumers will see the sequence data before the barrier releases

The "found" case (correct behavior) only occurs when the write callback happens to complete before the barrier releases, which is not guaranteed by the current implementation.

### Verification

This can be verified by:

1. Adding logging to the write callback in TerminalInstance._writeProcessData
2. Adding logging to the command finished handler in ShellIntegrationAddon
3. Observing that the command finished handler logs appear before write callback logs

This confirms the sequence is parsed and handled before the write completes and reaches consumers.

### Potential Solutions

Several approaches could fix this race condition:

1. Delay Barrier Release
   - Wait for write callback completion before releasing the barrier
   - Add a promise to track write completion
   - Only release after both parse and write are done

2. Sequence Number Tracking
   - Add sequence numbers to command finished events
   - Track latest sequence seen by consumers
   - Ensure barrier only releases after consumer sees matching sequence

3. Event Ordering
   - Modify xterm.js to guarantee write callback executes before parser
   - Would require changes to xterm.js event handling architecture
   - Most invasive but provides strongest guarantees

4. Consumer-Side Buffering
   - Have consumers buffer sequences until barrier releases
   - Process buffer when barrier releases to catch up
   - More complex consumer logic but avoids core changes

The first approach (delaying barrier release) is likely the simplest and most robust solution, especially given the empirical evidence showing the high frequency of the race condition in practice.
