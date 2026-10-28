// Windows ssh runs this as SSH_ASKPASS. It forwards its arguments, as CommandLineToArgvW parsed them, and SSH_ASKPASS_PROMPT
// to main's askpass server in the JSON request askpass-main.js sends, and prints the answer. No shell runs anywhere: a .cmd
// would go through cmd.exe, whose parsing a server's prompt text could break out of. Must stay C# 5 for .NET Framework's csc.
using System;
using System.IO;
using System.IO.Pipes;
using System.Text;

static class DamoclesSshAskpass
{
    // MAX_ASKPASS_ARGS, MAX_ASKPASS_ARG_CHARS and MAX_REPLY_BYTES of the askpass server and helper protocol
    const int MaxArgs = 16;
    const int MaxArgChars = 4096;
    const int MaxReplyBytes = 32 * 1024;
    const int ConnectTimeoutMs = 5000;
    const string PipePrefix = @"\\.\pipe\";

    static int Fail()
    {
        Console.Error.WriteLine("Damocles could not provide credentials.");
        return 1;
    }

    static bool IsNonce(string text)
    {
        if (text == null || text.Length != 64) return false;
        foreach (char c in text) if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
        return true;
    }

    static void AppendJsonString(StringBuilder json, string text)
    {
        json.Append('"');
        foreach (char c in text)
        {
            if (c == '"') json.Append("\\\"");
            else if (c == '\\') json.Append("\\\\");
            else if (c < 0x20 || (c >= 0xd800 && c <= 0xdfff)) json.Append("\\u").Append(((int)c).ToString("x4"));
            else json.Append(c);
        }
        json.Append('"');
    }

    // The reply's answer: exactly {"answer":"..."} on one line, or null for a cancel or anything else.
    static string ParseReply(string line)
    {
        const string Head = "{\"answer\":\"";
        if (!line.StartsWith(Head, StringComparison.Ordinal) || !line.EndsWith("\"}", StringComparison.Ordinal)) return null;
        string body = line.Substring(Head.Length, line.Length - Head.Length - 2);
        StringBuilder answer = new StringBuilder();
        for (int i = 0; i < body.Length; i++)
        {
            char c = body[i];
            if (c == '"') return null;
            if (c != '\\')
            {
                answer.Append(c);
                continue;
            }
            if (++i >= body.Length) return null;
            switch (body[i])
            {
                case '"': answer.Append('"'); break;
                case '\\': answer.Append('\\'); break;
                case '/': answer.Append('/'); break;
                case 'b': answer.Append('\b'); break;
                case 'f': answer.Append('\f'); break;
                case 't': answer.Append('\t'); break;
                case 'u':
                    if (i + 4 >= body.Length) return null;
                    int code;
                    if (!int.TryParse(body.Substring(i + 1, 4), System.Globalization.NumberStyles.AllowHexSpecifier, null, out code)) return null;
                    answer.Append((char)code);
                    i += 4;
                    break;
                default: return null;
            }
        }
        string text = answer.ToString();
        return text.IndexOfAny(new[] { '\0', '\r', '\n' }) >= 0 ? null : text;
    }

    // Any exception (a pipe that cannot connect or breaks, a reply that is not UTF-8) exits 1 like every other failure; an
    // unhandled one could raise Windows Error Reporting's dialog.
    static int Main(string[] args)
    {
        try
        {
            return Ask(args);
        }
        catch (Exception)
        {
            return Fail();
        }
    }

    static int Ask(string[] args)
    {
        string handle = Environment.GetEnvironmentVariable("DAMOCLES_ASKPASS_HANDLE");
        string nonce = Environment.GetEnvironmentVariable("DAMOCLES_ASKPASS_NONCE");
        if (args.Length == 0 || args.Length > MaxArgs || handle == null || !handle.StartsWith(PipePrefix, StringComparison.Ordinal) || !IsNonce(nonce)) return Fail();
        foreach (string arg in args) if (arg.Length > MaxArgChars) return Fail();
        string hint = Environment.GetEnvironmentVariable("SSH_ASKPASS_PROMPT");

        StringBuilder json = new StringBuilder("{\"nonce\":\"").Append(nonce).Append("\",\"kind\":\"ssh\",\"argv\":[");
        for (int i = 0; i < args.Length; i++)
        {
            if (i > 0) json.Append(',');
            AppendJsonString(json, args[i]);
        }
        json.Append(']');
        if (hint == "confirm" || hint == "none") json.Append(",\"sshPrompt\":\"").Append(hint).Append('"');
        json.Append("}\n");

        byte[] reply;
        using (NamedPipeClientStream pipe = new NamedPipeClientStream(".", handle.Substring(PipePrefix.Length), PipeDirection.InOut))
        {
            pipe.Connect(ConnectTimeoutMs);
            byte[] request = new UTF8Encoding(false).GetBytes(json.ToString());
            pipe.Write(request, 0, request.Length);
            pipe.Flush();
            using (MemoryStream received = new MemoryStream())
            {
                byte[] buffer = new byte[4096];
                int read;
                while ((read = pipe.Read(buffer, 0, buffer.Length)) > 0)
                {
                    if (received.Length + read > MaxReplyBytes) return Fail();
                    received.Write(buffer, 0, read);
                }
                reply = received.ToArray();
            }
        }

        string text = new UTF8Encoding(false, true).GetString(reply);
        if (!text.EndsWith("\n", StringComparison.Ordinal) || text.IndexOf('\n') != text.Length - 1) return Fail();
        string answer = ParseReply(text.Substring(0, text.Length - 1));
        if (answer == null) return Fail();
        byte[] output = new UTF8Encoding(false).GetBytes(answer + "\n");
        using (Stream stdout = Console.OpenStandardOutput()) stdout.Write(output, 0, output.Length);
        return 0;
    }
}
