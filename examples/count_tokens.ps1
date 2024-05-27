#Requires -Version 5.0

<#
.SYNOPSIS
Counts tokens of a prompt file for a specific model.

.DESCRIPTION
This script counts tokens of a prompt file for a specific model.

.PARAMETER model
Specifies the path to the GGUF model file.

.PARAMETER file
Specifies the path to the prompt text file.

.PARAMETER prompt
Specifies the prompt.

.PARAMETER debug
Logs the result of the tokenization.

.EXAMPLE
.\count_tokens.ps1 -model "C:\models\openchat-3.5-0106.Q5_K_M.gguf" -file "C:\prompts\chat_with_llm.txt"

.EXAMPLE
.\count_tokens.ps1 -model "C:\models\openchat-3.5-0106.Q5_K_M.gguf" -prompt "Hello world!"

.EXAMPLE
.\count_tokens.ps1 -model "C:\models\openchat-3.5-0106.Q5_K_M.gguf" -prompt "Hello world!" -debug
#>

Param (

    [Parameter(
        HelpMessage="The path to the GGUF model file.",
        Mandatory=$true
    )]
    [String]
    $model,

    [Parameter(
        HelpMessage="The path to the prompt text file."
    )]
    [String]
    $file,

    [Parameter(
        HelpMessage="The prompt input."
    )]
    [String]
    $prompt
)

if ((!$file -and !$prompt) -or ($file -and $prompt)) {
    throw "One prompt text to tokenize is required: Either specify the -file or the -prompt parameter."
}

$debug = $PSCmdlet.MyInvocation.BoundParameters["Debug"].IsPresent -eq $true
$verbose = $PSCmdlet.MyInvocation.BoundParameters["Verbose"].IsPresent -eq $true

# We are resolving the absolute path to the llama.cpp project directory.
$llamaCppPath = Resolve-Path -Path "${PSScriptRoot}\..\vendor\llama.cpp"

$modelPath = Resolve-Path -Path "${model}"

if ($file) {
    $filePath = Resolve-Path -Path "${file}"
}

if ($debug) {

    # For debugging purposes we are logging the default output of the tokenization.
    Invoke-Expression "${llamaCppPath}\build\bin\Release\tokenize.exe ``
        $(if ($modelPath) {"--model '${modelPath}'"}) ``
        $(if ($filePath) {"--file '${filePath}'"} else {"--prompt '${prompt}'"})"
}

# We are only interested in the numerical token IDs array format like [1, 2, 3].
$tokensPythonArrayString = Invoke-Expression "${llamaCppPath}\build\bin\Release\tokenize.exe ``
    --log-disable ``
    --ids ``
    $(if ($modelPath) {"--model '${modelPath}'"}) ``
    $(if ($filePath) {"--file '${filePath}'"} else {"--prompt '${prompt}'"})"

# We are converting the Python array string into an PowerShell array.
$tokens = "${tokensPythonArrayString}".Trim('[', ']') -split ',' | % { [int]$_ }

Write-Host $tokens.Length
