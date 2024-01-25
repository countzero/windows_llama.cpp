#Requires -Version 5.0

<#
.SYNOPSIS
Automatically starts the llama.cpp server with optimal settings and opens it in the default browser.

.DESCRIPTION
This script automatically starts the llama.cpp server with optimal settings and opens it in the default browser.

.PARAMETER model
Specifies the path to the GGUF model file.

.EXAMPLE
.\server.ps1 -model "../vendor/llama.cpp/models/openchat-3.5-0106.Q5_K_M.gguf"

.EXAMPLE
.\server.ps1 -model "C:/models/openchat-3.5-0106.Q5_K_M.gguf"
#>

Param (
    [Parameter(
        Mandatory=$True,
        HelpMessage="The path to the GGUF model file."
    )]
    [String]
    $model
)

$numberOfPhysicalCores = Get-CimInstance -ClassName 'Win32_Processor' | Select -ExpandProperty "NumberOfCores"

# The fallback is using the OpenBLAS library.
$numberOfGPULayers = 0

# We are using the presence of NVIDIA System Management Interface
# (nvidia-smi) and NVIDIA CUDA Compiler Driver (nvcc) to infer
# the availability of a CUDA-compatible GPU.
if ((Get-Command "nvidia-smi" -ErrorAction SilentlyContinue) -and
    (Get-Command "nvcc" -ErrorAction SilentlyContinue)) {

    $freeGPUMemory = (
        Invoke-Expression "nvidia-smi --query-gpu=memory.free --format=csv,noheader" | `
        Select-String -Pattern '\b(\d+) MiB\b'
    ).Matches.Groups[1].Value

    conda activate llama.cpp

    $modelData = Invoke-Expression "python ..\vendor\llama.cpp\gguf-py\scripts\gguf-dump.py --no-tensors `"${model}`""

    $blockCount = [Int]($modelData | Select-String -Pattern '\bllama.block_count = (\d+)\b').Matches.Groups[1].Value

    # We are assuming, that the total number of model layers are the
    # total number of model blocks plus one input/embedding layer:
    # https://github.com/ggerganov/ggml/blob/master/docs/gguf.md#llm
    $totalNumberOfLayers = $blockCount + 1

    $modelFileSize = ((Get-Item -Path "${model}").Length / 1MB)

    $estimatedLayerSize = $modelFileSize / $totalNumberOfLayers

    $estimatedMaximumLayers = [Math]::Truncate($freeGPUMemory / $estimatedLayerSize)

    $numberOfGPULayers = $estimatedMaximumLayers

    if ($estimatedMaximumLayers -gt $totalNumberOfLayers) {
        $numberOfGPULayers = $totalNumberOfLayers
    }
}

Write-Host "Starting default browser at http://localhost:8080..." -ForegroundColor "Yellow"

Start-Process "http://localhost:8080"

Write-Host "Starting llama.cpp server..." -ForegroundColor "Yellow"
Write-Host "Physical CPU Cores: ${numberOfPhysicalCores}" -ForegroundColor "DarkYellow"
Write-Host "GPU Layers: ${numberOfGPULayers}/${totalNumberOfLayers}" -ForegroundColor "DarkYellow"

../vendor/llama.cpp/build/bin/Release/server `
    --model "${model}" `
    --threads "${numberOfPhysicalCores}" `
    --n-gpu-layers "${numberOfGPULayers}"
