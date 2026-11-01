// Desktop-owned process lifetime. C# 5 / .NET Framework; no process-launch RPC.
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

namespace RuyiDesktop
{
    internal sealed class DesktopLifetimeHost : IDisposable
    {
        private const int Limit = 8192;
        private readonly object sync = new object();
        private readonly Dictionary<string, Grant> grants = new Dictionary<string, Grant>();
        private readonly IntPtr job;
        private readonly List<Client> clients = new List<Client>();
        private Client current;
        private Process original;
        private IntPtr startupHeldProcess, startupHeldThread;
        private bool disposed, closing, uncertain, closeDeferred;
        private readonly Stopwatch closeClock = new Stopwatch();
        private int outputClosed;
        private bool failureDiagnosticObserved, nodeDiagnosticObserved;
        private int lastCloseMembersCount=-1;
        private bool lastCloseMembersContainsCurrent;
        private long lastCloseMembersElapsedMilliseconds;
        private TaskCompletionSource<bool> stopped;
        public event Action<string> UrlReady;
        public event Action<int> Exited;
        public event Action<string> ErrorLine;
        // Optional bounded metadata observer for acceptance harnesses; never a command channel.
        public event Action<string> Observed;
        private sealed class Grant { internal string Cap, Role, Parent, Id, Nonce, PipeName; internal NamedPipeServerStream Endpoint; internal Client Client; }
        private sealed class Client
        {
            internal Grant Grant; internal int Pid, Sequence; internal IntPtr Handle;
            internal NamedPipeServerStream Pipe; internal StreamWriter Writer;
            internal string Url; internal bool Finished, Exited, ChannelClosed;
            internal long Created;
        }
        public DesktopLifetimeHost()
        {
            job = Native.CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new Win32Exception();
            var info = new Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = Native.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if (!Native.SetInformationJobObject(job, 9, ref info, Marshal.SizeOf(typeof(Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
            { int error = Marshal.GetLastWin32Error(); CloseHandle(job); throw new Win32Exception(error); }
        }
        private static string RandomHex()
        {
            byte[] bytes = new byte[32]; using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(bytes);
            return BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant();
        }
        private static bool Hex(string value, int length)
        {
            if (value == null || value.Length != length) return false;
            foreach (char c in value) if (!(c >= '0' && c <= '9' || c >= 'a' && c <= 'f')) return false;
            return true;
        }
        private static bool Shape(Dictionary<string, object> value, params string[] keys)
        { if (value == null || value.Count != keys.Length) return false; foreach (string key in keys) if (!value.ContainsKey(key)) return false; return true; }
        private static string Text(Dictionary<string, object> value, string key) { object item; return value.TryGetValue(key, out item) ? item as string : null; }
        private static int Number(Dictionary<string, object> value, string key)
        { object item; return value.TryGetValue(key, out item) && item is int ? (int)item : -1; }
        private static string ReadFrame(StreamReader reader)
        {
            var frame = new StringBuilder();
            while (frame.Length <= Limit) { int next = reader.Read(); if (next == -1) throw new EndOfStreamException(); if (next == 10) return frame.ToString(); if (next == 13) throw new IOException("protocol"); frame.Append((char)next); }
            throw new IOException("frame budget");
        }
        private static void Write(Client client, object message)
        { lock (client) { client.Writer.WriteLine(new JavaScriptSerializer().Serialize(message)); client.Writer.Flush(); } }
        private static void Reply(Client client, int sequence, Grant grant)
        {
            var message = new Dictionary<string, object> { { "schema", 1 }, { "seq", sequence }, { "kind", "ok" } };
            if (grant != null) { message.Add("cap", grant.Cap);message.Add("pipe",grant.PipeName); } Write(client, message);
        }
        private void Failed(string stage = "unspecified", Exception error = null)
        { lock (sync) { uncertain = true; Observe("uncertain", current); ObserveFailureDiagnostic(stage,error); if (stopped != null) stopped.TrySetResult(false); } }
        private void Observe(string phase, Client client)
        {
            var handler=Observed;if(handler==null)return;
            try{handler(new JavaScriptSerializer().Serialize(new { schema=1,phase=phase,pid=client==null?0:client.Pid,role=client==null?null:client.Grant.Role,created=client==null?null:client.Created.ToString() }));}
            catch{ /* Observation cannot grant or revoke lifetime authority. */ }
        }
        // Observe only original failures and already-returned Members samples; never query a new handle.
        private static bool DiagnosticAllowed(string value,string words)
        { return value!=null&&("|"+words+"|").IndexOf("|"+value+"|",StringComparison.Ordinal)>=0; }
        private void ObserveFailureDiagnostic(string stage,Exception error)
        {
            if(failureDiagnosticObserved)return;failureDiagnosticObserved=true;
            try
            {
                string reason="unclassified",name=error==null?"unknown":error is Win32Exception?"Win32Exception":error is IOException?"IOException":"Exception";
                if(error is Win32Exception)reason="win32";
                else if(error!=null)switch(error.Message)
                {
                    case "children remain":reason="children_remain";break;case "job census":reason="job_census";break;
                    case "sequence":reason="sequence";break;case "protocol":reason="protocol";break;case "hello":reason="hello";break;
                    case "client identity":reason="client_identity";break;case "job identity":reason="job_identity";break;
                    case "capability":reason="capability";break;case "duplicate root":reason="duplicate_root";break;
                    case "frame budget":reason="frame_budget";break;case "role":reason="role";break;
                    case "transfer":reason="transfer";break;case "listener":reason="listener";break;
                }
                if(!DiagnosticAllowed(stage,"unspecified|grant-accept|wait-exit|hello|read-request|request|members|reply-finished|client-exited|complete-members|stop-send|stop-timeout|startup|output-read|dispose-members|dispose-job"))stage="unspecified";
                var handler=Observed;if(handler!=null)handler(new JavaScriptSerializer().Serialize(new {schema=1,phase="close-failure-diagnostic",origin="csharp",stage=stage,reason=reason,name=name,nativeCode=error is Win32Exception?(int?)((Win32Exception)error).NativeErrorCode:null,membersCount=lastCloseMembersCount<0?(int?)null:lastCloseMembersCount,membersContainsCurrent=lastCloseMembersCount<0?(bool?)null:lastCloseMembersContainsCurrent,membersElapsedMs=lastCloseMembersCount<0?(long?)null:lastCloseMembersElapsedMilliseconds}));
            }
            catch{ /* Diagnostic output cannot change unknown/retained behavior. */ }
        }
        private void ObserveNodeDiagnostic(string line)
        {
            if(line==null||line.Length>512||!line.StartsWith("RUYI_DESKTOP_DIAG_V1 ",StringComparison.Ordinal))return;
            try
            {
                var match=System.Text.RegularExpressions.Regex.Match(line,@"^RUYI_DESKTOP_DIAG_V1 stage=([a-z-]{1,32}) reason=([a-z_.]{1,80}) name=(Error|TypeError|RangeError|SyntaxError|AbortError|TimeoutError|unknown) kind=(close|finished|deferred) seq=([0-9]{1,10})$");
                int sequence;if(!match.Success||!Int32.TryParse(match.Groups[5].Value,out sequence)||sequence<0)return;
                string stage=match.Groups[1].Value,reason=match.Groups[2].Value;
                if(!DiagnosticAllowed(stage,"setup|begin|cancel|infrastructure|settlers|first-idle|first-helper-check|http-close|second-idle|second-helper-check|retire|retired|finished-request|deferred-request")||!DiagnosticAllowed(reason,"unclassified|desktop_lifetime.uncertain|desktop_lifetime.helper_uncertain|desktop_lifetime.listener_changed|desktop_lifetime.channel_unavailable|desktop_lifetime.response_timeout|desktop_lifetime.owner_refused|desktop_lifetime.protocol|desktop_lifetime.channel_closed|desktop_lifetime.exit_returned|work_data.maintenance_busy|work_data.maintenance_nested|work_data.maintenance_cancelled|work_data.maintenance_stale_continuation|work_data.maintenance_owner_unavailable|work_data.maintenance_lease_expired|work_data.maintenance_not_idle|work_data.maintenance_infrastructure_unavailable|work_data.maintenance_infrastructure_uncertain"))return;
                lock(sync)
                {
                    if(nodeDiagnosticObserved)return;nodeDiagnosticObserved=true;
                    var handler=Observed;if(handler!=null)handler(new JavaScriptSerializer().Serialize(new {schema=1,phase="node-close-diagnostic",origin="node",stage=stage,reason=reason,name=match.Groups[3].Value,kind=match.Groups[4].Value,seq=sequence}));
                }
            }
            catch{ /* Unrecognized or unavailable diagnostic output is ignored. */ }
        }
        private Grant CreateGrant(string role, string parent, string id, string nonce)
        {
            if(grants.Count>=64)throw new IOException("endpoint budget");
            var grant=new Grant{Cap=RandomHex(),Role=role,Parent=parent,Id=id,Nonce=nonce,PipeName="ruyi-desktop-"+RandomHex()};
            var security=new PipeSecurity();SecurityIdentifier owner=WindowsIdentity.GetCurrent().User;
            security.SetOwner(owner);security.SetAccessRuleProtection(true,false);
            // libuv opens with GENERIC_WRITE, whose pipe mapping includes
            // CreateNewInstance. Exclusivity comes from FIRST_PIPE_INSTANCE plus
            // maxInstances=1, not from granting the client FullControl.
            security.AddAccessRule(new PipeAccessRule(owner,PipeAccessRights.ReadWrite|PipeAccessRights.Synchronize|PipeAccessRights.CreateNewInstance,AccessControlType.Allow));
            byte[] descriptor=security.GetSecurityDescriptorBinaryForm();IntPtr memory=Marshal.AllocHGlobal(descriptor.Length);
            try
            {
                Marshal.Copy(descriptor,0,memory,descriptor.Length);
                var attributes=new SECURITY_ATTRIBUTES{Length=Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)),Descriptor=memory,Inherit=false};
                // Create the sole instance before returning any descriptor. Never
                // reopen this name, even after an invalid first connection.
                SafePipeHandle handle=CreateNamedPipe(@"\\.\pipe\"+grant.PipeName,0x00000003|0x40000000|0x00080000,0,1,Limit,Limit,0,ref attributes);
                if(handle.IsInvalid){int error=Marshal.GetLastWin32Error();handle.Dispose();throw new Win32Exception(error);}
                try{grant.Endpoint=new NamedPipeServerStream(PipeDirection.InOut,true,false,handle);}catch{handle.Dispose();throw;}
            }
            finally{Marshal.FreeHGlobal(memory);}
            grants.Add(grant.Cap,grant);
            if(!ThreadPool.QueueUserWorkItem(delegate{Accept(grant);}))throw new IOException("endpoint listener unavailable");
            return grant;
        }
        private void Accept(Grant grant)
        {
            try{grant.Endpoint.WaitForConnection();Serve(grant);}
            catch(Exception error){lock(sync){if(!disposed)Failed("grant-accept",error);}}
            // An unregistered connection is uncertain. Keep its exact endpoint
            // reserved so a delayed legitimate client can never reach a replacement.
        }
        private void SendClose(Client client)
        { if (client != null && client.Url != null && client.Grant.Role != "cold") {closeDeferred=false;closeClock.Restart();Write(client, new { schema = 1, seq = 0, kind = "close" });} }
        private void Serve(Grant grant)
        {
            NamedPipeServerStream pipe=grant.Endpoint;
            Client client = null; string diagnosticStage="hello";
            try
            {
                var reader = new StreamReader(pipe, new UTF8Encoding(false, true), false, 1024, true);
                var writer = new StreamWriter(pipe, new UTF8Encoding(false), 1024, true); writer.NewLine = "\n";
                var codec = new JavaScriptSerializer(); codec.MaxJsonLength = Limit; codec.RecursionLimit = 8;
                var hello = codec.Deserialize<Dictionary<string, object>>(ReadFrame(reader));
                if (!Shape(hello, "schema", "seq", "kind", "cap", "pid") || Number(hello, "schema") != 1 || Number(hello, "seq") != 1 || Text(hello, "kind") != "hello") throw new IOException("hello");
                uint actual; if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle, out actual) || actual != Number(hello, "pid")) throw new IOException("client identity");
                IntPtr handle = OpenProcess(0x00100000 | 0x1000, false, actual); if (handle == IntPtr.Zero) throw new Win32Exception();
                bool member; FILETIME created, exited, kernel, user;
                if (!IsProcessInJob(handle, job, out member) || !member || !GetProcessTimes(handle, out created, out exited, out kernel, out user)) { CloseHandle(handle); throw new IOException("job identity"); }
                lock (sync)
                {
                    if (disposed || uncertain || Text(hello,"cap")!=grant.Cap || !grants.ContainsKey(grant.Cap) || grant.Client != null)
                    { CloseHandle(handle); throw new IOException("capability"); }
                    client = new Client { Grant = grant, Pid = (int)actual, Handle = handle, Pipe = pipe, Writer = writer, Sequence = 1,Created=((long)created.High<<32)|created.Low };
                    grant.Client = client; clients.Add(client);
                    if (grant.Role == "serve") { if (current != null) throw new IOException("duplicate root"); current = client; }
                    Client observed = client;
                    ThreadPool.QueueUserWorkItem(delegate {
                        uint code;
                        if(WaitForSingleObject(observed.Handle,0xffffffff)!=0||!GetExitCodeProcess(observed.Handle,out code)){Failed("wait-exit");return;}
                        ClientExited(observed,unchecked((int)code));
                    });
                    Observe("registered",client);
                    Reply(client, 1, null);
                    if(client==current)Write(client,new {schema=1,seq=0,kind="active"});
                }
                while (true)
                {
                    diagnosticStage="read-request";
                    var request = codec.Deserialize<Dictionary<string, object>>(ReadFrame(reader));
                    lock (sync)
                    {
                        diagnosticStage="request";
                        if (disposed || uncertain || Number(request, "schema") != 1 || Number(request, "seq") != client.Sequence + 1) throw new IOException("sequence");
                        client.Sequence++; string kind = Text(request, "kind");
                        if (kind == "issue" && client == current && Shape(request, "schema", "seq", "kind", "role", "id", "nonce"))
                        {
                            string role = Text(request, "role"), id = Text(request, "id"), nonce = Text(request, "nonce");
                            if (!(role == "cold" && (client.Grant.Role == "serve" || client.Grant.Role == "successor") || role == "successor" && client.Grant.Role == "cold") || !Hex(id, 48) || !Hex(nonce, 64)) throw new IOException("role");
                            var issued=CreateGrant(role,client.Grant.Cap,id,nonce);Reply(client,client.Sequence,issued);
                        }
                        else if (kind == "transfer" && client == current && Shape(request, "schema", "seq", "kind", "cap"))
                        {
                            Grant target; if (!grants.TryGetValue(Text(request, "cap") ?? "", out target) || target.Parent != client.Grant.Cap || target.Client == null || target.Client.Finished || WaitForSingleObject(target.Client.Handle,0)!=258) throw new IOException("transfer");
                            current = target.Client; Reply(client, client.Sequence, null);
                            closeDeferred=current.Grant.Role=="cold";
                            Write(current,new {schema=1,seq=0,kind="active"});
                            Observe("transferred",current);
                            if (current.Url != null) Publish(current); if (closing) SendClose(current);
                        }
                        else if (kind == "serving" && client.Grant.Role != "cold" && Shape(request, "schema", "seq", "kind", "host", "port"))
                        {
                            string host = Text(request, "host"); int port = Number(request, "port");
                            if (!(host == "127.0.0.1" || host == "localhost" || host == "::1") || port < 1 || port > 65535 || client.Url != null) throw new IOException("listener");
                            client.Url = "http://" + (host == "::1" ? "[::1]" : host) + ":" + port + "/";
                            Observe("serving",client);Reply(client, client.Sequence, null); if (client == current) { Publish(client); if (closing) SendClose(client); }
                        }
                        else if(kind=="deferred"&&closing&&Shape(request,"schema","seq","kind"))
                        {if(client==current)closeDeferred=true;Reply(client,client.Sequence,null);}
                        else if(kind=="uncertain"&&Shape(request,"schema","seq","kind"))
                        {Reply(client,client.Sequence,null);Failed("request");}
                        else if (kind == "finished" && client == current && closing && Shape(request, "schema", "seq", "kind"))
                        {
                            var deadline=Stopwatch.StartNew();
                            diagnosticStage="members";
                            while(true){int[] members=Members();lastCloseMembersCount=members.Length;lastCloseMembersContainsCurrent=Array.IndexOf(members,client.Pid)>=0;lastCloseMembersElapsedMilliseconds=deadline.ElapsedMilliseconds;if(members.Length==1&&members[0]==client.Pid)break;if(deadline.ElapsedMilliseconds>=12000)throw new IOException("children remain");Thread.Sleep(25);}
                            diagnosticStage="reply-finished";
                            client.Finished = true; Observe("finished",client);Reply(client, client.Sequence, null);
                        }
                        else throw new IOException("protocol");
                    }
                }
            }
            catch (Exception error) { lock (sync) { if (!disposed && (client == null || !client.Finished && client == current)) Failed(diagnosticStage,error); } }
            finally { if (client != null) lock(sync){client.ChannelClosed=true;Observe("channel-closed",client);TryComplete();RetireClient(client);} }
        }
        private void Publish(Client client) { var handler = UrlReady; if (handler != null) handler(client.Url); }
        private void ClientExited(Client client,int code)
        {
            lock (sync)
            {
                client.Exited=true;Observe("exited",client);
                if (client != current) { RetireClient(client);return; }
                if (!closing || !client.Finished) { Failed("client-exited"); var handler = Exited; if (handler != null) handler(code); return; }
            }
            lock(sync)TryComplete();
        }
        private void TryComplete()
        {
            if(uncertain||stopped==null||current==null||!current.Finished||!current.Exited||!current.ChannelClosed||outputClosed!=2)return;
            try{if(Members().Length!=0)return;Observe("normal-closed",current);stopped.TrySetResult(true);}catch(Exception error){Failed("complete-members",error);}
        }
        private void RetireClient(Client client)
        {
            if(client==current||!client.Exited||!client.ChannelClosed||client.Handle==IntPtr.Zero)return;
            client.Pipe.Dispose();CloseHandle(client.Handle);client.Handle=IntPtr.Zero;clients.Remove(client);grants.Remove(client.Grant.Cap);
        }
        private int[] Members()
        {
            IntPtr buffer = Marshal.AllocHGlobal(8 + IntPtr.Size * 4096);
            try
            {
                int returned; if (!QueryInformationJobObject(job, 3, buffer, 8 + IntPtr.Size * 4096, out returned)) throw new Win32Exception();
                int assigned = Marshal.ReadInt32(buffer, 0), count = Marshal.ReadInt32(buffer, 4);
                if (count < 0 || count > 4096 || count != assigned) throw new IOException("job census");
                var values = new int[count]; for (int i = 0; i < count; i++) values[i] = checked((int)Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size).ToInt64()); return values;
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }
        public bool Running { get { lock (sync) { return !disposed&&(current == null ? original != null && !original.HasExited : WaitForSingleObject(current.Handle,0)==258); } } }
        public async Task<bool> StopAsync()
        {
            Task<bool> pending;
            lock (sync)
            {
                if (uncertain || disposed) return false;
                if(current==null&&original==null&&Members().Length==0)return true;
                if (stopped == null) { stopped = new TaskCompletionSource<bool>(); closing = true;closeClock.Restart(); try { SendClose(current); } catch (Exception error) { Failed("stop-send",error); } }
                pending = stopped.Task;
            }
            while(true)
            {
                if(await Task.WhenAny(pending,Task.Delay(1000))==pending)return await pending;
                lock(sync)
                {
                    // A committed operation keeps its original maintenance budgets.
                    // Closing must not turn a valid long backup into a failed takeover.
                    if(closeDeferred||current!=null&&current.Grant.Role=="cold")closeClock.Restart();
                    else if(closeClock.ElapsedMilliseconds>=60000){Failed("stop-timeout");return false;}
                }
            }
        }
        public bool Start(string baseDir, string explicitRoot)
        {
            Grant grant;lock(sync){grant=CreateGrant("serve",null,null,null);}
            var env = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (DictionaryEntry row in Environment.GetEnvironmentVariables()) env[(string)row.Key] = (string)row.Value;
            // No preloader may run before 00-boot consumes the private capability.
            env.Remove("NODE_OPTIONS");env.Remove("NODE_PATH");env.Remove("NODE_DEBUG");env.Remove("NODE_DEBUG_NATIVE");
            if (explicitRoot != null) env["RUYI_HOME"] = explicitRoot;
            env["RUYI_DESKTOP_CONTROL_V1"] = new JavaScriptSerializer().Serialize(new { schema = 1, pipe = grant.PipeName, cap = grant.Cap, role = grant.Role });
            var environment = new StringBuilder(); foreach (var row in env) environment.Append(row.Key).Append('=').Append(row.Value).Append('\0'); environment.Append('\0');
            string bundled = Path.Combine(baseDir, @"runtime\node\node.exe"), node = File.Exists(bundled) ? bundled : "node", script = Path.Combine(baseDir, @"app\server.js");
            if (!File.Exists(script)) throw new FileNotFoundException("找不到 app\\server.js —— 请从完整安装包运行。", script);
            // Start remains suspended until the one outer job accepts the actual process handle.
            IntPtr outputRead = IntPtr.Zero, outputWrite = IntPtr.Zero, errorRead = IntPtr.Zero, errorWrite = IntPtr.Zero, input = IntPtr.Zero;
            var attributes = new SECURITY_ATTRIBUTES { Length = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), Inherit = true };
            PROCESS_INFORMATION created = new PROCESS_INFORMATION();
            Client startupWitness=null;
            try
            {
                if (!CreatePipe(out outputRead, out outputWrite, ref attributes, 0) || !CreatePipe(out errorRead, out errorWrite, ref attributes, 0)
                    || !SetHandleInformation(outputRead, 1, 0) || !SetHandleInformation(errorRead, 1, 0)) throw new Win32Exception();
                input = CreateFile("NUL", 0x80000000, 3, ref attributes, 3, 0, IntPtr.Zero); if (input == new IntPtr(-1)) throw new Win32Exception();
                var startup = new STARTUPINFO { Size = Marshal.SizeOf(typeof(STARTUPINFO)), Flags = 0x100, Input = input, Output = outputWrite, Error = errorWrite };
                if (!CreateProcess(null, new StringBuilder(Quote(node) + " " + Quote(script) + " serve"), IntPtr.Zero, IntPtr.Zero, true,
                    0x00000004 | 0x00000400 | 0x00000008, environment.ToString(), baseDir, ref startup, out created)) throw new Win32Exception();
                FILETIME born,ended,kernel,user;if(!GetProcessTimes(created.Process,out born,out ended,out kernel,out user))throw new Win32Exception();
                startupWitness=new Client{Pid=(int)created.Pid,Created=((long)born.High<<32)|born.Low,Grant=grant};Observe("created-suspended",startupWitness);
                if (!Native.AssignProcessToJobObject(job, created.Process)) throw new Win32Exception();
                Observe("assigned-before-resume",startupWitness);
                original = Process.GetProcessById((int)created.Pid);
                original.Exited += delegate { lock (sync) { if (current == null) { Failed("startup"); var handler = Exited; if (handler != null) handler(original.ExitCode); } } };
                original.EnableRaisingEvents = true;
                if (ResumeThread(created.Thread) != 1) throw new IOException("desktop resume state invalid");Observe("resumed",startupWitness);
                IntPtr stdout = outputRead, stderr = errorRead; outputRead = errorRead = IntPtr.Zero;
                ReadOutput(stdout, false); ReadOutput(stderr, true);
                return true;
            }
            catch
            {
                if (created.Process != IntPtr.Zero)TerminateProcess(created.Process,1);
                if (created.Process != IntPtr.Zero && WaitForSingleObject(created.Process,5000)!=0)
                {
                    // An unassigned suspended process must not be orphaned by returning
                    // from Main after an unproved cleanup. Keep its exact handles and UI.
                    startupHeldProcess=created.Process;startupHeldThread=created.Thread;
                    created.Process=created.Thread=IntPtr.Zero;Failed("startup");Observe("startup-retained",startupWitness);return false;
                }
                if(created.Process!=IntPtr.Zero)Observe("startup-cleaned",startupWitness);
                throw;
            }
            finally
            {
                foreach (IntPtr handle in new[] { outputRead, outputWrite, errorRead, errorWrite, input, created.Thread, created.Process }) if (handle != IntPtr.Zero && handle != new IntPtr(-1)) CloseHandle(handle);
            }
        }
        private static string Quote(string value) { if (value.IndexOfAny(new[] { '"', '\r', '\n', '\0' }) >= 0) throw new IOException("argument"); return "\"" + value + "\""; }
        private void ReadOutput(IntPtr handle, bool error)
        {
            ThreadPool.QueueUserWorkItem(delegate {
                try { using (var stream = new FileStream(new SafeFileHandle(handle, true), FileAccess.Read)) using (var reader = new StreamReader(stream, Encoding.UTF8))
                    { string line; while ((line = reader.ReadLine()) != null) { if (error) { ObserveNodeDiagnostic(line); var handler = ErrorLine; if (handler != null) handler(line); } } } }
                catch (Exception failure) { lock (sync) { if (!disposed) Failed("output-read",failure); } }
                finally { lock(sync){outputClosed++;Observe(error?"stderr-closed":"stdout-closed",null);TryComplete();} }
            });
        }
        public void Dispose()
        {
            lock (sync)
            {
                if (disposed) return;
                if(startupHeldProcess!=IntPtr.Zero||startupHeldThread!=IntPtr.Zero)return;
                // No forced shutdown is disguised as a normal close. OS process death
                // still owns KILL_ON_JOB_CLOSE on a crash or explicit force termination.
                try{if (Members().Length != 0) return;}catch(Exception error){Failed("dispose-members",error);return;}
                disposed = true;
                foreach(Grant grant in grants.Values)grant.Endpoint.Dispose();
                foreach (Client client in clients) { if (client.Handle != IntPtr.Zero) CloseHandle(client.Handle); }
                if (original != null) original.Dispose(); if(!CloseHandle(job)){Failed("dispose-job");return;}Observe("job-closed",current);
            }
        }
        [StructLayout(LayoutKind.Sequential)] private struct SECURITY_ATTRIBUTES { internal int Length; internal IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] internal bool Inherit; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct STARTUPINFO { internal int Size; internal string Reserved, Desktop, Title; internal int X, Y, XSize, YSize, XCount, YCount, Fill, Flags; internal short Show, ReservedSize; internal IntPtr Reserved2, Input, Output, Error; }
        [StructLayout(LayoutKind.Sequential)] private struct PROCESS_INFORMATION { internal IntPtr Process, Thread; internal uint Pid, Tid; }
        [StructLayout(LayoutKind.Sequential)] private struct FILETIME { internal uint Low, High; }
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint pid);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern SafePipeHandle CreateNamedPipe(string name,int openMode,int pipeMode,int maxInstances,int outputSize,int inputSize,int timeout,ref SECURITY_ATTRIBUTES attributes);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetProcessTimes(IntPtr process, out FILETIME created, out FILETIME exited, out FILETIME kernel, out FILETIME user);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr process,out uint code);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr buffer, int size, out int returned);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SECURITY_ATTRIBUTES attributes, int size);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateFile(string path, uint access, uint share, ref SECURITY_ATTRIBUTES attributes, uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateProcess(string app, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, string environment, string cwd, ref STARTUPINFO startup, out PROCESS_INFORMATION created);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateProcess(IntPtr process, uint code);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    }
}
