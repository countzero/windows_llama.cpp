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

.EXAMPLE
.\rebuild_llama.cpp.ps1

.EXAMPLE
.\rebuild_llama.cpp.ps1 -blasAccelerator "OpenBLAS"

.EXAMPLE
.\rebuild_llama.cpp.ps1 -blasAccelerator "CUDA" -version "master-4e7464e"

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
    $target
)

$stopwatch = [System.Diagnostics.Stopwatch]::startNew()

# We are defaulting the optional version to the tag of the
# "latest" release in GitHub to avoid unstable versions.
if (!$version) {

    $path = [regex]::Match(
        (git -C .\vendor\llama.cpp\ ls-remote --get-url),
        '(?<=github\.com:).*?(?=\.git)'
    ).Value

    $version = (
        (Invoke-WebRequest "https://api.github.com/repos/${path}/releases/latest") | `
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

Write-Host "Building the llama.cpp project..." -ForegroundColor "Yellow"
Write-Host "Version: ${version}" -ForegroundColor "DarkYellow"
Write-Host "BLAS accelerator: ${blasAccelerator}" -ForegroundColor "DarkYellow"
Write-Host "Build target: ${buildTargetInformation}" -ForegroundColor "DarkYellow"

$openBLASVersion = "0.3.26"

if (-not(Test-Path -Path "./vendor/OpenBLAS/OpenBLAS-${openBLASVersion}-x64.zip")) {

    Invoke-WebRequest `
        -Uri "https://github.com/xianyi/OpenBLAS/releases/download/v${openBLASVersion}/OpenBLAS-${openBLASVersion}-x64.zip" `
        -OutFile "./vendor/OpenBLAS/OpenBLAS-${openBLASVersion}-x64.zip"

    Expand-Archive `
        -Path "./vendor/OpenBLAS/OpenBLAS-${openBLASVersion}-x64.zip" `
        -DestinationPath "./vendor/OpenBLAS" `
        -Force
}

if (-not(Test-Path -Path "./vendor/wikitext-2-raw-v1/wikitext-2-raw-v1.zip")) {

    Invoke-WebRequest `
        -Uri "https://s3.amazonaws.com/research.metamind.io/wikitext/wikitext-2-raw-v1.zip" `
        -OutFile "./vendor/wikitext-2-raw-v1/wikitext-2-raw-v1.zip"

    Expand-Archive `
        -Path "./vendor/wikitext-2-raw-v1/wikitext-2-raw-v1.zip" `
        -DestinationPath "./vendor/wikitext-2-raw-v1" `
        -Force
}

function Resolve-UnixPath {
    Param ([String] $path)
    Write-Output ((Resolve-Path "$path").Path -replace '\\','/')
}

# We are resetting every submodule to their head prior
# to updating them to avoid any merge conflicts.
git submodule foreach --recursive git reset --hard

git submodule update --remote --merge --force

# We are checking out a specific version (tag / commit)
# of the repository to enable quick debugging.
git -C ./vendor/llama.cpp checkout $version

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

switch ($blasAccelerator) {

    "OpenBLAS" {
        cmake `
            -DGGML_BLAS=ON `
            -DGGML_BLAS_VENDOR=OpenBLAS `
            ..
    }

    "CUDA" {
        cmake `
            -DGGML_CUDA=ON `
            ..
    }

    default {
        cmake ..
    }
}

Write-Host "[CMake] Building project targets '${target}'..." -ForegroundColor "Yellow"

cmake `
    --build . `
    --config Release `
    --parallel (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors `
    $(if ($target) { "--target ${target}" })

Copy-Item -Path "../../OpenBLAS/bin/libopenblas.dll" -Destination "./bin/Release/libopenblas.dll"

Set-Location -Path "../../../"

Write-Host "[Python] Installing dependencies..." -ForegroundColor "Yellow"

conda activate llama.cpp

# We are installing the latest available version of all llama.cpp
# project dependencies and also overriding some package versions.
pip install `
    --upgrade `
    --upgrade-strategy "eager" `
    --requirement ./requirements_override.txt

conda list

$stopwatch.Stop()
$durationInSeconds = [Math]::Floor([Decimal]($stopwatch.Elapsed.TotalSeconds))

Write-Host "Successfully finished the build in ${durationInSeconds} seconds." -ForegroundColor "Yellow"
