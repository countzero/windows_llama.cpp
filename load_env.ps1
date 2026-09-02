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

Get-Content "./.env" | ForEach {

    $name, $value = $_.split('=', 2)

    if ([string]::IsNullOrWhiteSpace($name) -or $name.Contains('#')) {
        return
    }

    Set-Content env:\$name $value
}
