param(
  [Parameter(Mandatory = $true)][string]$OutputDirectory,
  [Parameter(Mandatory = $true)][string]$IpAddress,
  [string]$DnsName = ''
)

$ErrorActionPreference = 'Stop'
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null
$ip = [Net.IPAddress]::Parse($IpAddress)
$now = [DateTimeOffset]::UtcNow

$rootKey = [Security.Cryptography.RSA]::Create(2048)
$rootRequest = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
  'CN=SYSTEM Local Network Root CA', $rootKey,
  [Security.Cryptography.HashAlgorithmName]::SHA256,
  [Security.Cryptography.RSASignaturePadding]::Pkcs1
)
$rootRequest.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true, $false, 0, $true))
$rootUsage = [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign -bor [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::CrlSign -bor [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature
$rootRequest.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new($rootUsage, $true))
$rootRequest.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension]::new($rootRequest.PublicKey, $false))
$root = $rootRequest.CreateSelfSigned($now.AddMinutes(-5), $now.AddYears(10))

$serverKey = [Security.Cryptography.RSA]::Create(2048)
$serverRequest = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
  "CN=$IpAddress", $serverKey,
  [Security.Cryptography.HashAlgorithmName]::SHA256,
  [Security.Cryptography.RSASignaturePadding]::Pkcs1
)
$serverRequest.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true))
$serverUsage = [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment
$serverRequest.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new($serverUsage, $true))
$eku = [Security.Cryptography.OidCollection]::new()
$eku.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1')) | Out-Null
$serverRequest.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($eku, $false))
$san = [Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
$san.AddIpAddress($ip)
$san.AddIpAddress([Net.IPAddress]::Loopback)
$san.AddDnsName('localhost')
if ($DnsName) { $san.AddDnsName($DnsName) }
$serverRequest.CertificateExtensions.Add($san.Build())
$serverRequest.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension]::new($serverRequest.PublicKey, $false))
$serial = [byte[]]::new(16)
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($serial)
$rng.Dispose()
$serverPublicCertificate = $serverRequest.Create($root, $now.AddMinutes(-5), $now.AddYears(2), $serial)
$serverCertificate = [Security.Cryptography.X509Certificates.RSACertificateExtensions]::CopyWithPrivateKey($serverPublicCertificate, $serverKey)
[IO.File]::WriteAllBytes((Join-Path $OutputDirectory 'local-server.pfx'), $serverCertificate.Export([Security.Cryptography.X509Certificates.X509ContentType]::Pfx, ''))
[IO.File]::WriteAllBytes((Join-Path $OutputDirectory 'local-network-root-ca.cer'), $root.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert))
$manifest = @{ ip_address = $IpAddress; generated_at_utc = $now.ToString('o'); expires_at_utc = $now.AddYears(2).ToString('o') } | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $OutputDirectory 'lan-certificate.json'), $manifest, [Text.UTF8Encoding]::new($false))
$root.Dispose(); $rootKey.Dispose(); $serverPublicCertificate.Dispose(); $serverCertificate.Dispose(); $serverKey.Dispose()
Write-Output "Generated trusted-local-network certificate for $IpAddress"
