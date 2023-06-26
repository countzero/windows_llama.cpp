if (-not(Test-Path -Path "./vendor/OpenBLAS/OpenBLAS.zip")) {

    Invoke-WebRequest `
        -Uri "https://github.com/xianyi/OpenBLAS/releases/download/v0.3.23/OpenBLAS-0.3.23-x64.zip" `
        -OutFile "./vendor/OpenBLAS/OpenBLAS.zip"

    Expand-Archive `
        -Path "./vendor/OpenBLAS/OpenBLAS.zip" `
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
    "# This is a workaround for https://github.com/ggerganov/llama.cpp/issues/627"
    "if (LLAMA_BLAS AND `${LLAMA_BLAS_VENDOR} MATCHES `"OpenBLAS`")"
    "    include_directories(`"$(Resolve-UnixPath "./vendor/OpenBLAS/include")`")"
    "    add_link_options(`"$(Resolve-UnixPath "./vendor/OpenBLAS/lib/libopenblas.dll.a")`")"
    "    add_compile_definitions(GGML_USE_OPENBLAS)"
    "endif()"
    ""
)

if (!(Select-String -Path "./vendor/llama.cpp/CMakeLists.txt" -Pattern $lines[0] -SimpleMatch -Quiet)) {
    $lines + (Get-Content "./vendor/llama.cpp/CMakeLists.txt") | Set-Content "./vendor/llama.cpp/CMakeLists.txt"
}

Remove-Item  -Path "./vendor/llama.cpp/build" -Force -Recurse

New-Item -Path "./vendor/llama.cpp" -Name "build" -ItemType "directory"

Push-Location -Path "./"

Push-Location -Path "./vendor/llama.cpp/build"

cmake .. `
    -DLLAMA_CUBLAS=ON `
    -DLLAMA_BLAS=OFF `
    -DLLAMA_BLAS_VENDOR=OpenBLAS

cmake --build . --config Release

Push-Location -Path "../"

conda activate llama.cpp

pip install -r ./requirements.txt

Pop-Location
Pop-Location
Pop-Location
