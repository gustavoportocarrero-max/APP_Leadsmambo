# Minimal static file server for previewing the pipeline app.
# Serves the given root directory on the given port via HttpListener.
param(
  [string]$Root = "apps/pipeline",
  [int]$Port = 4321
)

$ErrorActionPreference = "Stop"
$rootFull = (Resolve-Path $Root).Path
$prefix = "http://localhost:$Port/"

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)
$listener.Start()
Write-Host "Serving $rootFull at $prefix"

$mime = @{
  ".html" = "text/html; charset=utf-8"
  ".css"  = "text/css; charset=utf-8"
  ".js"   = "application/javascript; charset=utf-8"
  ".json" = "application/json; charset=utf-8"
  ".csv"  = "text/csv; charset=utf-8"
  ".svg"  = "image/svg+xml"
  ".png"  = "image/png"
  ".ico"  = "image/x-icon"
}

while ($listener.IsListening) {
  try {
    $ctx = $listener.GetContext()
    $req = $ctx.Request
    $res = $ctx.Response

    $path = [System.Uri]::UnescapeDataString($req.Url.AbsolutePath)
    if ($path -eq "/" -or $path -eq "") { $path = "/index.html" }
    $local = Join-Path $rootFull ($path.TrimStart("/") -replace "/", "\")

    if (Test-Path $local -PathType Leaf) {
      $ext = [System.IO.Path]::GetExtension($local).ToLower()
      if ($mime.ContainsKey($ext)) { $res.ContentType = $mime[$ext] }
      $bytes = [System.IO.File]::ReadAllBytes($local)
      $res.ContentLength64 = $bytes.Length
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $res.StatusCode = 404
      $msg = [System.Text.Encoding]::UTF8.GetBytes("Not found: $path")
      $res.OutputStream.Write($msg, 0, $msg.Length)
    }
    $res.OutputStream.Close()
  } catch {
    # keep serving on transient errors
  }
}
