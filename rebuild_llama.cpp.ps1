#Requires -Version 5.0

<#
.SYNOPSIS
Automatically rebuild llama.cpp for a Windows environment.

.DESCRIPTION
This script automatically rebuilds llama.cpp for a Windows environment.

.PARAMETER blasAccelerator
Specifies the BLAS accelerator, supported values are: "OpenBLAS", "CUDA", "OFF"

.PARAMETER version
Specifies a llama.cpp commit or tag to checkout a specific version.

.PARAMETER target
Specifies CMake build targets to compile a specific subset of the llama.cpp project.

.PARAMETER parallelJobs
Overrides the number of parallel build jobs passed to "cmake --build --parallel".
On SMT CPUs it defaults to the physical-core count (which leaves the logical
siblings free, keeping the machine usable). On non-SMT CPUs (hybrid Arrow/Lunar
Lake) physical == logical, so it defaults to 80% of physical cores to leave
headroom rather than pegging every core at 100%.

.PARAMETER help
Shows the manual on how to use this script.

.EXAMPLE
.\rebuild_llama.cpp.ps1

.EXAMPLE
.\rebuild_llama.cpp.ps1 -blasAccelerator "OpenBLAS" -version "50e0535"

.EXAMPLE
.\rebuild_llama.cpp.ps1 -target "llama-server llama-cli"
#>

Param (
    [ValidateSet("OpenBLAS", "CUDA", "OFF")]
    [String]
    $blasAccelerator,

    [String]
    $version,

    [String]
    $pullRequest,

    [String]
    $target,

    [Int]
    $parallelJobs,

    [switch]
    $help
)

if ($help) {
    Get-Help -Detailed $PSCommandPath
    exit
}

$stopwatch = [System.Diagnostics.Stopwatch]::startNew()

