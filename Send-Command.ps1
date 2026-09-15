param(
    [Parameter(Mandatory=$true)][string]$Command,
    [ValidateRange(1024,65535)][int]$Port = 49731
)
$presenterClient = [System.Net.Sockets.TcpClient]::new()
try {
    $presenterClient.Connect('127.0.0.1', $Port)
    $presenterStream = $presenterClient.GetStream()
    $presenterStream.ReadTimeout = 10000
    $presenterBytes = [System.Text.Encoding]::UTF8.GetBytes($Command + "`n")
    $presenterStream.Write($presenterBytes, 0, $presenterBytes.Length)
    $presenterReader = [System.IO.StreamReader]::new($presenterStream)
    $presenterReader.ReadLine()
} finally {
    $presenterClient.Dispose()
}
