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

.PARAMETER contextSize
Specifies the prompt context size in tokens.

.PARAMETER numberOfGPULayers
Specifies the number of layers offloaded into the GPU.

.EXAMPLE
.\server.ps1 -model "..\vendor\llama.cpp\models\openchat-3.5-0106.Q5_K_M.gguf"

.EXAMPLE
.\server.ps1 -model "C:\models\openchat-3.5-0106.Q5_K_M.gguf" -parallel 4

.EXAMPLE
.\server.ps1 -model "C:\models\openchat-3.5-0106.Q5_K_M.gguf" -contextSize 4096 -numberOfGPULayers 10

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
    $parallel=1,

    [Parameter(
        HelpMessage="The prompt context size in tokens."
    )]
    [Int]
    $contextSize,

    [Parameter(
        HelpMessage="The number of layers offloaded into the GPU."
    )]
    [Int]
    $numberOfGPULayers=-1
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

# We are using the filename of the model as an alias for
# the API responses to not leak the directory structure.
$alias = (Get-ChildItem $model).Name

$numberOfPhysicalCores = Get-CimInstance -ClassName 'Win32_Processor' | Select -ExpandProperty "NumberOfCores"

conda activate llama.cpp

# We are extracting model details from the GGUF file.
# https://github.com/ggerganov/ggml/blob/master/docs/gguf.md#llm
$modelFileSize = (Get-Item -Path "${model}").Length
$modelData = Invoke-Expression "python ${llamaCppPath}\gguf-py\scripts\gguf-dump.py --no-tensors `"${model}`""
$modelContextLength = [Int]($modelData | Select-String -Pattern '\bcontext_length = (\d+)\b').Matches.Groups[1].Value
$modelHeadCount = [Int]($modelData | Select-String -Pattern '\bhead_count = (\d+)\b').Matches.Groups[1].Value
$modelHeadCountKV = [Int]($modelData | Select-String -Pattern '\bhead_count_kv = (\d+)\b').Matches.Groups[1].Value
$modelBlockCount = [Int]($modelData | Select-String -Pattern '\bblock_count = (\d+)\b').Matches.Groups[1].Value
$modelEmbeddingLength = [Int]($modelData | Select-String -Pattern '\bembedding_length = (\d+)\b').Matches.Groups[1].Value

if (!$contextSize) {

    # We are defaulting the optimal model context size
    # for each independent sequence slot. For details see:
    # https://github.com/ggerganov/llama.cpp/discussions/4130
    $contextSize = $modelContextLength * $parallel
}

# The Key (K) and Value (V) states of the model are cached in a FP16 format.
# The allocated size of the KV Cache is based on specific model details.
# https://github.com/ggerganov/llama.cpp/discussions/3485
# https://github.com/ollama/ollama/blob/v0.1.25/llm/llm.go#L51
$kvSize = 2 * 2 * $contextSize * $modelBlockCount * $modelEmbeddingLength * $modelHeadCountKV / $modelHeadCount

# The compute graph size is the amount of overhead and tensors
# llama.cpp needs to allocate. This is an estimated value.
# https://github.com/ollama/ollama/blob/v0.1.25/llm/llm.go#L56
$graphSize = ($modelHeadCount / $modelHeadCountKV) * $kvSize / 6

# The maximum number of layers are the model blocks plus one input layer.
# https://github.com/ggerganov/ggml/blob/master/docs/gguf.md#llm
$maximumNumberOfLayers = $modelBlockCount + 1

$averageLayerSize = $modelFileSize / $maximumNumberOfLayers

$freeMemory = ([Int](
    Get-CIMInstance Win32_OperatingSystem | Select  -ExpandProperty FreePhysicalMemory
) * 1024)

$freeGPUMemory = 0

# We are using the presence of NVIDIA System Management Interface
# (nvidia-smi) and NVIDIA CUDA Compiler Driver (nvcc) to infer
# the availability of a CUDA-compatible GPU.
if ((Get-Command "nvidia-smi" -ErrorAction SilentlyContinue) -and
    (Get-Command "nvcc" -ErrorAction SilentlyContinue)) {

    $freeGPUMemory = ([Int](
        Invoke-Expression "nvidia-smi --query-gpu=memory.free --format=csv,noheader" | `
        Select-String -Pattern '\b(\d+) MiB\b'
    ).Matches.Groups[1].Value * 1024 * 1024)

    # The automatic calculating the optimal number of GPU layers can
    # always be "overruled" by using the -numberOfGPULayers option.
    if ($numberOfGPULayers -lt 0) {

        $numberOfGPULayers = [Math]::Floor(($freeGPUMemory - $kvSize - $graphSize) / $averageLayerSize)

        if ($numberOfGPULayers -gt $maximumNumberOfLayers) {
            $numberOfGPULayers = $maximumNumberOfLayers
        }

        if ($numberOfGPULayers -lt 1) {
            $numberOfGPULayers = 0
        }
    }
}

