using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace SingularitySetup
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            string mode = "Install";
            bool silent = false;
            foreach (string raw in args)
            {
                string a = (raw ?? string.Empty).Trim().ToLowerInvariant();
                if (a == "--uninstall" || a == "/uninstall") mode = "Uninstall";
                else if (a == "--repair" || a == "/repair") mode = "Repair";
                else if (a == "--verify" || a == "/verify") mode = "Verify";
                else if (a == "--silent" || a == "/silent") silent = true;
                else if (a == "--help" || a == "/?")
                {
                    MessageBox.Show("Singularity RepoQL Setup\n\nSingularity-RepoQL-Setup.exe [--repair|--uninstall|--verify|--silent]\n\nInstalls or repairs the per-user native product, starts its owned tasks,\nprovisions the local Tencent MemoryCore owner identity, configures Claude Code,\nand verifies the automatic dashboard MemoryPanel session.", "Singularity RepoQL Setup");
                    return 0;
                }
            }
            if (silent)
            {
                using (var runner = new SetupRunner(mode))
                {
                    return runner.RunSilent();
                }
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new SetupForm(mode));
            return 0;
        }
    }

    internal sealed class SetupRunner : IDisposable
    {
        private const string ResourceName = "Payload.zip";
        private readonly string _mode;
        private readonly string _logPath;
        private readonly StringBuilder _log = new StringBuilder();
        private string _payloadRoot;
        private Process _process;

        public SetupRunner(string mode)
        {
            _mode = mode;
            string setupState = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Singularity", "SetupLogs");
            Directory.CreateDirectory(setupState);
            _logPath = Path.Combine(setupState, "setup-" + DateTime.UtcNow.ToString("yyyyMMddTHHmmssZ") + ".log");
        }

        public string LogPath { get { return _logPath; } }
        public string PayloadRoot { get { return _payloadRoot; } }
        public event Action<string> LineReceived;

        public void Append(string line)
        {
            if (line == null) return;
            _log.AppendLine(line);
            try { File.AppendAllText(_logPath, line + Environment.NewLine, new UTF8Encoding(false)); } catch { }
            Action<string> handler = LineReceived;
            if (handler != null) handler(line);
        }

        public string PreparePayload()
        {
            if (_payloadRoot != null) return _payloadRoot;
            string cacheRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Singularity", "S");
            Directory.CreateDirectory(cacheRoot);
            string tempZip = Path.Combine(cacheRoot, "payload-" + Guid.NewGuid().ToString("N") + ".zip");
            using (Stream resource = Assembly.GetExecutingAssembly().GetManifestResourceStream(ResourceName))
            {
                if (resource == null) throw new InvalidOperationException("EMBEDDED_PAYLOAD_MISSING");
                using (FileStream output = new FileStream(tempZip, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1 << 20))
                {
                    resource.CopyTo(output, 1 << 20);
                }
            }
            string hash;
            using (SHA256 sha = SHA256.Create())
            using (FileStream input = File.OpenRead(tempZip))
            {
                hash = BitConverter.ToString(sha.ComputeHash(input)).Replace("-", "").ToLowerInvariant();
            }
            string root = Path.Combine(cacheRoot, hash.Substring(0, 12));
            string marker = Path.Combine(root, ".payload-complete");
            string script = Path.Combine(root, "Complete-Setup.ps1");
            if (!File.Exists(marker) || !File.Exists(script))
            {
                if (Directory.Exists(root)) Directory.Delete(root, true);
                Directory.CreateDirectory(root);
                ZipFile.ExtractToDirectory(tempZip, root);
                File.WriteAllText(marker, hash + Environment.NewLine, new UTF8Encoding(false));
            }
            try { File.Delete(tempZip); } catch { }
            _payloadRoot = root;
            Append("PAYLOAD_ROOT=" + root);
            return root;
        }

        public Process Start()
        {
            string root = PreparePayload();
            string script = Path.Combine(root, "Complete-Setup.ps1");
            if (!File.Exists(script)) throw new InvalidOperationException("SETUP_SCRIPT_MISSING");
            var info = new ProcessStartInfo
            {
                FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe"),
                Arguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + script + "\" -Mode " + _mode + " -PayloadRoot \"" + root + "\"",
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WorkingDirectory = root,
            };
            var process = new Process { StartInfo = info, EnableRaisingEvents = true };
            process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) Append(e.Data); };
            process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) Append(e.Data); };
            process.Start();
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            _process = process;
            return process;
        }

        public int RunSilent()
        {
            try
            {
                Process p = Start();
                p.WaitForExit();
                return p.ExitCode;
            }
            catch (Exception ex)
            {
                Append("SETUP_EXCEPTION=" + ex.Message);
                return 1;
            }
            finally
            {
                if (_process != null) _process.Dispose();
            }
        }

        public void Dispose()
        {
            if (_process != null) { try { _process.Dispose(); } catch { } }
        }
    }

    internal sealed class SetupForm : Form
    {
        private string _mode;
        private SetupRunner _runner;
        private readonly Label _status;
        private readonly ProgressBar _progress;
        private readonly TextBox _log;
        private readonly Button _primary;
        private readonly Button _uninstall;
        private readonly Button _close;
        private bool _running;
        private bool _succeeded;

        public SetupForm(string mode)
        {
            _mode = mode;
            _runner = new SetupRunner(mode);
            _runner.LineReceived += OnLine;

            Text = "Singularity RepoQL Setup";
            ClientSize = new Size(760, 560);
            MinimumSize = new Size(640, 480);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(18, 20, 26);
            ForeColor = Color.FromArgb(232, 236, 244);
            Font = new Font("Segoe UI", 9f);

            var title = new Label
            {
                Text = "Singularity RepoQL",
                Font = new Font("Segoe UI Semibold", 22f),
                ForeColor = Color.White,
                AutoSize = true,
                Location = new Point(28, 20),
            };
            var subtitle = new Label
            {
                Text = "Claude Code Complete  ·  local memory  ·  automatic Tencent MemoryPanel session",
                Font = new Font("Segoe UI", 9.5f),
                ForeColor = Color.FromArgb(150, 163, 184),
                AutoSize = true,
                Location = new Point(31, 66),
            };
            _status = new Label
            {
                Text = "Preparing the installer payload…",
                Font = new Font("Segoe UI Semibold", 10f),
                ForeColor = Color.FromArgb(120, 200, 170),
                AutoSize = false,
                Location = new Point(31, 104),
                Size = new Size(690, 26),
            };
            _progress = new ProgressBar
            {
                Style = ProgressBarStyle.Marquee,
                MarqueeAnimationSpeed = 28,
                Location = new Point(33, 136),
                Size = new Size(690, 8),
            };
            _log = new TextBox
            {
                Multiline = true,
                ReadOnly = true,
                ScrollBars = ScrollBars.Vertical,
                BackColor = Color.FromArgb(11, 13, 17),
                ForeColor = Color.FromArgb(184, 196, 214),
                BorderStyle = BorderStyle.FixedSingle,
                Font = new Font("Consolas", 8.5f),
                Location = new Point(33, 160),
                Size = new Size(690, 310),
                WordWrap = false,
            };
            _primary = new Button
            {
                Text = mode == "Verify" ? "Verify installation" : (mode == "Uninstall" ? "Uninstall" : (mode == "Repair" ? "Repair installation" : "Install Singularity")),
                Location = new Point(33, 492),
                Size = new Size(190, 38),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(52, 120, 246),
                ForeColor = Color.White,
                Font = new Font("Segoe UI Semibold", 9.5f),
            };
            _primary.FlatAppearance.BorderSize = 0;
            _primary.Click += OnPrimary;
            _uninstall = new Button
            {
                Text = "Uninstall",
                Location = new Point(235, 492),
                Size = new Size(110, 38),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(36, 41, 52),
                ForeColor = Color.FromArgb(210, 218, 230),
                Visible = mode != "Uninstall",
            };
            _uninstall.FlatAppearance.BorderColor = Color.FromArgb(60, 68, 84);
            _uninstall.Click += delegate { BeginUninstall(); };
            _close = new Button
            {
                Text = "Close",
                Location = new Point(613, 492),
                Size = new Size(110, 38),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(36, 41, 52),
                ForeColor = Color.FromArgb(210, 218, 230),
            };
            _close.FlatAppearance.BorderColor = Color.FromArgb(60, 68, 84);
            _close.Click += delegate { Close(); };

            Controls.Add(title);
            Controls.Add(subtitle);
            Controls.Add(_status);
            Controls.Add(_progress);
            Controls.Add(_log);
            Controls.Add(_primary);
            Controls.Add(_uninstall);
            Controls.Add(_close);
            Shown += delegate { if (_mode != "Uninstall") StartWork(); };
        }

        private void OnLine(string line)
        {
            if (IsDisposed || !IsHandleCreated) return;
            try
            {
                BeginInvoke((Action)delegate
                {
                    _log.AppendText(line + Environment.NewLine);
                    if (line.StartsWith("STEP=", StringComparison.Ordinal))
                    {
                        string step = line.Substring(5).Split(' ')[0].Replace('_', ' ');
                        _status.Text = "Working: " + step;
                    }
                });
            }
            catch { }
        }

        private void StartWork()
        {
            if (_running) return;
            _running = true;
            _succeeded = false;
            _primary.Enabled = false;
            _uninstall.Enabled = false;
            _status.Text = _mode == "Verify" ? "Verifying the installed application…" : "Installing Singularity…";
            _log.Clear();
            _progress.Style = ProgressBarStyle.Marquee;
            try
            {
                Process process = _runner.Start();
                process.Exited += delegate
                {
                    int code = 0;
                    try { code = process.ExitCode; } catch { }
                    try
                    {
                        BeginInvoke((Action)delegate { Finish(code); });
                    }
                    catch { }
                };
                if (process.HasExited)
                {
                    int code = process.ExitCode;
                    BeginInvoke((Action)delegate { Finish(code); });
                }
            }
            catch (Exception ex)
            {
                _runner.Append("SETUP_EXCEPTION=" + ex.Message);
                Finish(1);
            }
        }

        private void Finish(int code)
        {
            _running = false;
            _progress.Style = ProgressBarStyle.Continuous;
            _progress.Value = code == 0 ? 100 : 0;
            _primary.Enabled = true;
            _uninstall.Enabled = true;
            if (code == 0)
            {
                _succeeded = true;
                _status.Text = _mode == "Uninstall" ? "Uninstalled. User data was preserved." : "Complete. Opening the dashboard works without a separate Tencent password.";
                _status.ForeColor = Color.FromArgb(120, 210, 170);
                _primary.Text = _mode == "Uninstall" ? "Close" : "Open dashboard";
            }
            else
            {
                _status.Text = "Setup failed. See the log below and " + _runner.LogPath;
                _status.ForeColor = Color.FromArgb(245, 140, 140);
                _primary.Text = "Retry";
            }
        }

        private void OnPrimary(object sender, EventArgs e)
        {
            if (_running) return;
            if (_succeeded)
            {
                if (_mode == "Uninstall") { Close(); return; }
                OpenDashboard();
                return;
            }
            StartWork();
        }

        private void OpenDashboard()
        {
            try
            {
                string baseDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Singularity");
                string launcher = Path.Combine(baseDir, "DashboardShortcut", "open_dashboard.ps1");
                if (!File.Exists(launcher))
                {
                    MessageBox.Show("The dashboard launcher is not installed. Open the Singularity Dashboard shortcut from the desktop.", "Singularity RepoQL");
                    return;
                }
                var info = new ProcessStartInfo
                {
                    FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe"),
                    Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + launcher + "\" -DashboardPort 18100 -StateDir \"" + Path.Combine(baseDir, "Dashboard") + "\"",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                };
                Process.Start(info);
            }
            catch (Exception ex)
            {
                MessageBox.Show("Could not launch the dashboard: " + ex.Message, "Singularity RepoQL");
            }
        }

        private void BeginUninstall()
        {
            if (_running) return;
            if (MessageBox.Show("Uninstall Singularity RepoQL?\n\nProduct tasks and program files are removed. MemoryCore data, dashboards, workspace, Claude settings and provider keys are preserved.", "Uninstall Singularity RepoQL", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return;
            _mode = "Uninstall";
            _runner.LineReceived -= OnLine;
            _runner = new SetupRunner("Uninstall");
            _runner.LineReceived += OnLine;
            _primary.Text = "Uninstall";
            _uninstall.Enabled = false;
            StartWork();
        }
    }
}
