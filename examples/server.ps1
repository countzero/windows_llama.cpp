#Requires -Version 5.0

<#
.SYNOPSIS
Automatically starts the llama.cpp server with optimal settings and opens it in the chrome browser.

.DESCRIPTION
This script automatically starts the llama.cpp server with optimal settings and opens it in the chrome browser.

.PARAMETER model
Specifies the path to the GGUF model file.

.PARAMETER parallel
Specifies the number of slots for process requests (default: 1).

.EXAMPLE
.\server.ps1 -model "..\vendor\llama.cpp\models\openchat-3.5-0106.Q5_K_M.gguf"

.EXAMPLE
.\server.ps1 -model "C:\models\openchat-3.5-0106.Q5_K_M.gguf" -parallel 2

.EXAMPLE
.\examples\server.ps1 -model ".\vendor\llama.cpp\models\openchat-3.5-0106.Q5_K_M.gguf"
#>

Param (

    [Parameter(
        HelpMessage="The path to the GGUF model file."
    )]
    [String]
    $model,

    [Parameter(
        HelpMessage="The number of slots for process requests."
    )]
    [ValidateRange(1,256)]
    [Int]
    $parallel=1
)

# We are resolving the absolute path to the llama.cpp project directory
# to support using the absolute  re
$llamaCppPath = Resolve-Path -Path "${PSScriptRoot}\..\vendor\llama.cpp"

# We are listing possible models to choose from.
if (!$model) {

    Write-Host "Please add the -model option with one of the following paths: " -ForegroundColor "DarkYellow"

    Get-ChildItem -Path "${llamaCppPath}\models\" -Filter '*.gguf' -Exclude 'ggml-vocab-*' -Recurse | `
    %{$_.FullName} | `
    Resolve-Path -Relative

    exit
}

$numberOfPhysicalCores = Get-CimInstance -ClassName 'Win32_Processor' | Select -ExpandProperty "NumberOfCores"

# The fallback is using the OpenBLAS library.
$numberOfGPULayers = 0

# We are using the presence of NVIDIA System Management Interface
# (nvidia-smi) and NVIDIA CUDA Compiler Driver (nvcc) to infer
# the availability of a CUDA-compatible GPU.
if ((Get-Command "nvidia-smi" -ErrorAction SilentlyContinue) -and
    (Get-Command "nvcc" -ErrorAction SilentlyContinue)) {

    $freeGPUMemory = ([Int](
        Invoke-Expression "nvidia-smi --query-gpu=memory.free --format=csv,noheader" | `
        Select-String -Pattern '\b(\d+) MiB\b'
    ).Matches.Groups[1].Value * 1024 * 1024)

    # TODO: Understand how the KV cache size is calculated.
    $kvCacheSize = (2048 * 1024 * 1024)

    conda activate llama.cpp

    $modelData = Invoke-Expression "python ${llamaCppPath}\gguf-py\scripts\gguf-dump.py --no-tensors `"${model}`""
    $blockCount = [Int]($modelData | Select-String -Pattern '\bblock_count = (\d+)\b').Matches.Groups[1].Value
    $contextSize = [Int]($modelData | Select-String -Pattern '\bcontext_length = (\d+)\b').Matches.Groups[1].Value

    # We are assuming, that the total number of model layers are the
    # total number of model blocks plus one input/embedding layer:
    # https://github.com/ggerganov/ggml/blob/master/docs/gguf.md#llm
    $totalNumberOfLayers = $blockCount + 1

    $modelFileSize = (Get-Item -Path "${model}").Length

    $estimatedLayerSize = $modelFileSize / $totalNumberOfLayers

    $estimatedMaximumLayers = [Math]::Truncate(($freeGPUMemory - $kvCacheSize) / $estimatedLayerSize)

    $numberOfGPULayers = $estimatedMaximumLayers

    if ($estimatedMaximumLayers -gt $totalNumberOfLayers) {
        $numberOfGPULayers = $totalNumberOfLayers
    }

    if ($estimatedMaximumLayers -lt 1) {
        $numberOfGPULayers = 0
    }
}

Write-Host "Starting Chrome in incognito mode at http://127.0.0.1:8080 after the server..." -ForegroundColor "Yellow"

Get-Job -Name 'BrowserJob' -ErrorAction SilentlyContinue | Remove-Job -Force -ErrorAction SilentlyContinue
Start-Job -Name 'BrowserJob' -ScriptBlock { `
    do { Start-Sleep -Milliseconds 250 }
    while((curl.exe -s -o /dev/null -I -w '%{http_code}' 'http://127.0.0.1:8080') -ne 200)
    Start-Process 'chrome' -ArgumentList '--incognito --new-window http://127.0.0.1:8080'
}

Write-Host "Starting llama.cpp server..." -ForegroundColor "Yellow"
Write-Host "Context Size: ${contextSize}" -ForegroundColor "DarkYellow"
Write-Host "Physical CPU Cores: ${numberOfPhysicalCores}" -ForegroundColor "DarkYellow"
Write-Host "GPU Layers: ${numberOfGPULayers}/${totalNumberOfLayers}" -ForegroundColor "DarkYellow"

Invoke-Expression "${llamaCppPath}\build\bin\Release\server ``
    --model '${model}' ``
    --ctx-size '${contextSize}' ``
    --threads '${numberOfPhysicalCores}' ``
    --n-gpu-layers '${numberOfGPULayers}' ``
    --parallel '${parallel}' ``
    --cont-batching"