using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Web.Script.Serialization;

namespace RuyiDesktop
{
    // This console fixture puts only itself in an unnamed outer Job. The test
    // observes its members while the handle is open, without terminating the Job.
    internal sealed class DesktopNestedJob : IDisposable
    {
        private readonly IntPtr job;
        private readonly Action<object> write;
        private Process serve;
        private string birth;

        [StructLayout(LayoutKind.Sequential)]
        private struct Accounting
        {
            public long User, Kernel, PeriodUser, PeriodKernel;
            public uint Faults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
        }
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, int size, out int used);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        public DesktopNestedJob(bool limitChildren, Action<object> writer)
        {
            write = writer;
            job = Native.CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new Win32Exception();
            using (var self = Process.GetCurrentProcess())
            {
                if (!Native.AssignProcessToJobObject(job, self.Handle)) throw new Win32Exception();
                if (limitChildren)
                {
                    var limits = new Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                    limits.BasicLimitInformation.LimitFlags = 8; // JOB_OBJECT_LIMIT_ACTIVE_PROCESS
                    limits.BasicLimitInformation.ActiveProcessLimit = 1;
                    if (!Native.SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(limits))) throw new Win32Exception();
                }
                write(new { phase = "outer-owner", pid = self.Id, processLimit = limitChildren ? 1 : 0, member = Member(self) });
            }
        }

        private bool Member(Process process)
        {
            bool member;
            if (!IsProcessInJob(process.Handle, job, out member)) throw new Win32Exception();
            return member;
        }
        public void Observe(string json)
        {
            var evt = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(json);
            if ((string)evt["phase"] != "created-suspended") return;
            serve = Process.GetProcessById((int)evt["pid"]);
            bool member = Member(serve); // Opens and holds the handle across production startup and cleanup.
            birth = serve.StartTime.ToFileTimeUtc().ToString();
            write(new { phase = "outer-serve", pid = serve.Id, created = birth, member = member });
        }
        public void Finish()
        {
            if (serve != null && !serve.WaitForExit(5000)) throw new InvalidOperationException("original serve exit unknown");
            Accounting info; int used;
            if (!QueryInformationJobObject(job, 1, out info, Marshal.SizeOf(typeof(Accounting)), out used))
                throw new Win32Exception();
            write(new { phase = "outer-drained", pid = serve == null ? 0 : serve.Id, created = birth, code = serve == null ? (int?)null : serve.ExitCode,
                total = info.TotalProcesses, active = info.ActiveProcesses });
        }
        public void Dispose()
        {
            if (serve != null) serve.Dispose();
            if (!CloseHandle(job)) throw new Win32Exception();
        }
    }
}
