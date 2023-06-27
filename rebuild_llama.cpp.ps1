$openBLASVersion = "0.3.23"

if (-not(Test-Path -Path "./vendor/OpenBLAS/OpenBLAS-${openBLASVersion}-x64.zip")) {

    Invoke-WebRequest `
        -Uri "https://github.com/xianyi/OpenBLAS/releases/download/v${openBLASVersion}/OpenBLAS-${openBLASVersion}-x64.zip" `
        -OutFile "./vendor/OpenBLAS/OpenBLAS-${openBLASVersion}-x64.zip"

    Expand-Archive `
        -Path "./vendor/OpenBLAS/OpenBLAS-${openBLASVersion}-x64.zip" `
        -DestinationPath "./vendor/OpenBLAS" `
        -Force
}

function Resolve-UnixPath {

    Param (
        [String] $path
    )

    Write-Output ((Resolve-Path "$path").Path -replace '\\','/')
}

git submodule update --remote --merge --force

$lines = @(
    "# This is a workaround for a CMake bug on Windows."
    "# @see https://github.com/ggerganov/llama.cpp/issues/627"
    "# @see https://discourse.cmake.org/t/8414"
    "if (LLAMA_BLAS AND `${LLAMA_BLAS_VENDOR} MATCHES `"OpenBLAS`")"
    "    include_directories(`"$(Resolve-UnixPath "./vendor/OpenBLAS/include")`")"
    "    add_link_options(`"$(Resolve-UnixPath "./vendor/OpenBLAS/lib/libopenblas.dll.a")`")"
    "    add_compile_definitions(GGML_USE_OPENBLAS)"
    "endif()"
    ""
)

if (!(Select-String -Path "./vendor/llama.cpp/CMakeLists.txt" -Pattern $lines[0] -SimpleMatch -Quiet)) {
    $lines + (Get-Content "./vendor/llama.cpp/CMakeLists.txt") | `
    Set-Content "./vendor/llama.cpp/CMakeLists.txt"
}

Remove-Item  -Path "./vendor/llama.cpp/build" -Force -Recurse

New-Item -Path "./vendor/llama.cpp" -Name "build" -ItemType "directory"

Copy-Item -Path "./vendor/OpenBLAS" -Destination "./vendor/llama.cpp/build/OpenBLAS" -Exclude "*.zip" -Recurse

Push-Location -Path "./"

Push-Location -Path "./vendor/llama.cpp/build"

cmake `
    -DLLAMA_CUBLAS=OFF `
    -DLLAMA_BLAS=ON `
    -DLLAMA_BLAS_VENDOR=OpenBLAS `
    ..

cmake --build . --config Release

Push-Location -Path "../"

conda activate llama.cpp

pip install -r ./requirements.txt

Pop-Location
Pop-Location
Pop-Location
