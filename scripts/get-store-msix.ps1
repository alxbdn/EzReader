param([string]$Tag = "")

$ErrorActionPreference = "Stop"
$Repo = "alxbdn/EzReader"

if (-not $Tag) { $Tag = gh api "repos/$Repo/releases/latest" --jq .tag_name }
$Version = $Tag.TrimStart("v")
$Name = "store-msix-$Version"

$runId = gh api "repos/$Repo/actions/artifacts?name=$Name" --jq '[.artifacts[] | select(.expired | not)][0].workflow_run.id // empty'
if (-not $runId) {
    Write-Error "No artifact named $Name (artifacts are kept 90 days). Build it locally with .\scripts\build-msix.ps1 instead."
}

$out = Join-Path $PSScriptRoot "..\store"
New-Item -ItemType Directory -Force $out | Out-Null
gh run download $runId --repo $Repo --name $Name --dir $out
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Store package ready: $(Resolve-Path (Join-Path $out "ezreader-$Version-win-x64.msix"))" -ForegroundColor Green
