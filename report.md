# Terminal Shell Integration Race Condition

## Overview

There is a race condition in VSCode's terminal shell integration where the command finished barrier is released before AsyncIterable consumers receive the sequence data. This affects extensions that rely on seeing the sequence before the barrier releases.

## Environment

- VS Code Version: Tested on both stable 1.96.2 and insiders 1.97.0
```
Version: 1.97.0-insider
Commit: 89f808979a5151bd91324e65d4f7ab1b62896983
Date: 2024-12-20T05:04:19.167Z
Electron: 32.2.6
ElectronBuildId: 10629634
Chromium: 128.0.6613.186
Node.js: 20.18.1
V8: 12.8.374.38-electron.0
OS: Linux x64 6.6.67
```

- OS Version: Oracle Linux 9
- Extensions: This issue requires an extension to test, as it relates to the terminal shell integration API

## Steps to Reproduce

1. Clone and run the test extension: https://github.com/KJ7LNW/vsce-test-terminal-integration
2. Load the folder in VSCode and press F5
3. Press "Run Command" repeatedly and quickly to watch the counts change
4. Observe the counts - in a correct implementation, only the "found" count should increment

## Test Results

Running the test extension shows:
```
OSC ] 633;D
    found:     3     // GOOD: Consumer saw sequence before barrier released (expected behavior)
    not found: 12    // BUG: Barrier released before consumer saw sequence (race condition)
    neither:   1     // Test error or timeout
(Run 15)
```

Example of a "found" case (GOOD - expected behavior where consumer sees sequence before barrier):
```
Match: 
'a\r\n' +
'\x1B]777;notify;Command completed;echo a\x1B\\\x1B]777;precmd\x1B\\\x1B]0;ewheeler@edesktop:~\x1B\\\x1B]7;file://edesktop.ewi/home/ewheeler\x1B\\'

From:  
'echo a\r\n' +
'\x1B[?2004l\r\x1B]777;preexec\x1B\\\x1B]633;E;echo a;23d6ea60-059f-428c-9424-a497b533ee7a\x07\x1B]633;C\x07a\r\n' +
'\x1B]777;notify;Command completed;echo a\x1B\\\x1B]777;precmd\x1B\\\x1B]0;ewheeler@edesktop:~\x1B\\\x1B]7;file://edesktop.ewi/home/ewheeler\x1B\\\x1B]633;D;0\x07\x1B]633;P;Cwd=/home/ewheeler\x07'
```

Example of a "not found" case (BUG - race condition where barrier releases too early):
```
Match: 
'a\r\n'

From:  
'echo a\r\n' +
'\x1B[?2004l\r\x1B]777;preexec\x1B\\\x1B]633;E;echo a;8680055d-1545-4c64-859d-3c4ff3a0c412\x07\x1B]633;C\x07a\r\n'
```

## Expected Behavior

The barrier should only be released after AsyncIterable consumers have received and processed the command finished sequence. The "found" count should increment consistently, indicating consumers reliably see the sequence before the barrier releases. The "not found" count should always be zero in a correct implementation.

## Actual Behavior

The barrier is frequently released before consumers receive the sequence data:
- Only 20% of runs (3/15) had the correct behavior (found case)
- 80% of runs (12/15) exhibited the race condition (not found case)
- The high rate of "not found" cases demonstrates this is a real race condition affecting most command executions

## Technical Details

The race condition occurs because:
1. Data write starts
2. Parser processes sequence immediately 
3. Barrier releases
4. Write callback completes later
5. Consumer finally receives data

Step 3 happens before step 5, breaking the assumption that consumers will see the sequence before the barrier releases. The "found" case (correct behavior) only occurs when the write callback happens to complete before the barrier releases, which is not guaranteed by the current implementation.

See the full technical analysis at: https://github.com/KJ7LNW/vsce-test-terminal-integration
