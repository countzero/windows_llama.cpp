#Requires -Version 5.0

<#
.SYNOPSIS
Runs the SPEED-Bench server benchmark against a router-mode llama.cpp server.

.DESCRIPTION
This script is a thin wrapper around the upstream SPEED-Bench client
(vendor/llama.cpp/tools/server/bench/speed-bench/speed_bench.py). It is meant to
evaluate speculative decoding (draft-mtp, draft-eagle3, ngram-mod, ...) by
benchmarking several preset sections against each other through a single
router-mode llama-server and reporting per-category throughput, latency, and
draft acceptance.

The script targets a router-mode server (started with --models-preset and no
-m / --model). It sweeps the -models list in order: each id is pre-warmed via
the router /models/load endpoint, benchmarked with speed_bench.py, and saved to
its own JSON. When two or more models succeed it then compares them with
speed_bench_compare.py, anchoring on the first id (its row is the baseline
column) and diffing every later id against it, in list order.

With -compare it diffs two existing result files instead of running a benchmark.

.PARAMETER url
Specifies the router server URL, e.g. localhost:8080 (scheme and /v1 are optional).

.PARAMETER models
Specifies the preset section ids (the OpenAI "model" field) to benchmark, in the
order they should be run and compared. The first id is the comparison baseline.

.PARAMETER bench
Specifies the SPEED-Bench config to run, e.g. qualitative or throughput_1k.

.PARAMETER category
Specifies the category filter within the bench; a comma-separated list or "all".

.PARAMETER outputSequenceLength
Specifies the output sequence length, mapped to max_tokens. Defers to the
speed_bench.py default when omitted.

.PARAMETER concurrency
Specifies the number of concurrent client requests; usually match the section --parallel.

.PARAMETER extraInputs
Specifies extra request fields as a JSON object.

.PARAMETER outputDirectory
Specifies the directory that receives the per-model result JSON files.

.PARAMETER skipPreWarm
Skips the /models/load pre-warm step (use when sections are already loaded or --models-max 0).

.PARAMETER compare
Compares two existing result JSON files (baseline vs speculative) instead of running a benchmark.

.PARAMETER baseline
Specifies the baseline results JSON produced with -outputDirectory (use with -compare).

.PARAMETER speculative
Specifies the speculative results JSON produced with -outputDirectory (use with -compare).

.PARAMETER help
Shows the manual on how to use this script.

.PARAMETER additionalArguments
Adds additional arguments to speed_bench.py that are not handled by this script.

.EXAMPLE
.\speed-bench.ps1 -models "gemma-4-31B-mtp","gemma-4-31B-eagle3"

.EXAMPLE
.\speed-bench.ps1 -url "localhost:8080" -models "gemma-4-31B-mtp","gemma-4-31B-eagle3" -bench "qualitative" -category "coding,math,reasoning"

.EXAMPLE
.\speed-bench.ps1 -compare -baseline ".\speed-bench-results\gemma-4-31B-mtp.json" -speculative ".\speed-bench-results\gemma-4-31B-eagle3.json"
#>

Param (

    [Parameter(
        HelpMessage="The router server URL, e.g. localhost:8080."
    )]
    [String]
    $url="localhost:8080",

    [Parameter(
        HelpMessage="The preset section ids to benchmark, in run/compare order."
    )]
    [String[]]
    $models,

    [Parameter(
        HelpMessage="The SPEED-Bench config to run."
    )]
    [String]
    $bench="qualitative",

    [Parameter(
        HelpMessage="The category filter within the bench; comma-separated list or all."
    )]
    [String]
    $category="all",

    [Parameter(
        HelpMessage="The output sequence length, mapped to max_tokens."
    )]
    [Int]
    $outputSequenceLength=0,

    [Parameter(
        HelpMessage="The number of concurrent client requests."
    )]
    [ValidateRange(1,256)]
    [Int]
    $concurrency=1,

    [Parameter(
        HelpMessage="Extra request fields as a JSON object."
    )]
    [String]
    $extraInputs='{"temperature":0}',

    [Parameter(
        HelpMessage="The directory that receives the per-model result JSON files."
    )]
    [String]
    $outputDirectory=".\speed-bench-results",

    [Parameter(
        HelpMessage="Skips the /models/load pre-warm step."
    )]
    [switch]
    $skipPreWarm=$false,

    [Parameter(
        HelpMessage="Compares two existing result JSON files instead of running a benchmark."
    )]
    [switch]
    $compare=$false,

    [Parameter(
        HelpMessage="The baseline results JSON (use with -compare)."
    )]
    [String]
    $baseline,

    [Parameter(
        HelpMessage="The speculative results JSON (use with -compare)."
    )]
    [String]
    $speculative,

    [switch]
    $help,

    [Parameter()]
    [String]
    $additionalArguments
)

