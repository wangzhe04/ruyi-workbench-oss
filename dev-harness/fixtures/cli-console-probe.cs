using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
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
    [StructLayout(LayoutKind.Sequential)]
    private struct JobAccounting
    {
        public long User, Kernel, PeriodUser, PeriodKernel;
        public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }

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
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr job, int info, out JobAccounting data, int size, IntPtr returned);

    private static ProcessInfo StartCli(IntPtr console, string executable, string commandLine, IntPtr job)
    {
        const int PseudoConsoleAttribute = 0x20016;
        const int JobListAttribute = 0x2000d;
        const uint ExtendedStartupInfo = 0x00080000;
        int count = job == IntPtr.Zero ? 1 : 2;
        IntPtr size = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, count, 0, ref size);
        IntPtr list = Marshal.AllocHGlobal(size);
        IntPtr jobs = IntPtr.Zero;
        try
        {
            if (!InitializeProcThreadAttributeList(list, count, 0, ref size)) throw new Win32Exception();
            try
            {
                if (!UpdateProcThreadAttribute(list, 0, (IntPtr)PseudoConsoleAttribute, console,
                    (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();
                if (job != IntPtr.Zero)
                {
                    jobs = Marshal.AllocHGlobal(IntPtr.Size);
                    Marshal.WriteIntPtr(jobs, job);
                    if (!UpdateProcThreadAttribute(list, 0, (IntPtr)JobListAttribute, jobs,
                        (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();
                }
                var startup = new StartupInfoEx { Info = new StartupInfo { Size = Marshal.SizeOf(typeof(StartupInfoEx)) }, Attributes = list };
                var command = new StringBuilder(commandLine);
                ProcessInfo child;
                if (!CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, false, ExtendedStartupInfo,
                    IntPtr.Zero, null, ref startup, out child)) throw new Win32Exception();
                CloseHandle(child.Thread);
                return child;
            }
            finally { DeleteProcThreadAttributeList(list); }
        }
        finally
        {
            Marshal.FreeHGlobal(jobs);
            Marshal.FreeHGlobal(list);
        }
    }

    private static void Run(string executable, string commandLine, IntPtr job)
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
                    var child = StartCli(console, executable, commandLine, job);
                    try
                    {
                        inputRead.Dispose();
                        outputWrite.Dispose();
                        long creation, exit, kernel, user;
                        if (!GetProcessTimes(child.Process, out creation, out exit, out kernel, out user)) throw new Win32Exception();
                        Console.WriteLine("started {0} {1}", child.Pid, creation);
                        string action = Console.ReadLine();
                        if (job != IntPtr.Zero)
                        {
                            if (action != "wait-maintenance") throw new IOException("maintenance exit not requested");
                        }
                        else
                        {
                            if (WaitForSingleObject(child.Process, 0) != 258)
                                throw new IOException("CLI exited before the requested action");
                            switch (action)
                            {
                                case "ctrl-c":
                                    input.WriteByte(3);
                                    input.Flush();
                                    Console.WriteLine("ctrl-c-written");
                                    break;
                                case "terminate":
                                    if (!TerminateProcess(child.Process, 73)) throw new Win32Exception();
                                    Console.WriteLine("cli-terminated");
                                    break;
                                case "terminal-close":
                                    ClosePseudoConsole(console);
                                    console = IntPtr.Zero;
                                    Console.WriteLine("terminal-closed");
                                    break;
                                default: throw new IOException("CLI exit action not requested");
                            }
                        }
                        if (WaitForSingleObject(child.Process, job == IntPtr.Zero ? 30000U : 65000U) != 0)
                            throw new IOException("CLI did not exit after the requested action");
                        uint code;
                        if (!GetExitCodeProcess(child.Process, out code)) throw new Win32Exception();
                        Console.WriteLine("exited {0}", code);
                        // Retain the process handle and any open console until the
                        // controller verifies the original CLI and worker exits.
                        if (Console.ReadLine() != "release") throw new IOException("probe release before acceptance");
                    }
                    finally { CloseHandle(child.Process); }
                }
                finally { if (console != IntPtr.Zero) ClosePseudoConsole(console); }
                if (!drain.Wait(10000)) throw new IOException("console output did not drain");
                Console.WriteLine("console-released");
            }
        }
    }

    private static void RunMaintenance(string executable, string commandLine)
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception();
        try { Run(executable, commandLine, job); }
        finally
        {
            try
            {
                // Cold/successor processes belong only to this fixture. An
                // accepted run has already proved original exit independently.
                if (!TerminateJobObject(job, 1)) throw new Win32Exception();
                var deadline = Stopwatch.StartNew();
                while (true)
                {
                    JobAccounting accounting;
                    if (!QueryInformationJobObject(job, 1, out accounting, Marshal.SizeOf(typeof(JobAccounting)), IntPtr.Zero))
                        throw new Win32Exception();
                    if (accounting.ActiveProcesses == 0) break;
                    if (deadline.ElapsedMilliseconds >= 10000) throw new IOException("fixture Job did not drain");
                    Thread.Sleep(25);
                }
                Console.WriteLine("fixture-job-ended");
            }
            finally { CloseHandle(job); }
        }
    }

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length == 3 && args[2] == "maintenance") RunMaintenance(args[0], args[1]);
            else Run(args[0], args[1], IntPtr.Zero);
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }
}
