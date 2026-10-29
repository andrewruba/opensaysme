using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;

// Physical desktop pixels, shared by cursor samples and display screenshots.
// Capture stays in memory; no file, clipboard, focus, or input operations.
public static class OpenSaysMeVisual
{
    [StructLayout(LayoutKind.Sequential)] private struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] private struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct MonitorInfo
    {
        public int Size;
        public Rect Bounds, Work;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string Device;
    }
    [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] private static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] private static extern IntPtr MonitorFromPoint(Point point, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);

    public sealed class CursorSample
    {
        public string CapturedAt, DisplayId;
        public int X, Y;
    }

    private static MonitorInfo Monitor(Point point)
    {
        MonitorInfo info = new MonitorInfo { Size = Marshal.SizeOf(typeof(MonitorInfo)) };
        if (!GetMonitorInfo(MonitorFromPoint(point, 2), ref info)) throw new InvalidOperationException();
        return info;
    }

    private static IntPtr PhysicalCoordinates()
    {
        // PER_MONITOR_AWARE_V2. Failure is explicit; mixing logical and physical
        // coordinates would silently attach attention to the wrong pixels.
        IntPtr previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
        if (previous == IntPtr.Zero) throw new InvalidOperationException();
        return previous;
    }

    public static CursorSample Pointer()
    {
        IntPtr previous = IntPtr.Zero;
        try
        {
            previous = PhysicalCoordinates();
            string capturedAt = DateTime.UtcNow.ToString("o");
            Point point;
            if (!GetCursorPos(out point)) return null;
            MonitorInfo monitor = Monitor(point);
            return new CursorSample { CapturedAt = capturedAt, X = point.X, Y = point.Y, DisplayId = monitor.Device };
        }
        catch { return null; }
        finally { if (previous != IntPtr.Zero) SetThreadDpiAwarenessContext(previous); }
    }

    public static Dictionary<string, object> Encode(Bitmap source)
    {
        double ratio = Math.Min(1, 1600.0 / Math.Max(source.Width, source.Height));
        int width = Math.Max(1, (int)Math.Round(source.Width * ratio));
        int height = Math.Max(1, (int)Math.Round(source.Height * ratio));
        using (Bitmap resized = new Bitmap(width, height, PixelFormat.Format24bppRgb))
        {
            using (Graphics graphics = Graphics.FromImage(resized))
            {
                graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                graphics.DrawImage(source, new Rectangle(0, 0, width, height));
            }
            ImageCodecInfo codec = null;
            foreach (ImageCodecInfo candidate in ImageCodecInfo.GetImageEncoders())
                if (candidate.MimeType == "image/jpeg") { codec = candidate; break; }
            if (codec == null) throw new InvalidOperationException();
            foreach (long quality in new long[] { 80, 65, 45 })
            {
                using (MemoryStream output = new MemoryStream())
                using (EncoderParameters parameters = new EncoderParameters(1))
                {
                    parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);
                    resized.Save(output, codec, parameters);
                    if (output.Length <= 700000)
                        return new Dictionary<string, object> {
                            { "mimeType", "image/jpeg" }, { "width", width }, { "height", height },
                            { "data", Convert.ToBase64String(output.ToArray()) }
                        };
                }
            }
        }
        throw new InvalidOperationException();
    }

    public static string Capture()
    {
        IntPtr previous = PhysicalCoordinates();
        try
        {
            Point point;
            if (!GetCursorPos(out point)) throw new InvalidOperationException();
            MonitorInfo monitor = Monitor(point);
            Rect bounds = monitor.Bounds;
            int width = bounds.Right - bounds.Left, height = bounds.Bottom - bounds.Top;
            if (width <= 0 || height <= 0 || (long)width * height > 64000000) throw new InvalidOperationException();
            using (Bitmap source = new Bitmap(width, height, PixelFormat.Format24bppRgb))
            {
                string capturedAt = DateTime.UtcNow.ToString("o");
                using (Graphics graphics = Graphics.FromImage(source))
                    graphics.CopyFromScreen(bounds.Left, bounds.Top, 0, 0, new Size(width, height), CopyPixelOperation.SourceCopy);
                Dictionary<string, object> result = new Dictionary<string, object> {
                    { "capturedAt", capturedAt },
                    { "display", new Dictionary<string, object> {
                        { "id", monitor.Device },
                        { "bounds", new Dictionary<string, object> { { "x", bounds.Left }, { "y", bounds.Top }, { "width", width }, { "height", height } } }
                    } },
                    { "image", Encode(source) },
                    { "warnings", new string[] { "Protected content and secure desktops may be absent from Windows screenshots." } }
                };
                return new JavaScriptSerializer { MaxJsonLength = 1000000, RecursionLimit = 12 }.Serialize(result);
            }
        }
        finally { SetThreadDpiAwarenessContext(previous); }
    }
}