if ($help) {
    Get-Help -Detailed $PSCommandPath
    exit
}

# We are resolving the directory that holds the upstream SPEED-Bench client.
# Each rebuild resets the llama.cpp submodule to master, so this always tracks
# the binary that was built. Upstream has relocated bench paths before, so we
# fail with a clear hint instead of a generic Resolve-Path error.
$speedBenchDirectory = "${PSScriptRoot}\..\vendor\llama.cpp\tools\server\bench\speed-bench"

if (-not (Test-Path -Path "${speedBenchDirectory}\speed_bench.py")) {
    throw "Could not find speed_bench.py under ${speedBenchDirectory}. Upstream may have moved tools/server/bench/speed-bench/ (see AGENTS.md)."
}

$speedBenchPath = Resolve-Path -Path $speedBenchDirectory

conda activate llama.cpp

# SPEED-Bench (and its comparison helper, which imports it) pulls the dataset
# through the HuggingFace "datasets" package, which is intentionally not part of
# the project requirements. We check for it up front and point at the install
# command rather than failing deep inside Python with an opaque ImportError.
python -c "import datasets" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "The 'datasets' package is required but not installed." -ForegroundColor "Red"
    Write-Host "Install the SPEED-Bench dependencies with:" -ForegroundColor "Yellow"
    Write-Host "   pip install --requirement `"${speedBenchPath}\requirements.txt`"" -ForegroundColor "DarkYellow"
    exit 1
}

# Compare-only mode: diff two existing result files without running anything.
# speed_bench_compare.py imports speed_bench; running it by full path puts its
# own directory on sys.path[0], so the import resolves with no PYTHONPATH.
if ($compare) {

    if ($models) {
        throw "Use either -compare (with -baseline / -speculative) or -models, not both."
    }
    if (!$baseline -or !$speculative) {
        throw "The -compare mode requires both -baseline and -speculative."
    }

    Write-Host "Comparing SPEED-Bench results..." -ForegroundColor "Yellow"

    $command = "python -X utf8 `"${speedBenchPath}\speed_bench_compare.py`"" + `
        " --baseline '${baseline}' --speculative '${speculative}'"

    Write-Host $command -ForegroundColor "Green"
    Invoke-Expression $command
    exit $LASTEXITCODE
}

# Sweep mode from here on.
if (!$models) {
    throw "Provide -models with one or more preset section ids, or use -compare."
}

# We are forgiving about how the ids are passed: -models "a","b" and
# -models "a,b" both yield the same ordered list.
$modelList = @(
    $models |
    ForEach-Object { $_ -split ',' } |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_ }
)

# We are deriving both URLs the router exposes: the OpenAI surface lives under
# /v1 (used by speed_bench.py and the /v1/models listing), while the router-only
# /models/load endpoint sits at the server root.
$normalizedUrl = $url.Trim().TrimEnd('/')
if ($normalizedUrl -notmatch '://') {
    $normalizedUrl = "http://${normalizedUrl}"
}
$rootUrl = $normalizedUrl -replace '(?i)/v1$', ''
$v1Url = "${rootUrl}/v1"

# We are validating the requested ids against the router's model list. This also
# doubles as a connectivity check: a router that is not reachable fails here with
# one clear message instead of a connection error per benchmarked model.
Write-Host "Querying available models at ${v1Url}/models..." -ForegroundColor "Yellow"
try {
    $modelsResponse = Invoke-RestMethod -Uri "${v1Url}/models" -Method Get
} catch {
    throw "Could not reach the router at ${rootUrl}. Start llama-server in router mode (--models-preset ... --models-max 1). Underlying error: $($_.Exception.Message)"
}

$availableNames = @(
    $modelsResponse.data | ForEach-Object {
        $_.id
        if ($_.aliases) { $_.aliases }
    }
)

$unknownModels = @($modelList | Where-Object { $availableNames -notcontains $_ })
if ($unknownModels) {
    Write-Host "Unknown model id(s): $($unknownModels -join ', ')" -ForegroundColor "Red"
    Write-Host "Available models:" -ForegroundColor "Yellow"
    $modelsResponse.data | ForEach-Object {
        Write-Host "   $($_.id)" -ForegroundColor "DarkYellow"
    }
    exit 1
}

