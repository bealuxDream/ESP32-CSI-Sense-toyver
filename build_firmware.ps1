param([string]$FlashPort, [switch]$CompileCheck)
$ErrorActionPreference = 'Stop'
$runtimePath = Join-Path $PSScriptRoot 'runtime.local.json'
if (-not (Test-Path -LiteralPath $runtimePath)) {
    throw 'Copy runtime.example.json to runtime.local.json and set your installed ESP-IDF/Python paths. See README.md.'
}
$runtime = Get-Content -LiteralPath $runtimePath -Raw | ConvertFrom-Json
if (-not $runtime.python -or -not (Test-Path -LiteralPath $runtime.python) -or -not $runtime.idfToolsPath) {
    throw 'Set python and idfToolsPath in runtime.local.json to your installed ESP-IDF tools.'
}
if (-not (Test-Path -LiteralPath (Join-Path $runtime.idfPath 'tools/idf.py'))) {
    throw 'Set idfPath in runtime.local.json to an installed ESP-IDF checkout.'
}
if ($CompileCheck -and $FlashPort) { throw 'CompileCheck cannot be flashed. Configure Wi-Fi first.' }
if (-not $CompileCheck) {
    $wifiPath = Join-Path $PSScriptRoot 'wifi.local.json'
    if (-not (Test-Path -LiteralPath $wifiPath)) {
        throw 'Copy wifi.example.json to wifi.local.json and fill your 2.4 GHz Wi-Fi settings first.'
    }
    $wifi = Get-Content -LiteralPath $wifiPath -Raw | ConvertFrom-Json
    if (-not $wifi.ssid -or $wifi.ssid -eq 'YOUR_2G_WIFI' -or $wifi.password -eq '__FILL_LOCALLY__') {
        throw 'Fill the 2.4 GHz SSID and password in wifi.local.json first.'
    }
    if ([Text.Encoding]::UTF8.GetByteCount($wifi.ssid) -gt 32 -or [Text.Encoding]::UTF8.GetByteCount($wifi.password) -gt 64) {
        throw 'Wi-Fi SSID/password is too long.'
    }
}
# Python and ccache in the installed toolchain need these settings for Chinese paths.
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
$env:CCACHE_ENABLE = '0'
$env:IDF_TOOLS_PATH = $runtime.idfToolsPath
$env:PATH = (Split-Path $runtime.python) + ';' + $env:PATH
. (Join-Path $runtime.idfPath 'export.ps1')
if ($LASTEXITCODE -ne 0) { throw 'ESP-IDF environment setup failed.' }
$firmware = Join-Path $PSScriptRoot 'firmware'
if (-not $CompileCheck) {
    # Replace only these two settings; never echo the password to the terminal.
    $sdkconfigPath = Join-Path $firmware 'sdkconfig'
    $lines = @()
    if (Test-Path -LiteralPath $sdkconfigPath) {
        $lines = @(Get-Content -LiteralPath $sdkconfigPath | Where-Object { $_ -notmatch '^(# )?CONFIG_DEMO_WIFI_(SSID|PASSWORD)(=| )' })
    }
    $lines += 'CONFIG_DEMO_WIFI_SSID=' + (ConvertTo-Json -InputObject ([string]$wifi.ssid) -Compress)
    $lines += 'CONFIG_DEMO_WIFI_PASSWORD=' + (ConvertTo-Json -InputObject ([string]$wifi.password) -Compress)
    [IO.File]::WriteAllLines($sdkconfigPath, [string[]]$lines, [Text.UTF8Encoding]::new($false))
}
# The vendor objdump cannot open Chinese paths, even with Python UTF-8 enabled.
# Keep editable sources here and compile a copy in an ASCII-only temp directory.
$hash = [Security.Cryptography.SHA256]::Create()
try {
    $projectKey = ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($PSScriptRoot)))).Replace('-', '').Substring(0, 12).ToLowerInvariant()
} finally { $hash.Dispose() }
$stage = Join-Path ([IO.Path]::GetTempPath()) ('esp32-csi-' + $projectKey)
if ($stage -match '[^\x00-\x7F]') { throw 'The build temp directory must have an ASCII-only path.' }
New-Item -ItemType Directory -Path $stage -Force | Out-Null
foreach ($file in @('CMakeLists.txt', 'sdkconfig.defaults', 'sdkconfig')) {
    $source = Join-Path $firmware $file
    if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination (Join-Path $stage $file) -Force }
}
Copy-Item -LiteralPath (Join-Path $firmware 'main') -Destination $stage -Recurse -Force
if ($CompileCheck) {
    $stagedConfig = Join-Path $stage 'sdkconfig'
    $checkLines = @()
    if (Test-Path -LiteralPath $stagedConfig) {
        $checkLines = @(Get-Content -LiteralPath $stagedConfig | Where-Object { $_ -notmatch '^(# )?CONFIG_DEMO_WIFI_(SSID|PASSWORD)(=| )' })
    }
    $checkLines += 'CONFIG_DEMO_WIFI_SSID="CSI_BUILD_TEST"'
    $checkLines += 'CONFIG_DEMO_WIFI_PASSWORD=""'
    [IO.File]::WriteAllLines($stagedConfig, [string[]]$checkLines, [Text.UTF8Encoding]::new($false))
}
Write-Host "Build workspace: $stage"
Push-Location $stage
try {
    & $runtime.python (Join-Path $runtime.idfPath 'tools/idf.py') --no-ccache -B build -D IDF_TARGET=esp32s3 build
    if ($LASTEXITCODE -ne 0) { throw 'Firmware build failed.' }
    if (-not $CompileCheck) {
        Copy-Item -LiteralPath (Join-Path $stage 'sdkconfig') -Destination (Join-Path $firmware 'sdkconfig') -Force
    }
    $output = Join-Path $PSScriptRoot 'artifacts/firmware'
    New-Item -ItemType Directory -Path $output -Force | Out-Null
    foreach ($relative in @('csi_classroom.bin', 'csi_classroom.elf', 'bootloader/bootloader.bin', 'partition_table/partition-table.bin', 'flasher_args.json')) {
        $target = Join-Path $output $relative
        New-Item -ItemType Directory -Path (Split-Path $target) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $stage ('build/' + $relative)) -Destination $target -Force
    }
    if ($FlashPort) {
        & $runtime.python -m esptool --chip esp32s3 --port $FlashPort chip_id
        if ($LASTEXITCODE -ne 0) { throw 'ESP32-S3 identification failed. Flash stopped.' }
        & $runtime.python (Join-Path $runtime.idfPath 'tools/idf.py') --no-ccache -B build -p $FlashPort -b 115200 flash
        if ($LASTEXITCODE -ne 0) { throw 'Firmware flash failed.' }
    }
} finally { Pop-Location }
