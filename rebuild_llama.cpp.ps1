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
    Param ([String] $path)
    Write-Output ((Resolve-Path "$path").Path -replace '\\','/')
}

git submodule update --remote --merge --force

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
    "        set(LLAMA_EXTRA_INCLUDES ${LLAMA_EXTRA_INCLUDES}`"$(Resolve-UnixPath "./vendor/OpenBLAS/include")`")"
    "        set(LLAMA_EXTRA_LIBS ${LLAMA_EXTRA_LIBS} `"$(Resolve-UnixPath "./vendor/OpenBLAS/lib/libopenblas.dll.a")`")"
    "        add_compile_definitions(GGML_USE_OPENBLAS)"
    "    endif()"
    "endif()"
    ""
)

if (!(Select-String -Path "./vendor/llama.cpp/CMakeLists.txt" -Pattern $lines[0] -SimpleMatch -Quiet)) {
    $lines + (Get-Content "./vendor/llama.cpp/CMakeLists.txt") | `
    Set-Content "./vendor/llama.cpp/CMakeLists.txt"
}

Remove-Item  -Path "./vendor/llama.cpp/build" -Force -Recurse

New-Item -Path "./vendor/llama.cpp" -Name "build" -ItemType "directory"

Set-Location -Path "./vendor/llama.cpp/build"

cmake `
    -DLLAMA_CUBLAS=OFF `
    -DLLAMA_BLAS=ON `
    -DLLAMA_BLAS_VENDOR=OpenBLAS `
    ..

cmake --build . --config Release

Copy-Item -Path "../../OpenBLAS/bin/libopenblas.dll" -Destination "./bin/Release/libopenblas.dll"

Set-Location -Path "../"

conda activate llama.cpp

pip install -r ./requirements.txt

Set-Location -Path "../../"