if (-not (Test-Path -Path $outputDirectory)) {
    New-Item -Path $outputDirectory -ItemType "directory" | Out-Null
}

# We are building the shared additional-argument tokens once. This mirrors the
# server.ps1 parser: it splits on whitespace and re-pairs key/value flags, so
# values that contain spaces will not survive (see AGENTS.md).
$extraArguments = @()
if ($additionalArguments) {
    $additionalArgumentParts = $additionalArguments -split '\s+'
    $index = 0
    while ($index -lt $additionalArgumentParts.Count) {

        $argument = $additionalArgumentParts[$index]

        $hasNextArgument = $index + 1 -lt $additionalArgumentParts.Count
        $nextArgumentIsValue = ($additionalArgumentParts[$index + 1] -notmatch '^-{1,2}')

        if ($hasNextArgument -and $nextArgumentIsValue) {
            $extraArguments += "$argument $($additionalArgumentParts[$index + 1])"
            $index += 2
        } else {
            $extraArguments += "$argument"
            $index += 1
        }
    }
}

# We are running each model in order, recording its result file and whether the
# run succeeded so a single failing model (e.g. a draft that fails to load) is
# skipped and excluded from the comparison rather than aborting the whole sweep.
$runs = @()

foreach ($model in $modelList) {

    Write-Host ""
    Write-Host "=== ${model} ===" -ForegroundColor "Cyan"

    if (-not $skipPreWarm) {

        # Pre-warm so the model load cost does not pollute the first sample's
        # latency. Best-effort: a failure here is surfaced by the run below.
        Write-Host "Pre-warming ${model}..." -ForegroundColor "Yellow"
        try {
            $loadBody = ConvertTo-Json @{ model = $model } -Compress
            Invoke-RestMethod -Uri "${rootUrl}/models/load" -Method Post -Body $loadBody -ContentType "application/json" | Out-Null
        } catch {
            Write-Host "Pre-warm did not complete (proceeding): $($_.Exception.Message)" -ForegroundColor "DarkYellow"
        }
    }

    $outputFile = Join-Path $outputDirectory (($model -replace '[^\w\.\-]', '_') + ".json")

    $commandArguments = @(
        "--url '${rootUrl}'",
        "--model '${model}'",
        "--bench '${bench}'",
        "--category '${category}'",
        "--concurrency '${concurrency}'",
        "--extra-inputs '${extraInputs}'",
        "--output '${outputFile}'"
    )

    if ($outputSequenceLength -gt 0) {
        $commandArguments += "--osl '${outputSequenceLength}'"
    }

    $commandArguments += $extraArguments

    $command = "python -X utf8 `"${speedBenchPath}\speed_bench.py`" " + ($commandArguments -join ' ')

    Write-Host $command -ForegroundColor "Green"
    Invoke-Expression $command

    $runs += [PSCustomObject]@{
        Model = $model
        File  = $outputFile
        Ok    = ($LASTEXITCODE -eq 0)
    }
}

$succeeded = @($runs | Where-Object { $_.Ok })
$failed = @($runs | Where-Object { -not $_.Ok })

if ($failed) {
    Write-Host ""
    Write-Host "Models that failed to benchmark:" -ForegroundColor "Red"
    $failed | ForEach-Object {
        Write-Host "   $($_.Model)" -ForegroundColor "DarkYellow"
    }
}

# Comparison anchors on the first requested model. Each later successful model is
# diffed against it, in list order. The anchor must have succeeded to compare.
$anchor = $runs[0]

if ($anchor.Ok -and $succeeded.Count -ge 2) {

    foreach ($run in $succeeded) {

        if ($run.Model -eq $anchor.Model) {
            continue
        }

        Write-Host ""
        Write-Host "=== $($anchor.Model) vs $($run.Model) ===" -ForegroundColor "Cyan"

        $command = "python -X utf8 `"${speedBenchPath}\speed_bench_compare.py`"" + `
            " --baseline '$($anchor.File)' --speculative '$($run.File)'"

        Write-Host $command -ForegroundColor "Green"
        Invoke-Expression $command
    }

} elseif (-not $anchor.Ok) {
    Write-Host ""
    Write-Host "Baseline model '$($anchor.Model)' failed; skipping comparisons. Per-model results are in ${outputDirectory}." -ForegroundColor "Yellow"
}

if ($failed) {
    exit 1
}
