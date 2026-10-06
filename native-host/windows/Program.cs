using System.Diagnostics;

internal static class Program
{
    private static async Task<int> Main(string[] args)
    {
        if (args.Length != 1 || !System.Text.RegularExpressions.Regex.IsMatch(args[0], @"^chrome-extension://[a-p]{32}/$"))
        {
            await Console.Error.WriteLineAsync("Instagram Native Host rejected the extension origin.");
            return 2;
        }

        var installRoot = Environment.GetEnvironmentVariable("INSTAGRAM_MCP_INSTALL_ROOT");
        if (string.IsNullOrWhiteSpace(installRoot))
            installRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", ".."));

        var hostScript = Path.Combine(installRoot, "dist", "companion", "browser-native-host.js");
        if (!File.Exists(hostScript))
        {
            await Console.Error.WriteLineAsync("Instagram Native Host runtime files are unavailable.");
            return 3;
        }

        var configPath = Environment.GetEnvironmentVariable("INSTAGRAM_MCP_BRIDGE_CONFIG");
        if (string.IsNullOrWhiteSpace(configPath))
        {
            var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            configPath = Path.Combine(localAppData, "MetaInstagramCompanion", "browser-bridge.json");
        }

        var start = new ProcessStartInfo("node")
        {
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            WorkingDirectory = installRoot
        };
        start.ArgumentList.Add(hostScript);
        start.ArgumentList.Add(args[0]);
        start.Environment["INSTAGRAM_MCP_BRIDGE_CONFIG"] = configPath;

        using var process = new Process { StartInfo = start, EnableRaisingEvents = true };
        try
        {
            if (!process.Start()) return 4;
        }
        catch
        {
            await Console.Error.WriteLineAsync("Instagram Native Host could not start Node.js.");
            return 4;
        }

        var input = Console.OpenStandardInput();
        var output = Console.OpenStandardOutput();
        using var stop = new CancellationTokenSource();
        var toNode = RelayInput(input, process.StandardInput, stop.Token);
        var fromNode = process.StandardOutput.BaseStream.CopyToAsync(output, stop.Token);
        var errors = RelayErrors(process.StandardError, stop.Token);
        var exited = process.WaitForExitAsync();
        var completed = await Task.WhenAny(toNode, exited);
        if (completed == toNode)
        {
            try { await exited; } catch { }
        }
        stop.Cancel();
        if (!process.HasExited) { try { process.Kill(entireProcessTree: true); } catch { } }
        try { await Task.WhenAll(toNode, fromNode, errors); } catch (OperationCanceledException) { }
        return process.HasExited ? process.ExitCode : 0;
    }

    private static async Task RelayInput(Stream input, StreamWriter destination, CancellationToken cancellationToken)
    {
        try { await input.CopyToAsync(destination.BaseStream, cancellationToken); }
        finally { destination.Close(); }
    }

    private static async Task RelayErrors(StreamReader reader, CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            var line = await reader.ReadLineAsync(cancellationToken);
            if (line is null) return;
            await Console.Error.WriteLineAsync(line);
        }
    }
}
