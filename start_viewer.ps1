$ErrorActionPreference = 'Stop'
$candidates = @()
$configPath = Join-Path $PSScriptRoot 'runtime.local.json'
if (Test-Path -LiteralPath $configPath) {
    $runtime = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    $candidates += $runtime.python
}
foreach ($name in @('python.exe', 'python', 'py.exe')) {
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if ($command) { $candidates += $command.Source }
}
foreach ($candidate in ($candidates | Select-Object -Unique)) {
    if (-not $candidate -or -not (Test-Path -LiteralPath $candidate)) { continue }
    $oldPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $version = & $candidate -c 'import sys; print(sys.version_info.major)' 2>$null
    $valid = $LASTEXITCODE -eq 0 -and "$version".Trim() -eq '3'
    $ErrorActionPreference = $oldPreference
    if ($valid) {
        & $candidate (Join-Path $PSScriptRoot 'viewer/serve.py')
        exit $LASTEXITCODE
    }
}
throw 'No working Python 3 found. Set python in runtime.local.json to a valid python.exe.'
