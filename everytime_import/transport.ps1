$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
    $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if ($payload.identifier -cnotmatch '^[A-Za-z0-9_-]{1,100}$') {
        throw 'Invalid identifier'
    }
    $response = Invoke-WebRequest -UseBasicParsing `
        -Uri 'https://api.everytime.kr/find/timetable/table/friend' `
        -Method Post -ContentType 'application/x-www-form-urlencoded' `
        -Body @{identifier = $payload.identifier; friendInfo = 'true'} `
        -TimeoutSec 30
    @{ok = $true; status = [int]$response.StatusCode; xml = [string]$response.Content} |
        ConvertTo-Json -Compress -Depth 3
} catch {
    $statusCode = $null
    if ($null -ne $_.Exception.Response) {
        $statusCode = [int]$_.Exception.Response.StatusCode
    }
    @{ok = $false; status = $statusCode; error = 'request_failed'} |
        ConvertTo-Json -Compress
    exit 1
}
