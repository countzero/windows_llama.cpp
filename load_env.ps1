# Loads ./.env into the environment of the current PowerShell session.
#
# Dot-source it from the repository root before starting llama-server:
#
#     . .\load_env.ps1
#
# The parser mirrors windows_manage_large_language_models: it splits every
# line on the first "=", skips blank lines and lines whose key contains "#",
# and does no quote stripping or whitespace trimming. Keep values bare and
# write KEY=VALUE without spaces around the "=".

# Stop rather than let the caller's "; llama-server" run on. Get-Content
# raises a non-terminating error for a missing file, so without this the
# router would start on its defaults with no models directory and no preset,
# which looks like a working server rather than a missing .env.
if (-not (Test-Path -LiteralPath "./.env")) {
    throw "No .env in the current directory. Copy .env.example to .env and edit it, and dot-source this from the repository root."
}

Get-Content "./.env" | ForEach-Object {

    $name, $value = $_.split('=', 2)

    if ([string]::IsNullOrWhiteSpace($name) -or $name.Contains('#')) {
        return
    }

    # A line with no "=" yields no value, and Set-Content rejects a null one.
    if ($null -eq $value) {
        Write-Warning "Ignoring line without '=' in .env: ${name}"
        return
    }

    Set-Content env:\$name $value
}
