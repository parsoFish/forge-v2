# Simplarr — powershell entry point.
param(
  [Parameter(Mandatory=$true, Position=0)]
  [ValidateSet('init', 'apply', 'revert')]
  [string]$Command,

  [Parameter(ValueFromRemainingArguments=$true)]
  [string[]]$Rest
)

switch ($Command) {
  'init'   { . "$PSScriptRoot/Cmd-Init.ps1" @Rest }
  'apply'  { . "$PSScriptRoot/Cmd-Apply.ps1" @Rest }
  'revert' { . "$PSScriptRoot/Cmd-Revert.ps1" @Rest }
}
