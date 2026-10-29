using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

// JSONL over redirected pipes. Only this thread owns Win32 registration and
// WinMM handles. Reader/writer threads keep slow pipes off the capture loop.
public sealed class OpenSaysMeVoice
{
    private const int ToggleKey = 1, CancelKey = 2;
    private readonly BlockingCollection<Command> commands = new BlockingCollection<Command>(32);
    private readonly BlockingCollection<string> output = new BlockingCollection<string>(64);
    private volatile bool shutdown;
    private bool escapeRegistered;
    private string turnId;
    private Capture capture;
    private Stopwatch recording;
    private sealed class CaptureCleanupException : Exception { }

    private sealed class Command
    {
        public string Type, TurnId;
    }

    private static Command ParseCommand(string line)
    {
        try
        {
            JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 1024, RecursionLimit = 4 };
            Dictionary<string, object> data = json.DeserializeObject(line) as Dictionary<string, object>;
            if (data == null || !data.ContainsKey("type")) return null;
            string type = data["type"] as string;
            if (type == "shutdown" && data.Count == 1) return new Command { Type = type };
            if (type != "start" && type != "stop" && type != "cancel" && type != "settled") return null;
            if (data.Count != 2 || !data.ContainsKey("turnId")) return null;
            string id = data["turnId"] as string;
            if (id == null || !Regex.IsMatch(id, "\\A[a-zA-Z0-9-]{1,64}\\z")) return null;
            return new Command { Type = type, TurnId = id };
        }
        catch { return null; }
    }

    private void ReadCommands()
    {
        try
        {
            StringBuilder line = new StringBuilder();
            while (!shutdown)
            {
                int value = Console.In.Read();
                if (value < 0) { shutdown = true; return; }
                if (value == '\n')
                {
                    Command command = ParseCommand(line.ToString());
                    line.Length = 0;
                    if (command == null) command = new Command { Type = "invalid" };
                    if (!commands.TryAdd(command)) { shutdown = true; return; }
                }
                else
                {
                    if (line.Length >= 1024) { shutdown = true; return; }
                    line.Append((char)value);
                }
            }
        }
        catch { shutdown = true; }
    }

    private void WriteEvents()
    {
        try
        {
            foreach (string line in output.GetConsumingEnumerable())
            {
                Console.Out.WriteLine(line);
                Console.Out.Flush();
            }
        }
        catch { shutdown = true; }
    }

    private void Emit(string type, string id, string field, string value)
    {
        // All inputs are fixed event names, validated IDs, or Base64; no escaping
        // of arbitrary desktop, exception, credential, or command text is needed.
        string line = "{\"type\":\"" + type + "\"";
        if (id != null) line += ",\"turnId\":\"" + id + "\"";
        if (field != null) line += ",\"" + field + "\":\"" + value + "\"";
        if (!output.TryAdd(line + "}")) shutdown = true;
    }

    private void Emit(string type) { Emit(type, null, null, null); }
    private void Error(string code, string id) { Emit("error", id, "code", code); }

    private void StopCapture(bool deliverTail)
    {
        if (capture == null) return;
        Capture previous = capture;
        capture = null;
        try
        {
            previous.Stop();
            if (deliverTail) previous.Drain(delegate(byte[] bytes) {
                Emit("audio", turnId, "data", Convert.ToBase64String(bytes));
            }, false);
        }
        finally { previous.Dispose(); }
    }

    private void ClearTurn()
    {
        try { CancelInput(); }
        finally
        {
            turnId = null;
            recording = null;
        }
    }

    private void CancelInput()
    {
        try { StopCapture(false); }
        finally
        {
            if (escapeRegistered) UnregisterHotKey(IntPtr.Zero, CancelKey);
            escapeRegistered = false;
        }
    }

    private void Handle(Command command)
    {
        if (command.Type == "shutdown") { shutdown = true; return; }
        if (command.Type == "invalid") { Error("invalid-command", null); return; }
        if (command.Type == "start")
        {
            if (turnId != null) { Error("invalid-command", command.TurnId); return; }
            // Escape stays owned until cancellation or provider finalization,
            // including the interval after recording has stopped.
            if (!RegisterHotKey(IntPtr.Zero, CancelKey, 0x4000, 0x1b))
            {
                Error("hotkey-unavailable", command.TurnId);
                return;
            }
            escapeRegistered = true;
            turnId = command.TurnId;
            try
            {
                capture = new Capture();
                recording = Stopwatch.StartNew();
                Emit("audio-started", turnId, null, null);
            }
            catch (CaptureCleanupException) { throw; }
            catch
            {
                Error("microphone-unavailable", turnId);
                CancelInput();
            }
            return;
        }
        // Late cancellation/finalization must never affect a newer turn.
        if (command.Type == "cancel" && turnId == null)
        {
            Emit("audio-stopped", command.TurnId, null, null);
            return;
        }
        if (turnId != command.TurnId) return;
        if (command.Type == "stop" && capture != null)
        {
            StopCapture(true);
            Emit("audio-stopped", turnId, null, null);
        }
        else if (command.Type == "cancel")
        {
            ClearTurn();
            Emit("audio-stopped", command.TurnId, null, null);
        }
        else if (command.Type == "settled") ClearTurn();
    }

    public static void Run() { new OpenSaysMeVoice().Loop(); }

    private void Loop()
    {
        Thread writer = new Thread(WriteEvents) { IsBackground = true };
        Thread reader = new Thread(ReadCommands) { IsBackground = true };
        ConsoleCancelEventHandler onCancel = delegate(object sender, ConsoleCancelEventArgs args) {
            args.Cancel = true;
            shutdown = true;
        };
        Console.CancelKeyPress += onCancel;
        writer.Start();
        bool registered = false;
        try
        {
            Message initial;
            PeekMessage(out initial, IntPtr.Zero, 0, 0, 0);
            registered = RegisterHotKey(IntPtr.Zero, ToggleKey, 0x4006, 0x20);
            if (!registered) { Error("hotkey-unavailable", null); return; }
            reader.Start();
            Emit("ready");
            while (!shutdown)
            {
                Command command;
                // Bound work per tick so input cannot starve capture or Escape.
                for (int i = 0; i < 32 && !shutdown && commands.TryTake(out command); i++) Handle(command);
                if (shutdown) break;
                Message message;
                for (int i = 0; i < 32 && PeekMessage(out message, IntPtr.Zero, 0x0312, 0x0312, 1); i++)
                {
                    if (message.WParam.ToUInt64() == ToggleKey) Emit("toggle");
                    else if (message.WParam.ToUInt64() == CancelKey && turnId != null)
                    {
                        CancelInput();
                        Emit("cancel");
                    }
                }
                if (capture != null)
                {
                    if (recording.ElapsedMilliseconds >= 120000)
                    {
                        string expiredTurn = turnId;
                        CancelInput();
                        Error("capture-failed", expiredTurn);
                    }
                    else capture.Drain(delegate(byte[] bytes) {
                        Emit("audio", turnId, "data", Convert.ToBase64String(bytes));
                    }, true);
                }
                Thread.Sleep(5);
            }
        }
        catch { Error("capture-failed", turnId); }
        finally
        {
            shutdown = true;
            try { ClearTurn(); }
            catch { Error("capture-failed", turnId); }
            if (registered) UnregisterHotKey(IntPtr.Zero, ToggleKey);
            Console.CancelKeyPress -= onCancel;
            output.CompleteAdding();
            writer.Join(500);
            // Background reader may be waiting for the parent to close stdin.
            // Process exit releases it and any OS handles after a forced kill.
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Message
    {
        public IntPtr Window;
        public uint Id;
        public UIntPtr WParam;
        public IntPtr LParam;
        public uint Time;
        public int X, Y;
        public uint Private;
    }
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterHotKey(IntPtr window, int id, uint modifiers, uint key);
    [DllImport("user32.dll")]
    private static extern bool UnregisterHotKey(IntPtr window, int id);
    [DllImport("user32.dll")]
    private static extern bool PeekMessage(out Message message, IntPtr window, uint min, uint max, uint remove);

    private sealed class Capture : IDisposable
    {
        private const int BufferBytes = 4800; // 100 ms of 24 kHz mono signed 16-bit PCM.
        private readonly IntPtr[] headers = new IntPtr[4], buffers = new IntPtr[4];
        private readonly bool[] prepared = new bool[4];
        private readonly uint headerSize = (uint)Marshal.SizeOf(typeof(WaveHeader));
        private IntPtr input;
        private int nextBuffer;
        private bool stopped;

        public Capture()
        {
            WaveFormat format = new WaveFormat {
                Format = 1, Channels = 1, SampleRate = 24000, BytesPerSecond = 48000,
                BlockAlign = 2, BitsPerSample = 16, ExtraSize = 0
            };
            Check(waveInOpen(out input, UInt32.MaxValue, ref format, IntPtr.Zero, IntPtr.Zero, 0));
            try
            {
                for (int i = 0; i < headers.Length; i++)
                {
                    buffers[i] = Marshal.AllocHGlobal(BufferBytes);
                    headers[i] = Marshal.AllocHGlobal((int)headerSize);
                    WaveHeader header = new WaveHeader { Data = buffers[i], BufferLength = BufferBytes };
                    Marshal.StructureToPtr(header, headers[i], false);
                    Check(waveInPrepareHeader(input, headers[i], headerSize));
                    prepared[i] = true;
                    Check(waveInAddBuffer(input, headers[i], headerSize));
                }
                Check(waveInStart(input));
            }
            catch { Dispose(); throw; }
        }

        public void Drain(Action<byte[]> emit, bool requeue)
        {
            // FIFO order matters after ring wrap, especially for the final tail.
            for (int count = 0; count < headers.Length; count++)
            {
                int i = nextBuffer;
                WaveHeader header = (WaveHeader)Marshal.PtrToStructure(headers[i], typeof(WaveHeader));
                if ((header.Flags & 1) == 0) break;
                if (header.BytesRecorded > BufferBytes || header.BytesRecorded % 2 != 0)
                    throw new InvalidOperationException();
                if (header.BytesRecorded > 0)
                {
                    byte[] bytes = new byte[header.BytesRecorded];
                    Marshal.Copy(buffers[i], bytes, 0, bytes.Length);
                    emit(bytes);
                    Array.Clear(bytes, 0, bytes.Length);
                }
                nextBuffer = (nextBuffer + 1) % headers.Length;
                if (requeue)
                {
                    header.BytesRecorded = 0;
                    Marshal.StructureToPtr(header, headers[i], false);
                    Check(waveInAddBuffer(input, headers[i], headerSize));
                }
            }
        }

        public void Stop()
        {
            if (stopped || input == IntPtr.Zero) return;
            Check(waveInReset(input));
            stopped = true;
        }

        public void Dispose()
        {
            if (input == IntPtr.Zero) return;
            bool failed = !stopped && waveInReset(input) != 0;
            for (int i = 0; i < headers.Length; i++)
            {
                if (prepared[i] && waveInUnprepareHeader(input, headers[i], headerSize) != 0)
                {
                    // Never free memory still owned by a driver. A cleanup
                    // failure ends the helper process instead of starting again.
                    failed = true;
                    continue;
                }
                if (headers[i] != IntPtr.Zero) Marshal.FreeHGlobal(headers[i]);
                if (buffers[i] != IntPtr.Zero) Marshal.FreeHGlobal(buffers[i]);
            }
            if (waveInClose(input) != 0) failed = true;
            input = IntPtr.Zero;
            if (failed) throw new CaptureCleanupException();
        }

        private static void Check(uint result) { if (result != 0) throw new InvalidOperationException(); }
    }

    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    private struct WaveFormat
    {
        public ushort Format, Channels;
        public uint SampleRate, BytesPerSecond;
        public ushort BlockAlign, BitsPerSample, ExtraSize;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct WaveHeader
    {
        public IntPtr Data;
        public uint BufferLength, BytesRecorded;
        public UIntPtr User;
        public uint Flags, Loops;
        public IntPtr Next;
        public UIntPtr Reserved;
    }
    [DllImport("winmm.dll")]
    private static extern uint waveInOpen(out IntPtr input, uint device, ref WaveFormat format, IntPtr callback, IntPtr instance, uint flags);
    [DllImport("winmm.dll")]
    private static extern uint waveInPrepareHeader(IntPtr input, IntPtr header, uint size);
    [DllImport("winmm.dll")]
    private static extern uint waveInUnprepareHeader(IntPtr input, IntPtr header, uint size);
    [DllImport("winmm.dll")]
    private static extern uint waveInAddBuffer(IntPtr input, IntPtr header, uint size);
    [DllImport("winmm.dll")]
    private static extern uint waveInStart(IntPtr input);
    [DllImport("winmm.dll")]
    private static extern uint waveInReset(IntPtr input);
    [DllImport("winmm.dll")]
    private static extern uint waveInClose(IntPtr input);
}
