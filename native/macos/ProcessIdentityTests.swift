import Darwin

@main
struct ProcessIdentityTests {
    static func main() throws {
        let pid: pid_t = 123
        let expectedSize = MemoryLayout<kinfo_proc>.size
        func query(pid returnedPID: pid_t = 123, seconds: Int = 1_700_000_000, microseconds: Int32 = 123_456,
                   result: Int32 = 0, bytes: Int? = nil) -> ProcessInfoQuery {
            return { requestedPID, info, size in
                precondition(requestedPID == pid && size == expectedSize)
                info.kp_proc.p_pid = returnedPID
                info.kp_proc.p_un.__p_starttime = timeval(tv_sec: seconds, tv_usec: microseconds)
                size = bytes ?? expectedSize
                return result
            }
        }
        func reject(_ query: ProcessInfoQuery) {
            do { _ = try processStartIdentity(pid, query: query); preconditionFailure("Invalid process identity accepted") }
            catch ProcessIdentityError.unavailable { }
            catch { preconditionFailure("Unexpected process identity error") }
        }

        let identity = try processStartIdentity(pid, query: query())
        let repeated = try processStartIdentity(pid, query: query())
        precondition(identity == 1_700_000_000_123_456)
        precondition(repeated == identity)
        // A recycled PID must invalidate old targets, including starts within
        // the same millisecond; never round the kernel's microsecond precision.
        let microsecondRestart = try processStartIdentity(pid, query: query(microseconds: 123_457))
        let secondRestart = try processStartIdentity(pid, query: query(seconds: 1_700_000_001))
        precondition(microsecondRestart != identity && secondRestart != identity)

        reject(query(result: -1))
        for bytes in [0, expectedSize - 1, expectedSize + 1] { reject(query(bytes: bytes)) }
        reject(query(pid: pid + 1))
        for seconds in [-1, 0, 10_000_000_000, Int.max] { reject(query(seconds: seconds)) }
        for microseconds: Int32 in [-1, 1_000_000, Int32.max] { reject(query(microseconds: microseconds)) }
        let maximum = try processStartIdentity(pid, query: query(seconds: 9_999_999_999, microseconds: 999_999))
        precondition(maximum == 9_999_999_999_999_999)
        for invalidPID: pid_t in [-1, 0] {
            do {
                _ = try processStartIdentity(invalidPID, query: { _, _, _ in
                    preconditionFailure("Invalid PID reached the kernel query")
                })
                preconditionFailure("Invalid PID accepted")
            } catch ProcessIdentityError.unavailable { }
        }

        // This test executable is launched directly, without LaunchServices.
        // Reading its own process metadata requires no desktop permission.
        let current = try processStartIdentity(getpid())
        let currentAgain = try processStartIdentity(getpid())
        precondition(current > 0 && String(current).count <= 16)
        precondition(currentAgain == current)
        print("Process identity checks passed (kernel start time, direct launch, PID reuse, missing/partial records and invalid timestamps). No desktop access used.")
    }
}
