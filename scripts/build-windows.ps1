# Keystone: one-shot Windows build.
# Installs missing prerequisites (MSVC C++ build tools, Rust, Node), then builds the installers.
# Usage (PowerShell):  powershell -ExecutionPolicy Bypass -File C:\dev\keystone\scripts\build-windows.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Refresh-Path {
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                [Environment]::GetEnvironmentVariable("Path", "User") + ";" +
                "$env:USERPROFILE\.cargo\bin"
}

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

# ---------- 1. MSVC C++ build tools (provides link.exe) ----------
Step "Checking Microsoft C++ build tools"
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vcComponent = "Microsoft.VisualStudio.Component.VC.Tools.x86.x64"
$workload = "Microsoft.VisualStudio.Workload.VCTools"

$hasVc = $false
if (Test-Path $vswhere) {
    $vcPath = & $vswhere -products * -requires $vcComponent -property installationPath
    $hasVc = [bool]$vcPath
}

if ($hasVc) {
    Write-Host "C++ build tools found: $vcPath"
} else {
    # Find an existing VS / Build Tools instance, including incomplete ones (-all).
    $bt = $null
    if (Test-Path $vswhere) {
        Write-Host "Visual Studio instances on this machine:"
        & $vswhere -all -products * -format text | Select-String "installationPath|displayName|isComplete" | ForEach-Object { Write-Host "  $_" }
        $bt = & $vswhere -all -products * -property installationPath | Select-Object -First 1
    }
    if (-not $bt) {
        $default = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools"
        if (Test-Path $default) { $bt = $default }
    }
    if ($bt) {
        Write-Host "Using $bt - adding the C++ workload (approve the admin prompt; this downloads 2-3 GB)..."
        $setup = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\setup.exe"
        $p = Start-Process -FilePath $setup -Verb RunAs -Wait -PassThru -ArgumentList @(
            "modify", "--installPath", "`"$bt`"", "--add", $workload,
            "--includeRecommended", "--passive", "--norestart")
        if ($p.ExitCode -notin 0, 3010) {
            Write-Host "Modify failed (exit $($p.ExitCode)). Trying a repair of the instance..."
            $p = Start-Process -FilePath $setup -Verb RunAs -Wait -PassThru -ArgumentList @(
                "repair", "--installPath", "`"$bt`"", "--passive", "--norestart")
            $p = Start-Process -FilePath $setup -Verb RunAs -Wait -PassThru -ArgumentList @(
                "modify", "--installPath", "`"$bt`"", "--add", $workload,
                "--includeRecommended", "--passive", "--norestart")
            if ($p.ExitCode -notin 0, 3010) { throw "Visual Studio Installer failed (exit $($p.ExitCode)). Open 'Visual Studio Installer' from the Start menu and click Modify/Repair on Build Tools 2022, ticking 'Desktop development with C++'." }
        }
    } else {
        Write-Host "Installing Visual Studio 2022 Build Tools with C++ (2-3 GB, approve the admin prompt)..."
        winget install --id Microsoft.VisualStudio.2022.BuildTools -e --accept-source-agreements --accept-package-agreements `
            --override "--wait --passive --norestart --add $workload --includeRecommended"
    }
    $vcPath = & $vswhere -products * -requires $vcComponent -property installationPath
    if (-not $vcPath) { throw "C++ build tools still not detected. Open 'Visual Studio Installer', Modify Build Tools 2022, tick 'Desktop development with C++'." }
    Write-Host "C++ build tools installed: $vcPath"
}

# ---------- 2. Rust ----------
Step "Checking Rust"
Refresh-Path
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    winget install --id Rustlang.Rustup -e --accept-source-agreements --accept-package-agreements
    Refresh-Path
}
rustup default stable-x86_64-pc-windows-msvc | Out-Null
cargo --version

# ---------- 3. Node ----------
Step "Checking Node.js"
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
    Refresh-Path
}
node --version

# ---------- 4. Build ----------
Step "Installing JS dependencies"
npm install
if ($LASTEXITCODE) { throw "npm install failed" }
npm --prefix ui install
if ($LASTEXITCODE) { throw "ui npm install failed" }

Step "Building Keystone (first Rust build takes 5-10 minutes)"
npx tauri build
if ($LASTEXITCODE) { throw "tauri build failed - paste the error above" }

Step "Done. Installers:"
Get-ChildItem "$root\target\release\bundle" -Recurse -Include *.msi, *.exe | ForEach-Object { Write-Host "  $($_.FullName)" -ForegroundColor Green }
