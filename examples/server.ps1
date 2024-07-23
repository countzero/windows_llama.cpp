#Requires -Version 5.0

<#
.SYNOPSIS
Automatically starts the llama.cpp server with optimal settings.

.DESCRIPTION
This script automatically starts the llama.cpp server with optimal settings.

.PARAMETER model
Specifies the path to the GGUF model file.

.PARAMETER parallel
Specifies the number of slots for process requests (default: 1).

.PARAMETER contextSize
Specifies the prompt context size in tokens.

.PARAMETER numberOfGPULayers
Specifies the number of layers offloaded into the GPU.

.PARAMETER modelContextLength
Specifies the models context length it was trained on.

.PARAMETER kvCacheDataType
Specifies the KV cache data type (options: f32, f16, q8_0, q4_0).

.PARAMETER verbose
Increases the verbosity of the llama.cpp server.

.PARAMETER help
Shows the manual on how to use this script.

.EXAMPLE
.\server.ps1 -model "..\vendor\llama.cpp\models\openchat-3.5-0106.Q5_K_M.gguf"

.EXAMPLE
.\server.ps1 -model "C:\models\openchat-3.5-0106.Q5_K_M.gguf" -parallel 4

.EXAMPLE
.\server.ps1 -model "C:\models\openchat-3.5-0106.Q5_K_M.gguf" -contextSize 4096 -numberOfGPULayers 10

.EXAMPLE
.\server.ps1 -model "C:\models\openchat-3.5-0106.Q5_K_M.gguf" -port 8081 -kvCacheDataType q8_0

.EXAMPLE
.\server.ps1 -model "..\vendor\llama.cpp\models\openchat-3.5-0106.Q5_K_M.gguf" -verbose
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
    $numberOfGPULayers=-1,

    [Parameter(
        HelpMessage="The server port."
    )]
    [Int]
    $port=8080,

    [Parameter(
        HelpMessage="Specifies the models context length it was trained on."
    )]
    [Int]
    $modelContextLength=-1,

    [Parameter(
        HelpMessage="Specifies the KV cache data type."
    )]
    [ValidateSetAttribute("f32", "f16", "q8_0", "q4_0")]
    [String]
    $kvCacheDataType="f16",

    [switch]
    $help
)

if ($help) {
    Get-Help -Detailed $PSCommandPath
    exit
}

# The -verbose option is a default PowerShell parameter.
$verbose = $PSCmdlet.MyInvocation.BoundParameters["Verbose"].IsPresent -eq $true

# We are resolving the absolute path to the llama.cpp project directory.
$llamaCppPath = Resolve-Path -Path "${PSScriptRoot}\..\vendor\llama.cpp"

function Convert-FileSize($length) {

    $suffix = "B", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"
    $index = 0

    while ($length -gt 1kb) {
        $length = $length / 1kb
        $index++
    }

    "{0:N1} {1}" -f $length, $suffix[$index]
}

# We are listing possible models to choose from.
if (!$model) {

    Write-Host "Please add the -model option with one of the following paths: " -ForegroundColor "DarkYellow"

    Get-ChildItem -Path "${llamaCppPath}\models\" -Filter '*.gguf' -Exclude 'ggml-vocab-*' -Recurse | `
    ForEach-Object {
        New-Object PSObject -Property @{
            FullName = Resolve-Path -Relative $_.FullName
            FileSize = Convert-FileSize $_.Length
        }
    }

    exit
}

# We are using the filename of the model as an alias for
# the API responses to not leak the directory structure.
$alias = (Get-ChildItem $model).Name

$numberOfPhysicalCores = Get-CimInstance -ClassName 'Win32_Processor' | Select -ExpandProperty "NumberOfCores"

conda activate llama.cpp

$modelFileSize = (Get-Item -Path "${model}").Length

$modelDataIsAvailable = $false

