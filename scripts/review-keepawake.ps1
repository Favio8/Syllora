$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SylloraReviewPower {
    [DllImport("kernel32.dll")]
    public static extern uint SetThreadExecutionState(uint flags);
}
'@
try {
    while ($true) {
        if ([SylloraReviewPower]::SetThreadExecutionState([uint32]2147483649) -eq 0) { throw 'Unable to keep the review computer awake.' }
        Start-Sleep -Seconds 20
    }
} finally {
    [SylloraReviewPower]::SetThreadExecutionState([uint32]2147483648) | Out-Null
}
