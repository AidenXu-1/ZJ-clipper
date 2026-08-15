using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

internal static class Program
{
    // Chrome -> host 官方上限是 64 MiB；blob: 播放器会传入本机提取的 WAV。
    private const int MaxInput = 32 * 1024 * 1024;
    private const int MaxOutput = 1024 * 1024 - 4;
    private const int TimeoutMs = 31 * 60 * 1000;
    private static readonly Encoding Utf8Strict = new UTF8Encoding(false, true);
    private static readonly Encoding Utf8Lenient = new UTF8Encoding(false, false);

    [STAThread]
    private static int Main()
    {
        Stream input = Console.OpenStandardInput();
        Stream output = Console.OpenStandardOutput();
        try
        {
            byte[] body = ReadFrame(input);
            if (body == null) return 0;
            string reply;
            try
            {
                string request = Utf8Strict.GetString(body);
                if (String.Equals(request.Trim(), "{\"type\":\"ping\"}", StringComparison.Ordinal))
                {
                    reply = "{\"ok\":true,\"service\":\"nomo-local-transcriber\",\"version\":\"2.0.3\"}";
                    WriteFrame(output, reply);
                    return 0;
                }
                using (Mutex gate = new Mutex(false, @"Local\NomoClipperTranscriber"))
                {
                    bool owns;
                    try { owns = gate.WaitOne(0); }
                    catch (AbandonedMutexException) { owns = true; }
                    if (!owns) reply = ErrorJson("已有字幕任务正在运行");
                    else
                    {
                        try { reply = RunWorker(request); }
                        finally { gate.ReleaseMutex(); }
                    }
                }
            }
            catch (Exception ex)
            {
                Log("request failed: " + ex.GetType().Name + ": " + ex.Message);
                reply = ErrorJson("本地转录失败：" + ex.Message);
            }
            WriteFrame(output, reply);
            return 0;
        }
        catch (Exception ex)
        {
            Log("fatal: " + ex.GetType().Name + ": " + ex.Message);
            try { WriteFrame(output, ErrorJson("Native Host 通信失败：" + ex.Message)); }
            catch { }
            return 1;
        }
    }

    private static byte[] ReadFrame(Stream stream)
    {
        byte[] header = new byte[4];
        int offset = 0;
        while (offset < 4)
        {
            int n = stream.Read(header, offset, 4 - offset);
            if (n == 0)
            {
                if (offset == 0) return null;
                throw new EndOfStreamException("消息头不完整");
            }
            offset += n;
        }
        uint length = (uint)(header[0] | (header[1] << 8) | (header[2] << 16) | (header[3] << 24));
        if (length == 0 || length > MaxInput) throw new InvalidDataException("消息长度无效");
        byte[] body = new byte[(int)length];
        offset = 0;
        while (offset < body.Length)
        {
            int n = stream.Read(body, offset, body.Length - offset);
            if (n == 0) throw new EndOfStreamException("消息正文不完整");
            offset += n;
        }
        return body;
    }

    private static void WriteFrame(Stream stream, string json)
    {
        byte[] body = new UTF8Encoding(false).GetBytes(json);
        if (body.Length > MaxOutput) body = new UTF8Encoding(false).GetBytes(ErrorJson("字幕结果超过 Chrome 消息大小限制"));
        int n = body.Length;
        byte[] header = { (byte)n, (byte)(n >> 8), (byte)(n >> 16), (byte)(n >> 24) };
        stream.Write(header, 0, 4);
        stream.Write(body, 0, body.Length);
        stream.Flush();
    }

    private static string RunWorker(string request)
    {
        string baseDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        string worker = Path.Combine(baseDir, "worker.py");
        if (!File.Exists(worker)) throw new FileNotFoundException("缺少 worker.py");
        string uv = FindExe("uv.exe", baseDir);
        string ffmpeg = FindExe("ffmpeg.exe", baseDir);
        if (uv == null) throw new FileNotFoundException("未找到 uv.exe，请重新运行安装程序");
        if (ffmpeg == null) throw new FileNotFoundException("未找到 ffmpeg.exe，请重新运行安装程序");

        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = uv;
        psi.Arguments = "run --python 3.11 --extra gpu python " + QuoteArg(worker);
        psi.WorkingDirectory = baseDir;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardInput = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        string data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "NomoClipper", "Transcriber");
        Directory.CreateDirectory(data);
        psi.EnvironmentVariables["UV_CACHE_DIR"] = Path.Combine(data, "uv-cache");
        psi.EnvironmentVariables["UV_PROJECT_ENVIRONMENT"] = Path.Combine(data, "venv");
        psi.EnvironmentVariables["HF_HOME"] = Path.Combine(data, "huggingface");
        psi.EnvironmentVariables["NOMO_DEVICE"] = "auto";
        psi.EnvironmentVariables["NOMO_WHISPER_MODEL"] = "small";
        // 默认使用低占用配置：保留 small 中文准确率与 CUDA 加速，同时减少搜索、CPU 线程和显存占用。
        psi.EnvironmentVariables["NOMO_GPU_COMPUTE_TYPE"] = "int8_float16";
        psi.EnvironmentVariables["NOMO_CPU_COMPUTE_TYPE"] = "int8";
        psi.EnvironmentVariables["NOMO_CPU_THREADS"] = "2";
        psi.EnvironmentVariables["NOMO_NUM_WORKERS"] = "1";
        psi.EnvironmentVariables["NOMO_BEAM_SIZE"] = "1";
        psi.EnvironmentVariables["OMP_NUM_THREADS"] = "2";
        psi.EnvironmentVariables["MKL_NUM_THREADS"] = "2";
        psi.EnvironmentVariables["OPENBLAS_NUM_THREADS"] = "2";
        psi.EnvironmentVariables["PYTHONUTF8"] = "1";
        psi.EnvironmentVariables["PYTHONIOENCODING"] = "utf-8";
        string oldPath = psi.EnvironmentVariables["PATH"] ?? "";
        psi.EnvironmentVariables["PATH"] = Path.GetDirectoryName(ffmpeg) + ";" + Path.GetDirectoryName(uv) + ";" + oldPath;