# The global fallback is using only the CPU.
if ($numberOfGPULayers -lt 0) {
    $numberOfGPULayers = 0
}

Write-Host "Listing calculated memory details..." -ForegroundColor "Yellow"

[PSCustomObject]@{
    "Model Size" = "$([Math]::Ceiling($modelFileSize / 1MB)) MiB"
    "KV Cache Size" = "$([Math]::Ceiling($kvSize / 1MB)) MiB"
    "Graph Size" = "$([Math]::Ceiling($graphSize / 1MB)) MiB"
    "Average Layer Size" = "$([Math]::Ceiling(($averageLayerSize) / 1MB)) MiB"
    "Minimum Required VRAM" = "$([Math]::Ceiling(($averageLayerSize + $graphSize + $kvSize) / 1MB)) MiB"
    "Total Required Memory" = "$([Math]::Ceiling(($modelFileSize + $graphSize + $kvSize) / 1MB)) MiB"
    "Free GPU Memory (VRAM)" = "$([Math]::Ceiling($freeGPUMemory / 1MB)) MiB"
    "Free System Memory (RAM)" = "$([Math]::Ceiling($freeMemory / 1MB)) MiB"
} | Format-List | Out-String | ForEach-Object { $_.Trim("`r","`n") }

Write-Host "Waiting for server to start Chrome in incognito mode at http://127.0.0.1:8080..." -ForegroundColor "Yellow"

Get-Job -Name 'BrowserJob' -ErrorAction SilentlyContinue | Remove-Job -Force -ErrorAction SilentlyContinue
Start-Job -Name 'BrowserJob' -ScriptBlock {
    do { Start-Sleep -Milliseconds 1000 }
    while((curl.exe -s -o /dev/null -I -w '%{http_code}' 'http://127.0.0.1:8080') -ne 200)
    Start-Process 'chrome' -ArgumentList '--incognito --new-window http://127.0.0.1:8080'
} | Format-List -Property Id, Name, State, Command | Out-String | ForEach-Object { $_.Trim("`r","`n") }

Write-Host "Starting llama.cpp server with custom options..." -ForegroundColor "Yellow"

[PSCustomObject]@{
    "Context Size" = $contextSize
    "Physical CPU Cores" = $numberOfPhysicalCores
    "GPU Layers" = "${numberOfGPULayers}/${maximumNumberOfLayers}"
    "Parallel Slots" = "${parallel}"
} | Format-List | Out-String | ForEach-Object { $_.Trim("`r","`n") }

Invoke-Expression "${llamaCppPath}\build\bin\Release\server ``
    --log-disable ``
    --model '${model}' ``
    --alias '${alias}' ``
    --ctx-size '${contextSize}' ``
    --threads '${numberOfPhysicalCores}' ``
    --n-gpu-layers '${numberOfGPULayers}' ``
    --parallel '${parallel}' ``
    --cont-batching"
