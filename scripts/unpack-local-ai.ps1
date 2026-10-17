param([Parameter(Mandatory=$true)][string]$ArchivePath, [Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
Expand-Archive -LiteralPath $ArchivePath -DestinationPath $OutputPath -Force
