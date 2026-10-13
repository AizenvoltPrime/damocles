# Fails unless every file in -Path carries an Authenticode signature and all of them carry the same signer. With
# -RequireTrusted that signer must be the trusted SignPath Foundation release certificate; the test certificate chains to no
# trusted root.
param(
  [Parameter(Mandatory)] [string[]] $Path,
  [switch] $RequireTrusted
)
$ErrorActionPreference = 'Stop'

$problems = @()
$signers = @{}
foreach ($file in Get-Item -Path $Path) {
  $signature = Get-AuthenticodeSignature $file.FullName
  $signer = $signature.SignerCertificate
  if (-not $signer) { $problems += "$($file.FullName): not signed"; continue }
  Write-Host "$($file.FullName): $($signer.Subject) ($($signer.Thumbprint)), status $($signature.Status)"
  $signers[$signer.Thumbprint] = $signer.Subject
  if ($RequireTrusted -and ($signature.Status -ne 'Valid' -or $signer.GetNameInfo('SimpleName', $false) -ne 'SignPath Foundation')) {
    $problems += "$($file.FullName): not validly signed by SignPath Foundation"
  }
}
if ($signers.Count -gt 1) { $problems += "The files carry $($signers.Count) different signers: $($signers.Values -join '; ')" }
if ($problems) { $problems | ForEach-Object { Write-Error $_ -ErrorAction Continue }; exit 1 }
Write-Host "All $(@($Path).Count) files carry the same signature."