        using (Process process = new Process())
        {
            process.StartInfo = psi;
            if (!process.Start()) throw new InvalidOperationException("无法启动 uv");
            try { process.PriorityClass = ProcessPriorityClass.BelowNormal; }
            catch { }
            Task<byte[]> outTask = Task.Factory.StartNew(delegate { return ReadAllCapped(process.StandardOutput.BaseStream, MaxOutput + 1); });
            Task<byte[]> errTask = Task.Factory.StartNew(delegate { return ReadAllCapped(process.StandardError.BaseStream, 256 * 1024); });
            byte[] inputBytes = new UTF8Encoding(false).GetBytes(request);
            process.StandardInput.BaseStream.Write(inputBytes, 0, inputBytes.Length);
            process.StandardInput.BaseStream.Flush();
            process.StandardInput.Close();

            if (!process.WaitForExit(TimeoutMs))
            {
                KillTree(process);
                Task.WaitAll(new Task[] { outTask, errTask }, 5000);
                throw new TimeoutException("处理超时，请重试");
            }
            process.WaitForExit();
            Task.WaitAll(new Task[] { outTask, errTask });
            string stderr = Utf8Lenient.GetString(errTask.Result);
            if (!String.IsNullOrWhiteSpace(stderr)) Log("worker stderr: " + Tail(stderr, 4000));
            if (process.ExitCode != 0) throw new InvalidOperationException("字幕进程退出码 " + process.ExitCode + "，请查看日志");
            if (outTask.Result.Length > MaxOutput) throw new InvalidDataException("字幕结果过大");
            string result = Utf8Strict.GetString(outTask.Result).Trim();
            if (!(result.StartsWith("{") && result.EndsWith("}"))) throw new InvalidDataException("字幕进程没有返回有效 JSON");
            return result;
        }
    }

    private static byte[] ReadAllCapped(Stream stream, int limit)
    {
        using (MemoryStream kept = new MemoryStream())
        {
            byte[] buffer = new byte[8192];
            int n;
            while ((n = stream.Read(buffer, 0, buffer.Length)) > 0)
            {
                int room = limit - (int)kept.Length;
                if (room > 0) kept.Write(buffer, 0, Math.Min(room, n));
            }
            return kept.ToArray();
        }
    }

    private static string FindExe(string name, string baseDir)
    {
        string user = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        string[] preferred = {
            Path.Combine(baseDir, name), Path.Combine(baseDir, "tools", name),
            Path.Combine(user, "Tools", "uv-0.12.3", name),
            Path.Combine(user, "Tools", "ffmpeg-9.0-essentials_build", "bin", name),
            Path.Combine(user, ".local", "bin", name)
        };
        foreach (string path in preferred) if (File.Exists(path)) return Path.GetFullPath(path);
        string environmentPath = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string raw in environmentPath.Split(Path.PathSeparator))
        {
            string dir = Environment.ExpandEnvironmentVariables(raw.Trim().Trim('"'));
            if (dir.Length == 0) continue;
            string path = Path.Combine(dir, name);
            if (File.Exists(path)) return Path.GetFullPath(path);
        }
        return null;
    }

    private static string QuoteArg(string value)
    {
        bool needs = value.Length == 0;
        foreach (char c in value) if (Char.IsWhiteSpace(c) || c == '"') { needs = true; break; }
        if (!needs) return value;
        StringBuilder builder = new StringBuilder(); builder.Append('"');
        int slashes = 0;
        foreach (char c in value)
        {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { builder.Append('\\', slashes * 2 + 1); builder.Append('"'); slashes = 0; continue; }
            builder.Append('\\', slashes); slashes = 0; builder.Append(c);
        }
        builder.Append('\\', slashes * 2); builder.Append('"');
        return builder.ToString();
    }

    private static void KillTree(Process process)
    {
        try
        {
            ProcessStartInfo info = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "taskkill.exe"), "/PID " + process.Id + " /T /F");
            info.UseShellExecute = false; info.CreateNoWindow = true;
            using (Process killer = Process.Start(info)) if (killer != null) killer.WaitForExit(5000);
        }
        catch { try { process.Kill(); } catch { } }
    }

    private static string ErrorJson(string message) { return "{\"ok\":false,\"error\":\"" + JsonEscape(message) + "\"}"; }
    private static string JsonEscape(string value)
    {
        if (value == null) return "";
        if (value.Length > 600) value = value.Substring(0, 600);
        StringBuilder builder = new StringBuilder();
        foreach (char c in value)
        {
            if (c == '"') builder.Append("\\\""); else if (c == '\\') builder.Append("\\\\");
            else if (c == '\n') builder.Append("\\n"); else if (c == '\r') builder.Append("\\r"); else if (c == '\t') builder.Append("\\t");
            else if (c < 32 || Char.IsSurrogate(c)) builder.Append("\\u" + ((int)c).ToString("x4")); else builder.Append(c);
        }
        return builder.ToString();
    }
    private static string Tail(string value, int length) { return value.Length <= length ? value : value.Substring(value.Length - length); }
    private static void Log(string message)
    {
        try
        {
            string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "NomoClipper", "logs");
            Directory.CreateDirectory(dir);
            File.AppendAllText(Path.Combine(dir, "native-host.log"), DateTime.UtcNow.ToString("o") + " " + message + Environment.NewLine, new UTF8Encoding(false));
        }
        catch { }
    }
}
