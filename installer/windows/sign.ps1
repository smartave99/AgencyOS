# Signs files with signtool and a certificate file (PFX), then asks Windows whether each signature
# is valid, so the build never takes the tool's word for it.
#
# Used for a certificate that is delivered as a file, and for the pipeline's self-test. A
# certificate kept in a cloud signing service (Azure Artifact Signing) is signed by its own
# workflow step instead; see docs/AGENCYOS_SIGNING.md.
#
#   sign.ps1 -Files a.exe,b.exe -Pfx cert.pfx -Password <secret> [-NoTimestamp]

param(
  [Parameter(Mandatory = $true)][string[]]$Files,
  [Parameter(Mandatory = $true)][string]$Pfx,
  [Parameter(Mandatory = $true)][string]$Password,
  [string]$TimestampUrl = 'http://timestamp.digicert.com',
  # A signature without a timestamp stops being valid when the certificate expires. Only the
  # self-test, which has no certificate worth keeping, goes without.
  [switch]$NoTimestamp
)

$ErrorActionPreference = 'Stop'

$signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match '\\x64\\' } |
  Sort-Object FullName -Descending |
  Select-Object -First 1
if (-not $signtool) { throw 'signtool.exe was not found on this machine (the Windows SDK is part of the Windows runner image).' }
if (-not (Test-Path $Pfx)) { throw "The certificate file was not found: $Pfx" }

foreach ($file in $Files) {
  if (-not (Test-Path $file)) { throw "Nothing to sign at $file" }
  $arguments = @('sign', '/fd', 'SHA256', '/f', $Pfx, '/p', $Password, '/d', 'AgencyOS')
  if (-not $NoTimestamp) { $arguments += @('/tr', $TimestampUrl, '/td', 'SHA256') }
  $arguments += $file
  & $signtool.FullName @arguments
  if ($LASTEXITCODE -ne 0) { throw "signtool failed for $file (exit $LASTEXITCODE)" }

  $signature = Get-AuthenticodeSignature $file
  if ($signature.Status -ne 'Valid') {
    throw "$file was signed, but Windows does not accept the signature: $($signature.Status) $($signature.StatusMessage)"
  }
  "signed $(Split-Path $file -Leaf) as $($signature.SignerCertificate.Subject)"
}