# We are defaulting the optional version to the tag of the
# "latest" release in GitHub to avoid unstable versions.
# Skipped when -pullRequest is set: $version is unused on that path
# and the GitHub API call wastes a network round-trip.
if (!$version -and !$pullRequest) {

    $path = [regex]::Match(
        (git -C .\vendor\llama.cpp\ ls-remote --get-url),
        '(?<=github\.com:).*?(?=\.git)'
    ).Value

    $version = (
        (Invoke-WebRequest -UseBasicParsing "https://api.github.com/repos/${path}/releases/latest") | `
        ConvertFrom-Json
    ).tag_name
}

# We are automatically detecting the best BLAS accelerator setting
# on the given system if the user did not specify it manually.
if (!$blasAccelerator) {

    # The fallback is using the OpenBLAS library.
    $blasAccelerator = "OpenBLAS"

    # We are using the presence of NVIDIA System Management Interface
    # (nvidia-smi) and NVIDIA CUDA Compiler Driver (nvcc) to infer
    # the availability of a CUDA-compatible GPU.
    if ((Get-Command "nvidia-smi" -ErrorAction SilentlyContinue) -and
        (Get-Command "nvcc" -ErrorAction SilentlyContinue)) {

        $blasAccelerator = "CUDA"
    }
}

if ($target) {
    $buildTargetInformation = "${target}"
} else {
    $buildTargetInformation = "(using project defaults)"
}

# Default depends on SMT. Upstream gates total cl.exe/nvcc parallelism on
# this single value (UseMultiToolTask + EnforceProcessCountAcrossBuilds at
# vendor/llama.cpp/CMakeLists.txt:92-93).
#   - SMT CPUs (Zen, Alder/Raptor Lake): use physical cores. This drops the
#     logical siblings (logical-count starves the scheduler and ~doubles peak
#     nvcc RAM for no throughput) AND leaves them free so the box stays usable.
#   - Non-SMT CPUs (hybrid Arrow/Lunar Lake): physical == logical, so all
#     cores would peg the machine at 100%. Back off to 80% of physical for
#     headroom; E-cores are throughput cores and Thread Director handles
#     placement among the rest.
# Override with -parallelJobs N.
if ($parallelJobs -le 0) {
    $cpu = Get-CimInstance Win32_Processor
    $physicalCores = ($cpu | Measure-Object -Property NumberOfCores -Sum).Sum
    $logicalCores  = ($cpu | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum

    if ($logicalCores -gt $physicalCores) {
        # SMT present: the physical-core count already leaves the logical
        # siblings free, so the machine stays usable. Use all physical cores.
        $parallelJobs = $physicalCores
    } else {
        # No SMT (hybrid Arrow/Lunar Lake): physical == logical, so using
        # every core pegs the machine at 100%. Back off to 80% for headroom.
        $parallelJobs = [int][Math]::Max(1, [Math]::Floor($physicalCores * 0.8))
    }
}

Write-Host "Building the llama.cpp project..." -ForegroundColor "Yellow"
if (!$pullRequest) {
    Write-Host "Version: ${version}" -ForegroundColor "DarkYellow"
} else {
    Write-Host "Pull Request: ${pullRequest}" -ForegroundColor "DarkYellow"
}
Write-Host "BLAS accelerator: ${blasAccelerator}" -ForegroundColor "DarkYellow"
Write-Host "Build target: ${buildTargetInformation}" -ForegroundColor "DarkYellow"
Write-Host "Parallel build jobs: ${parallelJobs}" -ForegroundColor "DarkYellow"

# Fail fast if any running process was launched from the build tree. The
# Remove-Item ./vendor/llama.cpp/build below would otherwise partially-delete
# the tree on Windows. Common trigger: forgetting to stop llama-server.exe.
$buildRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'vendor\llama.cpp\build'))
$blockers = Get-Process |
    Where-Object { $_.Path -and $_.Path.StartsWith($buildRoot, [StringComparison]::OrdinalIgnoreCase) }
if ($blockers) {
    $list = ($blockers | ForEach-Object { "  PID $($_.Id)  $($_.Path)" }) -join "`n"
    throw "Processes hold files under ${buildRoot}:`n${list}`nStop them and re-run."
}

$openBLASVersion = "0.3.30"

if (-not(Test-Path -Path "./vendor/OpenBLAS/OpenBLAS-${openBLASVersion}-x64.zip")) {

    Invoke-WebRequest `
        -UseBasicParsing `
        -Uri "https://github.com/xianyi/OpenBLAS/releases/download/v${openBLASVersion}/OpenBLAS-${openBLASVersion}-x64.zip" `
        -OutFile "./vendor/OpenBLAS/OpenBLAS-${openBLASVersion}-x64.zip"

    Expand-Archive `
        -Path "./vendor/OpenBLAS/OpenBLAS-${openBLASVersion}-x64.zip" `
        -DestinationPath "./vendor/OpenBLAS" `
        -Force
}

if (-not(Test-Path -Path "./vendor/wikitext-2-raw-v1/wikitext-2-raw-v1.zip")) {

    Invoke-WebRequest `
        -UseBasicParsing `
        -Uri "https://huggingface.co/datasets/ggml-org/ci/resolve/main/wikitext-2-raw-v1.zip" `
        -OutFile "./vendor/wikitext-2-raw-v1/wikitext-2-raw-v1.zip"

    Expand-Archive `
        -Path "./vendor/wikitext-2-raw-v1/wikitext-2-raw-v1.zip" `
        -DestinationPath "./vendor/wikitext-2-raw-v1" `
        -Force
}

if (-not(Test-Path -Path "./vendor/bartowski1182/calibration_datav5.txt")) {

    Invoke-WebRequest `
        -UseBasicParsing `
        -Uri "https://gist.github.com/bartowski1182/82ae9b520227f57d79ba04add13d0d0d/raw/ce111d8971a07caebd8234ef336b2102d6c5fb85/calibration_datav5.txt" `
        -OutFile "./vendor/bartowski1182/calibration_datav5.txt"
}

function Resolve-UnixPath {
    Param ([String] $path)
    Write-Output ((Resolve-Path "$path").Path -replace '\\','/')
}

# Mirror the pinned SHA of every non-llama.cpp submodule into its working tree
# so a committed pin bump propagates on the next rebuild. `vendor/llama.cpp` is
# advanced separately below per -version / -pullRequest.
$submodulePaths = git config --file .gitmodules --get-regexp '^submodule\..+\.path$' |
    ForEach-Object { ($_ -split '\s+', 2)[1] } |
    Where-Object { $_ -ne 'vendor/llama.cpp' }

foreach ($submodulePath in $submodulePaths) {
    Write-Host "[Submodules] Syncing ${submodulePath} to pinned SHA..." -ForegroundColor "Yellow"
    git -C $submodulePath fetch origin
    git submodule update --init --force -- $submodulePath
}

# Only `vendor/llama.cpp` is wiped-and-re-checked-out per build (the
# `-version` / `-pullRequest` checkout below relies on a clean tree).
# Other submodules (e.g. `vendor/Qwen-Fixed-Chat-Templates`) are pinned
# at the SHA recorded in the superproject and must not be advanced
# automatically — running `--remote` on them would defeat the pin and,
# for HF repos, also break against the hardcoded `origin/master` since
# Hugging Face uses `main` as the default branch.
$defaultBranch = "origin/master"

git -C ./vendor/llama.cpp fetch origin
git -C ./vendor/llama.cpp reset --hard $defaultBranch

git submodule update --remote --rebase --force -- ./vendor/llama.cpp

# Untracked files in the submodule survive `git reset --hard` and `git checkout`.
# A stale `vendor/llama.cpp/build-info.h` from late 2023 has been shadowing the
# new `common/build-info.h` because `tools/server/CMakeLists.txt` adds the repo
# root to the include path. Wipe untracked files (and dirs) so the tree matches
# the checked-out commit exactly.
git -C ./vendor/llama.cpp clean --force -d

# webui-download.cmake can leave a malformed cache that fools its own "already exists" check on the next build.
Remove-Item -LiteralPath "./vendor/llama.cpp/tools/server/public" -Recurse -Force -ErrorAction SilentlyContinue

# `node_modules` is .gitignored, so `git clean -fd` above leaves it untouched.
# Wipe it so `npm install` always runs against the freshly-checked-out
# `package.json` (the local-build branch of webui-download.cmake only runs
# `npm install` when node_modules is absent).
Remove-Item -LiteralPath "./vendor/llama.cpp/tools/server/webui/node_modules" `
            -Recurse -Force -ErrorAction SilentlyContinue

if (!$pullRequest) {

    # We are checking out a specific version (tag / commit)
    # of the repository to enable quick debugging.
    git -C ./vendor/llama.cpp checkout $version

} else {

    # We are checking out a specific pull request
    # of the repository to enable quick debugging.
    git -C ./vendor/llama.cpp fetch --force origin pull/${pullRequest}/head:PR
    git -C ./vendor/llama.cpp reset --hard PR
}

$lines = @(
    "# This is a workaround for a CMake bug on Windows to build llama.cpp"
    "# with OpenBLAS. The find_package(BLAS) call fails to find OpenBLAS,"
    "# so we have to link the 'libopenblas.dll' shared library manually."
    "# "
    "# @see https://github.com/ggerganov/llama.cpp/issues/627"
    "# @see https://discourse.cmake.org/t/8414"
    "# "
    "if (LLAMA_BLAS AND DEFINED LLAMA_BLAS_VENDOR)"
    "    if (`${LLAMA_BLAS_VENDOR} MATCHES `"OpenBLAS`")"
    "        set(LLAMA_EXTRA_INCLUDES `${LLAMA_EXTRA_INCLUDES} `"$(Resolve-UnixPath "./vendor/OpenBLAS/include")`")"
    "        set(LLAMA_EXTRA_LIBS `${LLAMA_EXTRA_LIBS} `"$(Resolve-UnixPath "./vendor/OpenBLAS/lib/libopenblas.dll.a")`")"
    "        add_compile_definitions(GGML_USE_OPENBLAS)"
    "    endif()"
    "endif()"
    ""
)

if (!(Select-String -Path "./vendor/llama.cpp/CMakeLists.txt" -Pattern $lines[0] -SimpleMatch -Quiet)) {
    $lines + (Get-Content "./vendor/llama.cpp/CMakeLists.txt") | `
    Set-Content "./vendor/llama.cpp/CMakeLists.txt"
}

Remove-Item -Path "./vendor/llama.cpp/build" -Force -Recurse

New-Item -Path "./vendor/llama.cpp" -Name "build" -ItemType "directory"

Set-Location -Path "./vendor/llama.cpp/build"

Write-Host "[CMake] Configuring and generating project..." -ForegroundColor "Yellow"

# Upstream ggml/CMakeLists.txt sets `cmake_policy(SET CMP0194 NEW)` and then
# calls `project("ggml" C CXX ASM)`. On CMake 4.1+ that rejects cl.exe as
# an assembler for the generic ASM language, and the Visual Studio generator
# has no integration between generic ASM and MASM. Point CMake at MASM
# (ml64.exe) explicitly; it ships with MSVC but is not normally on PATH.
$ml64 = & "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" `
    -latest -products * -find 'VC\Tools\MSVC\*\bin\Hostx64\x64\ml64.exe' |
    Select-Object -First 1
if (-not $ml64) { throw "ml64.exe not found. Install the VS C++ workload." }

switch ($blasAccelerator) {

    "OpenBLAS" {
        cmake `
            -DCMAKE_ASM_COMPILER="$ml64" `
            -DGGML_BLAS=ON `
            -DGGML_BLAS_VENDOR=OpenBLAS `
            -DLLAMA_CURL=OFF `
            ..
    }

    "CUDA" {
        # Pin pipeline-parallel staging to a single copy (ggml default is 4).
        # On multi-GPU layer-split, ggml pre-allocates GGML_SCHED_MAX_COPIES
        # copies of the compute buffer per device. Single-stream decode gains
        # nothing from the extra copies.
        cmake `
            -DCMAKE_ASM_COMPILER="$ml64" `
            -DGGML_CUDA=ON `
            -DGGML_SCHED_MAX_COPIES=1 `
            -DLLAMA_CURL=OFF `
            ..
    }

    default {
        cmake `
            -DCMAKE_ASM_COMPILER="$ml64" `
            ..
    }
}

Write-Host "[CMake] Building project targets '${target}'..." -ForegroundColor "Yellow"

cmake `
    --build . `
    --config Release `
    --parallel $parallelJobs `
    $(if ($target) { "--target ${target}" })

Copy-Item -Path "../../OpenBLAS/bin/libopenblas.dll" -Destination "./bin/Release/libopenblas.dll"

Set-Location -Path "../../../"

Write-Host "[Python] Installing dependencies..." -ForegroundColor "Yellow"

conda activate llama.cpp

# We are installing the latest available version of all llama.cpp
# project dependencies.
pip install `
    --upgrade `
    --upgrade-strategy "eager" `
    --requirement ./vendor/llama.cpp/requirements.txt

# We are overriding some package versions and installing
# additional packages that are missing from llama.cpp.
pip install `
    --upgrade `
    --upgrade-strategy "eager" `
    --requirement ./requirements_override.txt

conda list

$stopwatch.Stop()
$durationInSeconds = [Math]::Floor([Decimal]($stopwatch.Elapsed.TotalSeconds))

Write-Host "Successfully finished the build in ${durationInSeconds} seconds." -ForegroundColor "Yellow"
