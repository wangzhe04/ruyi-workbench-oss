using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

// Hosts exactly one production CLI in a private Windows pseudoconsole.
internal static class CliConsoleProbe
{
    [StructLayout(LayoutKind.Sequential)]
    private struct Coord { public short X, Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfo
    {
        public int Size;
        public IntPtr Reserved, Desktop, Title;
        public int X, Y, Width, Height, Columns, Rows, Fill, Flags;
        public short Show, ReservedSize;
        public IntPtr ReservedBytes, Input, Output, Error;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfoEx { public StartupInfo Info; public IntPtr Attributes; }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInfo { public IntPtr Process, Thread; public int Pid, Tid; }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CreatePipe(out SafeFileHandle read, out SafeFileHandle write, IntPtr security, uint size);
    [DllImport("kernel32.dll")]
    private static extern int CreatePseudoConsole(Coord size, SafeFileHandle input, SafeFileHandle output, uint flags, out IntPtr console);
    [DllImport("kernel32.dll")]
    private static extern void ClosePseudoConsole(IntPtr console);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr bytes);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(IntPtr list, int flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(string exe, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity,
        bool inherit, uint flags, IntPtr env, string cwd, ref StartupInfoEx startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    private static ProcessInfo StartCli(IntPtr console, string node, string server)
    {
        const int PseudoConsoleAttribute = 0x20016;
        const uint ExtendedStartupInfo = 0x00080000;
        IntPtr size = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
        IntPtr list = Marshal.AllocHGlobal(size);
        try
        {
            if (!InitializeProcThreadAttributeList(list, 1, 0, ref size)) throw new Win32Exception();
            try
            {
                if (!UpdateProcThreadAttribute(list, 0, (IntPtr)PseudoConsoleAttribute, console,
                    (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();
                var startup = new StartupInfoEx { Info = new StartupInfo { Size = Marshal.SizeOf(typeof(StartupInfoEx)) }, Attributes = list };
                var command = new StringBuilder("\"" + node + "\" \"" + server + "\" serve");
                ProcessInfo child;
                if (!CreateProcess(node, command, IntPtr.Zero, IntPtr.Zero, false, ExtendedStartupInfo,
                    IntPtr.Zero, null, ref startup, out child)) throw new Win32Exception();
                CloseHandle(child.Thread);
                return child;
            }
            finally { DeleteProcThreadAttributeList(list); }
        }
        finally { Marshal.FreeHGlobal(list); }
    }

    private static void Run(string node, string server)
    {
        SafeFileHandle inputRead, inputWrite;
        if (!CreatePipe(out inputRead, out inputWrite, IntPtr.Zero, 0)) throw new Win32Exception();
        using (inputRead)
        using (inputWrite)
        {
            SafeFileHandle outputRead, outputWrite;
            if (!CreatePipe(out outputRead, out outputWrite, IntPtr.Zero, 0)) throw new Win32Exception();
            using (outputRead)
            using (outputWrite)
            using (var input = new FileStream(inputWrite, FileAccess.Write))
            using (var output = new FileStream(outputRead, FileAccess.Read))
            {
                IntPtr console;
                Marshal.ThrowExceptionForHR(CreatePseudoConsole(new Coord { X = 100, Y = 30 }, inputRead, outputWrite, 0, out console));
                var drain = Task.Run(() => output.CopyTo(Stream.Null));
                try
                {
                    var child = StartCli(console, node, server);
                    try
                    {
                        inputRead.Dispose();
                        outputWrite.Dispose();
                        long creation, exit, kernel, user;
                        if (!GetProcessTimes(child.Process, out creation, out exit, out kernel, out user)) throw new Win32Exception();
                        Console.WriteLine("started {0} {1}", child.Pid, creation);
                        if (Console.ReadLine() != "ctrl-c") throw new IOException("Ctrl+C input not requested");
                        input.WriteByte(3);
                        input.Flush();
                        Console.WriteLine("ctrl-c-written");
                        if (WaitForSingleObject(child.Process, 30000) != 0) throw new IOException("CLI did not exit after Ctrl+C");
                        uint code;
                        if (!GetExitCodeProcess(child.Process, out code)) throw new Win32Exception();
                        Console.WriteLine("exited {0}", code);
                        // The controller verifies the CLI and worker exited while this console remains open.
                        if (Console.ReadLine() != "release") throw new IOException("console release before acceptance");
                    }
                    finally { CloseHandle(child.Process); }
                }
                finally { ClosePseudoConsole(console); }
                if (!drain.Wait(10000)) throw new IOException("console output did not drain");
                Console.WriteLine("console-released");
            }
        }
    }

    private static int Main(string[] args)
    {
        try { Run(args[0], args[1]); return 0; }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }
}
