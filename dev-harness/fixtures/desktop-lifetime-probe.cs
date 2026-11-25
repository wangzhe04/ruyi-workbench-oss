// Acceptance entry for the actual production ServerHost/ShellForm, never a mock job.
// A failed close deliberately retains this owner; the harness must keep the scene.
using System;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
namespace RuyiDesktop
{
    internal static class DesktopLifetimeProbe
    {
        private static readonly object output = new object();
        private static void Write(object value) { lock(output)Console.WriteLine(new JavaScriptSerializer().Serialize(value)); }
        private static void Retain() { Write(new { schema=1,phase="retained" });Thread.Sleep(Timeout.Infinite); }
        [STAThread] private static void Main(string[] args)
        {
            if(args.Length<1||args.Length>2)throw new ArgumentException("mode");
            string mode=args.Length==2?args[1]:"idle";
            if(mode!="idle"&&mode!="window"&&mode!="nested-job"&&mode!="outer-quota")throw new ArgumentException("mode");
            var outer=(mode=="nested-job"||mode=="outer-quota")?new DesktopNestedJob(mode=="outer-quota",Write):null;
            var server=new ServerHost();server.Observed+=delegate(string value){lock(output)Console.WriteLine(value);};
            if(outer!=null)server.Observed+=outer.Observe;
            bool window=mode=="window";var ready=new ManualResetEvent(false);var complete=new ManualResetEvent(false);ShellForm form=null;
            server.UrlReady+=delegate(string url){Write(new { schema=1,phase="ready",url=url });ready.Set();if(form!=null)form.BeginInvoke((Action)delegate{form.OnServerUrl(url);});};
            server.Exited+=delegate(int code){Write(new { schema=1,phase="unexpected-exit",code=code });};
            if(window){Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);form=new ShellForm(server);IntPtr created=form.Handle;form.Shown+=delegate{Write(new { schema=1,phase="window-shown" });};}
            try { if(!server.Start(args[0])){Retain();return;} }
            catch(System.ComponentModel.Win32Exception ex)
            {
                if(mode!="outer-quota")throw;
                Write(new {phase="startup-denied",nativeCode=ex.NativeErrorCode});
                outer.Finish();server.Dispose();outer.Dispose();return;
            }
            ThreadPool.QueueUserWorkItem(delegate{
                if(!ready.WaitOne(45000)){Retain();return;}
                if(Console.ReadLine()!="close"){Retain();return;}
                if(window){form.BeginInvoke((Action)delegate{form.Close();});return;}
                bool closed=server.StopAsync().GetAwaiter().GetResult();if(!closed){Retain();return;}
                server.Dispose();Write(new { schema=1,phase="probe-complete" });complete.Set();
            });
            if(window){Application.Run(form);server.Dispose();Write(new { schema=1,phase="probe-complete" });}
            else complete.WaitOne();
            if(outer!=null){outer.Finish();outer.Dispose();}
        }
    }
}
