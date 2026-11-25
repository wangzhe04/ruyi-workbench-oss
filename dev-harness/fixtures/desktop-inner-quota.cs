using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;

namespace RuyiDesktop
{
    // Runs only in the dedicated console probe. Borrow the production Job handle
    // in this process so no production constructor or launch behavior is replaced.
    internal static class DesktopInnerQuotaProbe
    {
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool QueryInformationJobObject(IntPtr job, int kind,
            out Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits, int size, out int returned);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
        private static readonly JavaScriptSerializer json = new JavaScriptSerializer();
        private static void Write(object value) { Console.WriteLine(json.Serialize(value)); }

        private static int Main(string[] args)
        {
            if (args.Length == 1 && args[0] == "--seat")
            {
                Console.WriteLine("ready");
                return Console.ReadLine() == null ? 0 : 2;
            }
            if (args.Length != 1) throw new ArgumentException("private fixture source directory required");
            using (var host = new ServerHost())
            {
                const BindingFlags fields = BindingFlags.Instance | BindingFlags.NonPublic;
                var lifetime = typeof(ServerHost).GetField("lifetime", fields).GetValue(host);
                var job = (IntPtr)typeof(DesktopLifetimeHost).GetField("job", fields).GetValue(lifetime);
                Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
                int size = Marshal.SizeOf(typeof(Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION)), returned;
                if (!QueryInformationJobObject(job, 9, out limits, size, out returned)) throw new Win32Exception();
                const uint activeProcess = 8; // JOB_OBJECT_LIMIT_ACTIVE_PROCESS
                uint flags = limits.BasicLimitInformation.LimitFlags;
                if ((flags & Native.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) == 0 || (flags & activeProcess) != 0)
                    throw new InvalidOperationException("unexpected initial Job limits");
                limits.BasicLimitInformation.LimitFlags |= activeProcess;
                limits.BasicLimitInformation.ActiveProcessLimit = 1;
                if (!Native.SetInformationJobObject(job, 9, ref limits, size)) throw new Win32Exception();
                if (!QueryInformationJobObject(job, 9, out limits, size, out returned)) throw new Win32Exception();
                if (limits.BasicLimitInformation.LimitFlags != (flags | activeProcess) || limits.BasicLimitInformation.ActiveProcessLimit != 1)
                    throw new InvalidOperationException("Job quota did not take effect");
                var start = new ProcessStartInfo(Assembly.GetExecutingAssembly().Location, "--seat") {
                    UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true
                };
                using (var seat = Process.Start(start))
                {
                    bool retained = false;
                    Process serve = null;
                    string serveBirth = null;
                    string seatBirth = null;
                    try
                    {
                        seatBirth = seat.StartTime.ToFileTimeUtc().ToString();
                        if (seat.StandardOutput.ReadLine() != "ready") throw new IOException("seat did not start");
                        if (!Native.AssignProcessToJobObject(job, seat.Handle)) throw new Win32Exception();
                        bool member;
                        if (!IsProcessInJob(seat.Handle, job, out member) || !member)
                            throw new InvalidOperationException("seat absent from the product Job");
                        Write(new { phase = "quota-occupied", pid = seat.Id, created = seatBirth, processLimit = limits.BasicLimitInformation.ActiveProcessLimit, member });
                        host.Observed += delegate(string line) {
                            Console.WriteLine(line);
                            var evt = json.Deserialize<Dictionary<string, object>>(line);
                            if ((string)evt["phase"] != "created-suspended") return;
                            serve = Process.GetProcessById((int)evt["pid"]);
                            IntPtr held = serve.Handle;
                            serveBirth = serve.StartTime.ToFileTimeUtc().ToString();
                            bool assigned;
                            if (!IsProcessInJob(held, job, out assigned)) throw new Win32Exception();
                            var threads = serve.Threads;
                            var first = threads.Count == 1 ? threads[0] : null;
                            Write(new { phase = "original-held", pid = serve.Id, created = serveBirth, assigned,
                                threads = threads.Count, wait = first == null || first.ThreadState != ThreadState.Wait ? null : first.WaitReason.ToString() });
                        };
                        try
                        {
                            bool started = host.Start(args[0]);
                            if (started) throw new InvalidOperationException("unexpected host startup");
                            retained = true;
                        }
                        catch (Win32Exception error)
                        {
                            Write(new { phase = "startup-error", nativeCode = error.NativeErrorCode });
                        }
                        if (!retained)
                        {
                            if (serve == null || !serve.WaitForExit(5000)) throw new InvalidOperationException("original serve exit unknown");
                            Write(new { phase = "original-exited", pid = serve.Id, created = serveBirth, code = serve.ExitCode });
                        }
                        if (seat.HasExited) throw new InvalidOperationException("the occupied seat exited during assignment");
                    }
                    finally
                    {
                        seat.StandardInput.Close();
                        if (!seat.WaitForExit(5000)) throw new InvalidOperationException("original seat exit unknown");
                        Write(new { phase = "seat-exited", pid = seat.Id, created = seatBirth, code = seat.ExitCode });
                        if (retained)
                        {
                            Write(new { phase = "retained" });
                            System.Threading.Thread.Sleep(System.Threading.Timeout.Infinite);
                        }
                        if (serve != null) serve.Dispose();
                    }
                }
            }
            return 0;
        }
    }
}
