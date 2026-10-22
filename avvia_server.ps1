# Avvia un server HTTP locale sulla rete Wi-Fi per testare e installare l'app su S25 Ultra
$port = 8080
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")

# Trova l'indirizzo IP locale del PC
$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -notmatch 'Loopback' -and $_.IPAddress -notmatch '^169\.' } | Select-Object -First 1).IPAddress

Write-Host "=========================================================" -ForegroundColor Cyan
Write-Host "  PALESTRA PWA SERVER ATTIVO" -ForegroundColor Green
Write-Host "  Su questo PC apri:   http://localhost:$port" -ForegroundColor Yellow
if ($ip) {
    Write-Host "  Per collegarti da S25 Ultra (stesso Wi-Fi), esegui PowerShell come Amministratore" -ForegroundColor Gray
}
Write-Host "  Premi Ctrl+C per fermare il server." -ForegroundColor Cyan
Write-Host "=========================================================" -ForegroundColor Cyan

$listener.Start()
Start-Process "http://localhost:$port"

$mimeTypes = @{
    ".html" = "text/html; charset=utf-8"
    ".css"  = "text/css; charset=utf-8"
    ".js"   = "application/javascript; charset=utf-8"
    ".json" = "application/json; charset=utf-8"
    ".svg"  = "image/svg+xml"
}

try {
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $req = $context.Request
        $res = $context.Response

        $relPath = $req.Url.LocalPath.TrimStart('/')
        if ([string]::IsNullOrEmpty($relPath)) { $relPath = "index.html" }

        $filePath = Join-Path $PSScriptRoot $relPath
        if (Test-Path $filePath -PathType Leaf) {
            $ext = [System.IO.Path]::GetExtension($filePath).ToLower()
            $res.ContentType = if ($mimeTypes.ContainsKey($ext)) { $mimeTypes[$ext] } else { "application/octet-stream" }
            $bytes = [System.IO.File]::ReadAllBytes($filePath)
            $res.ContentLength64 = $bytes.Length
            $res.OutputStream.Write($bytes, 0, $bytes.Length)
        } else {
            $res.StatusCode = 404
        }
        $res.OutputStream.Close()
    }
} finally {
    $listener.Stop()
}