try {

    # We are trying to extract model details from the GGUF file.
    # https://github.com/ggerganov/ggml/blob/master/docs/gguf.md#llm
    # TODO: Find a robust way to resolve this values.
    $modelData = Invoke-Expression "python ${llamaCppPath}\gguf-py\scripts\gguf_dump.py --no-tensors `"${model}`""
    $modelContextLength = [Int]($modelData | Select-String -Pattern '\bcontext_length = (\d+)\b').Matches.Groups[1].Value
    $modelHeadCount = [Int]($modelData | Select-String -Pattern '\bhead_count = (\d+)\b').Matches.Groups[1].Value
    $modelBlockCount = [Int]($modelData | Select-String -Pattern '\bblock_count = (\d+)\b').Matches.Groups[1].Value
    $modelEmbeddingLength = [Int]($modelData | Select-String -Pattern '\bembedding_length = (\d+)\b').Matches.Groups[1].Value

    # We are adding a fallback to the head_count value if the
    # head_count_kv value is not set. A missing head_count_kv
    # means that the model does not use Grouped-Query-Attention.
    $matchHeadCountKV = $modelData | Select-String -Pattern '\bhead_count_kv = (\d+)\b'
    if ($matchHeadCountKV){
        $modelHeadCountKV = [Int]($matchHeadCountKV.Matches.Groups[1].Value)
    } else {
        $modelHeadCountKV = $modelHeadCount
    }

    $modelDataIsAvailable = $true
}
catch {

    Write-host $_.Exception.Message -ForegroundColor "Red"
    Write-Host $_.ScriptStackTrace -Foreground "DarkGray"

    if ($modelContextLength -lt 0) {
        throw "Failed to extract model details, please provide the -modelContextLength value to use this model."
    }

    Write-Host "Failed to extract model details, proceeding without automated GPU offloading..." -ForegroundColor "Yellow"
}

if (!$contextSize) {

    # We are defaulting the optimal model context size
    # for each independent sequence slot. For details see:
    # https://github.com/ggerganov/llama.cpp/discussions/4130
    $contextSize = $modelContextLength * $parallel
}

if ($modelDataIsAvailable) {

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
    $enableFlashAttention = $false

    # We are using the presence of NVIDIA System Management Interface
    # (nvidia-smi) and NVIDIA CUDA Compiler Driver (nvcc) to infer
    # the availability of a CUDA-compatible GPU.
    if ((Get-Command "nvidia-smi" -ErrorAction SilentlyContinue) -and
        (Get-Command "nvcc" -ErrorAction SilentlyContinue)) {

        $freeGPUMemory = ([Int](
            Invoke-Expression "nvidia-smi --query-gpu=memory.free --format=csv,noheader" | `
            Select-String -Pattern '\b(\d+) MiB\b'
        ).Matches.Groups[1].Value * 1024 * 1024)

        # The CUDA Flash Attention implementation of llama.cpp requires
        # the NVIDIA GPU to have a Compute Capability of >= 6.0.
        # https://docs.nvidia.com/cuda/cuda-c-programming-guide/index.html#features-and-technical-specifications
        # https://github.com/ggerganov/llama.cpp/issues/7055
        $enableFlashAttention = ([Double](
            Invoke-Expression "nvidia-smi --query-gpu=compute_cap --format=csv,noheader"
        ) -ge 6.0)

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
}

# The global fallback is using only the CPU.
if ($numberOfGPULayers -lt 0) {
    $numberOfGPULayers = 0
}

# We are automatically using the self extending context window
# on models that have a trained context window < context size.
# https://arxiv.org/abs/2401.01325
# https://github.com/ggerganov/llama.cpp/issues/4886#issuecomment-1890465266
$groupAttentionFactor = 1
$groupAttentionWidth = 512

if ($contextSize -gt $modelContextLength) {

    Write-Host "Self extending context window from ${modelContextLength} to ${contextSize}..." -ForegroundColor "Yellow"

    $groupAttentionFactor = $contextSize / $modelContextLength
    $groupAttentionWidth = $modelContextLength / 2
}

Write-Host "Starting llama.cpp server with custom options at http://127.0.0.1:${port}..." -ForegroundColor "Yellow"

$command = "${llamaCppPath}\build\bin\Release\llama-server ``
    --n-predict 1024 ``
    --log-disable ``
    --port '${port}' ``
    --model '${model}' ``
    --alias '${alias}' ``
    --ctx-size '${contextSize}' ``
    --threads '${numberOfPhysicalCores}' ``
    --n-gpu-layers '${numberOfGPULayers}' ``
    --parallel '${parallel}' ``
    --grp-attn-n '${groupAttentionFactor}' ``
    --grp-attn-w '${groupAttentionWidth}' ``
    --cache-type-k '${kvCacheDataType}' ``
    --cache-type-v '${kvCacheDataType}' ``
    $(if ($enableFlashAttention) {"--flash-attn"}) ``
    $(if ($verbose) {"--verbose"})"

Write-Host $command -ForegroundColor "Green"

Invoke-Expression $command
