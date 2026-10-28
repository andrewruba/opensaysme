using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

// Built by Windows PowerShell against the installed .NET Framework at runtime.
// The probes retain no audio, install no hooks, and release their native handles.
public static class OpenSaysMeInput
{
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

    public static bool TestHotkey(int milliseconds)
    {
        ValidateDuration(milliseconds);
        // Force creation of this thread's message queue before registration.
        Message initialMessage;
        PeekMessage(out initialMessage, IntPtr.Zero, 0, 0, 0);
        // MOD_CONTROL | MOD_SHIFT | MOD_NOREPEAT, VK_SPACE.
        if (!RegisterHotKey(IntPtr.Zero, 1, 0x4006, 0x20))
            throw new InvalidOperationException("Hotkey registration failed.");
        try
        {
            Stopwatch timer = Stopwatch.StartNew();
            while (timer.ElapsedMilliseconds < milliseconds)
            {
                Message message;
                if (PeekMessage(out message, IntPtr.Zero, 0x0312, 0x0312, 1)
                    && message.WParam.ToUInt64() == 1) return true;
                Thread.Sleep(10);
            }
            return false;
        }
        finally { UnregisterHotKey(IntPtr.Zero, 1); }
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

    public static long TestMicrophone(int milliseconds)
    {
        ValidateDuration(milliseconds);
        WaveFormat format = new WaveFormat {
            Format = 1, Channels = 1, SampleRate = 16000, BytesPerSecond = 32000,
            BlockAlign = 2, BitsPerSample = 16, ExtraSize = 0
        };
        IntPtr input;
        Check(waveInOpen(out input, UInt32.MaxValue, ref format, IntPtr.Zero, IntPtr.Zero, 0));
        IntPtr[] headers = new IntPtr[4];
        IntPtr[] buffers = new IntPtr[4];
        bool[] prepared = new bool[4];
        uint headerSize = (uint)Marshal.SizeOf(typeof(WaveHeader));
        long bytes = 0;
        try
        {
            for (int i = 0; i < headers.Length; i++)
            {
                buffers[i] = Marshal.AllocHGlobal(4096);
                headers[i] = Marshal.AllocHGlobal((int)headerSize);
                WaveHeader header = new WaveHeader { Data = buffers[i], BufferLength = 4096 };
                Marshal.StructureToPtr(header, headers[i], false);
                Check(waveInPrepareHeader(input, headers[i], headerSize));
                prepared[i] = true;
                Check(waveInAddBuffer(input, headers[i], headerSize));
            }
            Check(waveInStart(input));
            Stopwatch timer = Stopwatch.StartNew();
            while (timer.ElapsedMilliseconds < milliseconds)
            {
                for (int i = 0; i < headers.Length; i++)
                {
                    WaveHeader header = (WaveHeader)Marshal.PtrToStructure(headers[i], typeof(WaveHeader));
                    if ((header.Flags & 1) == 0) continue; // WHDR_DONE
                    bytes += header.BytesRecorded;
                    header.BytesRecorded = 0;
                    Marshal.StructureToPtr(header, headers[i], false);
                    Check(waveInAddBuffer(input, headers[i], headerSize));
                }
                Thread.Sleep(10);
            }
            return bytes;
        }
        finally
        {
            // Reset returns queued buffers before unpreparing and freeing them.
            bool cleanupFailed = waveInReset(input) != 0;
            for (int i = 0; i < headers.Length; i++)
            {
                if (prepared[i] && waveInUnprepareHeader(input, headers[i], headerSize) != 0)
                {
                    // Never free memory still owned by a device driver. The
                    // short-lived helper exits after reporting this failure.
                    cleanupFailed = true;
                    continue;
                }
                if (headers[i] != IntPtr.Zero) Marshal.FreeHGlobal(headers[i]);
                if (buffers[i] != IntPtr.Zero) Marshal.FreeHGlobal(buffers[i]);
            }
            if (waveInClose(input) != 0) cleanupFailed = true;
            if (cleanupFailed) throw new InvalidOperationException("Microphone cleanup failed.");
        }
    }

    private static void Check(uint result)
    {
        if (result != 0) throw new InvalidOperationException("Microphone access failed.");
    }

    private static void ValidateDuration(int milliseconds)
    {
        if (milliseconds < 1000 || milliseconds > 30000)
            throw new ArgumentOutOfRangeException("milliseconds");
    }
}
