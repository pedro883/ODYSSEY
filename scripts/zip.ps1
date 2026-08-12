# Empacota o conteúdo de dist/ para upload no File Manager da hospedagem.
#
# Fica num arquivo .ps1 em vez de inline no package.json de propósito: o npm
# no Windows executa scripts via cmd.exe, que reinterpreta parênteses e aspas
# e quebra qualquer comando PowerShell minimamente estruturado.

$ErrorActionPreference = 'Stop'
$raiz = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $raiz 'dist'
$zip = Join-Path $raiz 'odyssey-deploy.zip'

if (-not (Test-Path $dist)) {
  Write-Error "Pasta dist/ nao encontrada. Rode 'npm run build' antes."
}

if (Test-Path $zip) { Remove-Item $zip -Force }

# -Force no Get-ChildItem e obrigatorio: sem ele o .htaccess (arquivo oculto
# no Windows) fica de fora e o site sobe sem compressao nem cache.
#
# `.FullName` e obrigatorio: passando os objetos direto, o Compress-Archive
# usa o nome relativo ("assets") e falha quando o diretorio de trabalho nao e
# o dist/ — que e sempre o caso quando o script roda pelo npm.
$itens = (Get-ChildItem -Path $dist -Force).FullName
Compress-Archive -Path $itens -DestinationPath $zip

$tamanho = (Get-Item $zip).Length / 1KB
Write-Output ("odyssey-deploy.zip pronto ({0:N0} KB)" -f $tamanho)

Add-Type -AssemblyName System.IO.Compression.FileSystem
$arquivo = [System.IO.Compression.ZipFile]::OpenRead($zip)
$arquivo.Entries | ForEach-Object { Write-Output ("  {0}" -f $_.FullName) }
$arquivo.Dispose()
