# Read-only, fail-closed Windows release preflight for Notion webhook ledgers.
# Run as the EXACT Windows identity that will launch notion-mcp-server.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string[]]$LedgerPaths,
  [string]$ExpectedServiceSid
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not [System.OperatingSystem]::IsWindows()) { throw 'Windows-only preflight' }
$serviceSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if ($ExpectedServiceSid -and $ExpectedServiceSid -ne $serviceSid) {
  throw 'Preflight identity does not match the expected service SID'
}
$trusted = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($sid in @($serviceSid, 'S-1-5-18', 'S-1-5-32-544', 'S-1-3-0')) {
  [void]$trusted.Add($sid)
}
$writeMask = [int64](
  [System.Security.AccessControl.FileSystemRights]::Write -bor
  [System.Security.AccessControl.FileSystemRights]::Modify -bor
  [System.Security.AccessControl.FileSystemRights]::Delete -bor
  [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
  [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
  [System.Security.AccessControl.FileSystemRights]::TakeOwnership
)
function Convert-IdentityToSid([string]$name) {
  if ($name -match '^S-\d(-\d+)+$') { return $name }
  return ([System.Security.Principal.NTAccount]::new($name)).Translate(
    [System.Security.Principal.SecurityIdentifier]).Value
}
function Assert-PrivateAcl([string]$path) {
  $acl = Get-Acl -LiteralPath $path -ErrorAction Stop
  $ownerSid = Convert-IdentityToSid $acl.Owner
  if (-not $trusted.Contains($ownerSid)) {
    throw "Untrusted ACL owner for $path"
  }
  foreach ($ace in $acl.Access) {
    if ($ace.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
    $aceSid = $ace.IdentityReference.Translate(
      [System.Security.Principal.SecurityIdentifier]).Value
    if (([int64]$ace.FileSystemRights -band $writeMask) -ne 0 -and
        -not $trusted.Contains($aceSid)) {
      throw "Writable ACL grants untrusted identity $aceSid on $path"
    }
  }
}
foreach ($candidate in $LedgerPaths) {
  if (-not [System.IO.Path]::IsPathFullyQualified($candidate)) { throw 'Ledger path must be absolute' }
  $full = [System.IO.Path]::GetFullPath($candidate)
  if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
    throw "Ledger must be staged as an existing regular file before preflight: $full"
  }
  $cursor = $full
  while ($cursor) {
    $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Reparse point in ledger path: $cursor"
    }
    $parent = [System.IO.Path]::GetDirectoryName($cursor)
    if (-not $parent -or $parent -eq $cursor) { break }
    $cursor = $parent
  }
  Assert-PrivateAcl $full
  Assert-PrivateAcl ([System.IO.Path]::GetDirectoryName($full))
}
Write-Output "PASS: $($LedgerPaths.Count) ledger file(s) and immediate parent(s) have no untrusted writable ACLs; no reparse components found. Service SID: $serviceSid"
