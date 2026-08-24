# 打包 .eext：条目名与官方包一致（扁平、正斜杠），输出到插件目录
# 用法: powershell -ExecutionPolicy Bypass -File package.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifest = Get-Content (Join-Path $root 'extension.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$outDir = Join-Path $root 'release'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }
$out = Join-Path $outDir ("power-net-highlighter-" + $manifest.version + ".eext")
if (Test-Path $out) { Remove-Item $out }

Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($out, 'Create')
try {
	foreach ($rel in @('extension.json', 'dist/index.js', 'iframe/index.html', 'images/logo.png', 'README.md', 'CHANGELOG.md')) {
		$src = Join-Path $root ($rel -replace '/', '\')
		if (-not (Test-Path $src)) { throw "missing: $src" }
		$entry = $zip.CreateEntry($rel)
		$entry.LastWriteTime = (Get-Item $src).LastWriteTime
		$in = [System.IO.File]::OpenRead($src)
		$es = $entry.Open()
		try { $in.CopyTo($es) } finally { $es.Dispose(); $in.Dispose() }
	}
} finally { $zip.Dispose() }
Write-Output "packaged: $out"
