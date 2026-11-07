param(
    [Parameter(Mandatory = $true)]
    [uri]$WorkerUrl
)

if ($WorkerUrl.Scheme -ne 'https' -or $WorkerUrl.UserInfo -or $WorkerUrl.Query -or $WorkerUrl.Fragment) {
    throw 'Provide your HTTPS Worker origin, for example https://tms-api.example.workers.dev'
}

$tmsApiOrigin = $WorkerUrl.GetLeftPart([System.UriPartial]::Authority)
$tmsTokenSecure = Read-Host 'Enter your Worker ADMIN_TOKEN (hidden)' -AsSecureString
$tmsTokenPlain = [System.Net.NetworkCredential]::new('', $tmsTokenSecure).Password
try {
    Invoke-RestMethod -Method Post -Uri "$tmsApiOrigin/api/mqtt/test" `
        -Headers @{ Authorization = "Bearer $tmsTokenPlain" } -TimeoutSec 20
} finally {
    Remove-Variable tmsTokenPlain, tmsTokenSecure -ErrorAction SilentlyContinue
}
