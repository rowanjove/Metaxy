[CmdletBinding()]
param(
  [string]$CredentialFile = (Join-Path $env:USERPROFILE 'Desktop\Metaxy-生产凭据.txt'),
  [ValidatePattern('^[A-Z]$')]
  [string]$DriveLetter = 'Z'
)

$ErrorActionPreference = 'Stop'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw '请在“以管理员身份运行”的 PowerShell 中执行此脚本。'
}

if (-not (Test-Path -LiteralPath $CredentialFile)) {
  throw "找不到凭据文件：$CredentialFile"
}

if (Get-PSDrive -Name $DriveLetter -ErrorAction SilentlyContinue) {
  throw "盘符 ${DriveLetter}: 已被占用，请换一个盘符。"
}

function Read-Value([string]$Name) {
  $line = Get-Content -LiteralPath $CredentialFile | Where-Object { $_.StartsWith("$Name=") } | Select-Object -First 1
  if (-not $line) { throw "凭据文件缺少字段：$Name" }
  return $line.Substring($Name.Length + 1)
}

$username = Read-Value 'WebDAV 用户名'
$password = Read-Value 'WebDAV 设备密码'
$davUrl = Read-Value 'WebDAV'
$davUri = [Uri]$davUrl
if ($davUri.Scheme -ne 'https') {
  throw 'Windows WebDAV 烟测要求 HTTPS 地址。'
}
$davRoot = $davUri.AbsoluteUri.TrimEnd('/')
$hostToken = $davUri.Host
if ($davUri.Port -ne 443) { $hostToken = "$hostToken@SSL@$($davUri.Port)" } else { $hostToken = "$hostToken@SSL" }
$davPath = $davUri.AbsolutePath.Trim('/')
$uncRoot = "\\$hostToken\DavWWWRoot"
if ($davPath) {
  $uncRoot = "$uncRoot\$($davPath -replace '/', '\')"
}
$service = Get-Service -Name WebClient -ErrorAction Stop
$wasRunning = $service.Status -eq 'Running'
$mounted = $false
$root = "${DriveLetter}:\"
$name = "_metaxy-smoke-$([Guid]::NewGuid().ToString('N').Substring(0, 12))"
$folderA = "${root}${name}"
$folderB = "${root}${name}-moved"

try {
  if (-not $wasRunning) {
    Start-Service -Name WebClient
    (Get-Service -Name WebClient).WaitForStatus('Running', '00:00:15')
  }

  # Keep the password in a PSCredential rather than putting it in net.exe's
  # command-line arguments or printing it to the console.
  $securePassword = ConvertTo-SecureString $password -AsPlainText -Force
  $credential = [Management.Automation.PSCredential]::new($username, $securePassword)
  New-PSDrive -Name $DriveLetter -PSProvider FileSystem -Root $uncRoot -Credential $credential -Persist | Out-Null
  $mounted = $true

  Get-ChildItem -LiteralPath $root -Force | Out-Null
  New-Item -ItemType Directory -LiteralPath $folderA | Out-Null
  Set-Content -LiteralPath (Join-Path $folderA 'sample.txt') -Value 'metaxy-windows-dav-smoke' -NoNewline -Encoding utf8
  Rename-Item -LiteralPath (Join-Path $folderA 'sample.txt') -NewName 'renamed.txt'
  New-Item -ItemType Directory -LiteralPath $folderB | Out-Null
  Move-Item -LiteralPath (Join-Path $folderA 'renamed.txt') -Destination (Join-Path $folderB 'moved.txt')
  if ((Get-Content -LiteralPath (Join-Path $folderB 'moved.txt') -Raw) -ne 'metaxy-windows-dav-smoke') {
    throw '文件内容校验失败。'
  }
  Remove-Item -LiteralPath (Join-Path $folderB 'moved.txt') -Force
  Remove-Item -LiteralPath $folderA -Recurse -Force
  Remove-Item -LiteralPath $folderB -Recurse -Force
  Write-Output "WINDOWS_DAV_SMOKE=PASS DRIVE=${DriveLetter}: URL=$davRoot"
}
finally {
  if (Test-Path -LiteralPath $folderA) { Remove-Item -LiteralPath $folderA -Recurse -Force -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $folderB) { Remove-Item -LiteralPath $folderB -Recurse -Force -ErrorAction SilentlyContinue }
  if ($mounted) { Remove-PSDrive -Name $DriveLetter -Force -ErrorAction SilentlyContinue }
  if (-not $wasRunning -and (Get-Service -Name WebClient).Status -eq 'Running') {
    Stop-Service -Name WebClient -Force -ErrorAction SilentlyContinue
  }
}

