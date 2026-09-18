// Process identity beyond pid liveness: PIDs get reused, so a live pid does not
// prove the recorded process still exists. The worker records the platform-reported
// start token of itself and of the endpoint process; reconcile and cancel re-query
// before acting. Query failure degrades to pid-only behavior (documented in notes),
// never to a crash. Zero dependencies: platform commands only.

import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type ProcessStartQuery = (pid: number) => Promise<string | null>

/**
 * Platform process-start token. Equality within one boot is identity; the format
 * differs per OS and is never parsed. null = query unavailable/failed.
 * win32: CIM CreationDate; linux: /proc/<pid>/stat field 22 (starttime in clock
 * ticks since boot); macOS/other: ps lstart.
 */
export const queryProcessStart: ProcessStartQuery = async (pid) => {
    if (!Number.isSafeInteger(pid) || pid <= 0) return null
    try {
        if (process.platform === 'win32') {
            const { stdout } = await execFileAsync(
                'powershell.exe',
                [
                    '-NoProfile',
                    '-NonInteractive',
                    '-Command',
                    `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate`,
                ],
                { timeout: 10_000, windowsHide: true },
            )
            const text = stdout.trim()
            return text === '' ? null : text
        }
        if (process.platform === 'linux') {
            const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8')
            // comm (field 2) may contain spaces/parens; fields after the last ')'
            // start at field 3, so starttime (field 22) is index 19
            const close = stat.lastIndexOf(')')
            if (close < 0) return null
            const start = stat.slice(close + 2).split(' ')[19]
            return start && /^\d+$/.test(start) ? start : null
        }
        const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 5_000 })
        const text = stdout.trim()
        return text === '' ? null : text
    } catch {
        return null
    }
}

export type IdentityVerdict = 'match' | 'mismatch' | 'unknown'

/**
 * 'match' = same process; 'mismatch' = the pid was reused (recorded process is
 * gone); 'unknown' = no recorded token or the query failed — callers degrade to
 * pid-only behavior and say so.
 */
export async function verifyProcessIdentity(
    pid: number,
    recordedStart: string | null | undefined,
    query: ProcessStartQuery = queryProcessStart,
): Promise<IdentityVerdict> {
    if (!recordedStart) return 'unknown'
    const current = await query(pid)
    if (current === null) return 'unknown'
    return current === recordedStart ? 'match' : 'mismatch'
}
