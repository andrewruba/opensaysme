import Darwin

enum ProcessIdentityError: Error {
    case unavailable
}

typealias ProcessInfoQuery = (pid_t, inout kinfo_proc, inout Int) -> Int32

private func readProcessInfo(_ processID: pid_t, _ info: inout kinfo_proc, _ size: inout Int) -> Int32 {
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, processID]
    return sysctl(&mib, u_int(mib.count), &info, &size, nil, 0)
}

// LaunchServices does not provide NSRunningApplication.launchDate for directly
// launched executables. The kernel start time also identifies those processes,
// while retaining PID-reuse protection across separate helper invocations.
func processStartIdentity(_ processID: pid_t, query: ProcessInfoQuery = readProcessInfo) throws -> UInt64 {
    guard processID > 0 else { throw ProcessIdentityError.unavailable }
    var info = kinfo_proc()
    let expectedSize = MemoryLayout<kinfo_proc>.size
    var size = expectedSize
    guard query(processID, &info, &size) == 0, size == expectedSize,
          info.kp_proc.p_pid == processID else {
        throw ProcessIdentityError.unavailable
    }
    let started = info.kp_proc.p_un.__p_starttime
    guard started.tv_sec > 0, (0..<1_000_000).contains(started.tv_usec) else {
        throw ProcessIdentityError.unavailable
    }
    // Target tokens allow at most 16 decimal digits. Check before multiplying
    // so malformed native values cannot overflow or produce an invalid token.
    let maximum: UInt64 = 9_999_999_999_999_999
    let seconds = UInt64(started.tv_sec)
    guard seconds <= maximum / 1_000_000 else { throw ProcessIdentityError.unavailable }
    let identity = seconds * 1_000_000 + UInt64(started.tv_usec)
    guard identity <= maximum else { throw ProcessIdentityError.unavailable }
    return identity
}
