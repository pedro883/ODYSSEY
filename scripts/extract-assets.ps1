# =============================================================================
# Extrai os modelos 3D usados pelo jogo do pacote "Kenney Game Assets All-in-1".
#
# O zip tem 510 MB e 5.032 modelos; o jogo usa ~40. Este script copia só esses
# para public/models/, deixando o repositório em ~2 MB em vez de meio giga.
#
# Todos os assets do pacote são CC0 (domínio público): uso livre, inclusive
# comercial, sem exigência de atribuição. Ainda assim gravamos um CREDITS.md,
# porque creditar quem publicou é o mínimo.
#
# Uso:  npm run assets
#       npm run assets -- "D:\outro\caminho\Kenney.zip"
#
# É idempotente: rodar de novo não refaz o que já existe.
#
# NOTA DE PORTABILIDADE: está em PowerShell, não em Node, porque o Node não tem
# API de zip embutida e a alternativa seria escrever um parser do formato ZIP
# (deflate, data descriptors, central directory) só para isto. Quem estiver em
# Linux/Mac e não tiver o pacote simplesmente não roda o script: o jogo detecta
# a ausência dos modelos e cai no fallback de primitivas.
# =============================================================================

param(
  [string]$Zip = "$env:USERPROFILE\Downloads\Kenney Game Assets All-in-1 3.6.0.zip"
)

$ErrorActionPreference = 'Stop'
$raiz = Split-Path -Parent $PSScriptRoot
$destino = Join-Path $raiz 'public\models'

if (-not (Test-Path $Zip)) {
  Write-Host ""
  Write-Host "  Pacote Kenney nao encontrado em:" -ForegroundColor Yellow
  Write-Host "    $Zip"
  Write-Host ""
  Write-Host "  Baixe em https://kenney.nl/ (Game Assets All-in-1) ou informe o caminho:"
  Write-Host "    npm run assets -- `"D:\caminho\Kenney.zip`""
  Write-Host ""
  Write-Host "  O jogo funciona sem isto: usa as primitivas geradas por codigo." -ForegroundColor DarkGray
  exit 1
}

# -----------------------------------------------------------------------------
# Modelos usados, por pasta de destino.
#
# Os nomes sao buscados DENTRO do pack indicado, sem depender do caminho
# completo: o Kenney nomeia a pasta ora "GLB format", ora "GLTF format", e
# fixar o caminho quebraria na proxima versao do pacote.
#
# TEXTURAS
# Nem todo .glb do Kenney e autocontido. Nature Kit e Space Kit nao usam textura
# nenhuma (cor vem do material), mas Cube Pets e Survival Kit tem um
# "Textures/colormap.png" EXTERNO, referenciado por caminho relativo ao .glb.
# Sem copiar esse arquivo junto, o GLTFLoader reclama e o modelo aparece cinza.
#
# O campo `texturas` cuida disso. Restricao: cada pasta de destino pode receber
# textura de UM pack so, senao dois colormap.png diferentes brigariam pelo mesmo
# caminho. O script verifica isso e aborta se acontecer.
# -----------------------------------------------------------------------------
$mapa = @(
  @{ pasta = 'flora'; pack = 'Nature Kit'; nomes = @(
      'plant_bush', 'plant_bushDetailed', 'plant_bushSmall',
      'grass_large', 'grass_leafsLarge',
      'flower_redA', 'flower_yellowA', 'flower_purpleA',
      'cactus_short', 'cactus_tall',
      'mushroom_red', 'mushroom_redTall', 'mushroom_tanTall',
      'tree_default', 'tree_oak', 'tree_detailed',
      'tree_pineTallA', 'tree_pineDefaultA', 'tree_pineSmallA',
      'tree_palmShort'
  ) },
  @{ pasta = 'rocha'; pack = 'Nature Kit'; nomes = @(
      'rock_largeA', 'rock_largeB', 'rock_largeC'
  ) },
  @{ pasta = 'rocha'; pack = 'Survival Kit'; texturas = @('Textures/colormap.png'); nomes = @(
      'rock-sand-a', 'rock-sand-b', 'rock-sand-c'
  ) },
  @{ pasta = 'deposito'; pack = 'Space Kit'; nomes = @(
      'rock_crystals', 'rock_crystalsLargeA', 'rock_crystalsLargeB'
  ) },
  @{ pasta = 'nave'; pack = 'Space Kit'; nomes = @(
      'craft_speederA', 'craft_speederB', 'craft_miner'
  ) },
  # ---------------------------------------------------------------------------
  # Base construivel.
  #
  # O Space Station Kit e MODULAR: as pecas foram desenhadas para encaixar numa
  # grade, e e exatamente isso que o sistema de construcao explora. Por isso ele
  # nao pode passar pelo achatamento/normalizacao do AssetLibrary (que forca
  # altura 1 e destruiria a grade) - ver src/game/Building.js.
  @{ pasta = 'base'; pack = 'Space Station Kit'; texturas = @('Textures/colormap.png'); nomes = @(
      # A lista espelha `src/assets/buildings.js` — nada aqui que o catalogo nao
      # use, senao o zip de publicacao carrega arte morta.
      # Estrutura
      'floor', 'floor-detail', 'floor-panel', 'stairs-ramp', 'stairs',
      # Vedacao
      'wall', 'wall-corner', 'wall-corner-round', 'wall-door', 'wall-door-wide',
      'wall-window', 'wall-pillar',
      # Protecao
      'rail', 'rail-narrow',
      # Mobilia
      'container', 'container-tall', 'container-flat', 'table', 'chair', 'bed-single',
      # Tecnologia
      'computer', 'computer-wide', 'display-wall', 'table-display-planet', 'structure-panel',
      # Utilidade
      'pipe', 'pipe-bend'
  ) },
  # Multiferramenta em primeira pessoa. Tres silhuetas diferentes para os tres
  # modos (varredura, construcao, terraformagem) - ver src/game/Tools.js.
  @{ pasta = 'ferramenta'; pack = 'Blaster Kit'; texturas = @('Textures/colormap.png'); nomes = @(
      'blaster-d', 'blaster-i', 'blaster-p'
  ) },
  @{ pasta = 'fauna'; pack = 'Cube Pets'; texturas = @('Textures/colormap.png'); nomes = @(
      'animal-crab', 'animal-caterpillar', 'animal-parrot', 'animal-bee',
      'animal-deer', 'animal-fox', 'animal-penguin', 'animal-elephant',
      'animal-giraffe', 'animal-koala'
  ) }
)

Add-Type -AssemblyName System.IO.Compression.FileSystem
Write-Host "Lendo $([System.IO.Path]::GetFileName($Zip))..." -ForegroundColor Cyan
$arquivo = [System.IO.Compression.ZipFile]::OpenRead($Zip)

try {
  # Indexa uma vez: 90 mil entradas, e varrer por modelo seria O(n*m).
  $porPack = @{}
  foreach ($e in $arquivo.Entries) {
    if ($e.FullName -notlike '*.glb') { continue }
    $partes = $e.FullName -split '/'
    if ($partes.Count -lt 2) { continue }
    $pack = $partes[1]
    if (-not $porPack.ContainsKey($pack)) { $porPack[$pack] = @{} }
    $porPack[$pack][[System.IO.Path]::GetFileNameWithoutExtension($e.Name)] = $e
  }

  $copiados = 0; $pulados = 0; $faltando = @(); $bytes = 0

  # Guarda qual pack ja reivindicou textura em cada pasta (ver nota acima).
  $donoDaTextura = @{}

  foreach ($grupo in $mapa) {
    $dir = Join-Path $destino $grupo.pasta
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

    if (-not $porPack.ContainsKey($grupo.pack)) {
      $faltando += "pack inteiro ausente: $($grupo.pack)"
      continue
    }

    foreach ($nome in $grupo.nomes) {
      $alvo = Join-Path $dir "$nome.glb"
      if (Test-Path $alvo) { $pulados++; continue }

      $entrada = $porPack[$grupo.pack][$nome]
      if (-not $entrada) { $faltando += "$($grupo.pack)/$nome"; continue }

      [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entrada, $alvo, $true)
      $copiados++; $bytes += $entrada.Length
    }

    # --- Texturas externas do pack --------------------------------------------
    foreach ($tex in @($grupo.texturas)) {
      if (-not $tex) { continue }

      if ($donoDaTextura.ContainsKey("$($grupo.pasta)/$tex") -and
          $donoDaTextura["$($grupo.pasta)/$tex"] -ne $grupo.pack) {
        throw "Conflito: '$($grupo.pasta)/$tex' seria escrito por '$($donoDaTextura["$($grupo.pasta)/$tex"])' e por '$($grupo.pack)'. Separe os packs em pastas diferentes."
      }
      $donoDaTextura["$($grupo.pasta)/$tex"] = $grupo.pack

      $alvoTex = Join-Path $dir ($tex -replace '/', '\')
      if (Test-Path $alvoTex) { $pulados++; continue }

      # A textura fica ao lado dos .glb do pack; casamos pelo sufixo para nao
      # depender de "GLB format" vs "GLTF format".
      $entradaTex = $arquivo.Entries | Where-Object {
        $_.FullName -like "*/$($grupo.pack)/*/$tex"
      } | Select-Object -First 1

      if (-not $entradaTex) { $faltando += "$($grupo.pack)/$tex"; continue }

      $pastaTex = Split-Path -Parent $alvoTex
      if (-not (Test-Path $pastaTex)) { New-Item -ItemType Directory -Path $pastaTex -Force | Out-Null }
      [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entradaTex, $alvoTex, $true)
      $copiados++; $bytes += $entradaTex.Length
    }
  }
}
finally {
  $arquivo.Dispose()
}

# -----------------------------------------------------------------------------
# Créditos
# -----------------------------------------------------------------------------
$creditos = @"
# Créditos dos assets

Os modelos 3D em ``public/models/`` vêm do pacote **Kenney Game Assets All-in-1**.

- Autor: Kenney — <https://kenney.nl>
- Licença: **CC0 1.0 Universal** (domínio público)
  <https://creativecommons.org/publicdomain/zero/1.0/>

CC0 dispensa atribuição; este arquivo existe por cortesia.

## Packs utilizados

| Pack | Uso no jogo |
|---|---|
| Nature Kit | Vegetação e rochas |
| Survival Kit | Rochas de mundos áridos |
| Space Kit | Nave do jogador e cristais de recurso |
| Space Station Kit | Pecas modulares da base construivel |
| Cube Pets | Fauna (animais animados) |

Extraído por ``npm run assets`` (ver ``scripts/extract-assets.ps1``).
"@
Set-Content -Path (Join-Path $destino 'CREDITS.md') -Value $creditos -Encoding UTF8

Write-Host ""
Write-Host ("  {0} modelos extraidos ({1:N0} KB)" -f $copiados, ($bytes / 1KB)) -ForegroundColor Green
if ($pulados -gt 0) { Write-Host ("  {0} ja existiam" -f $pulados) -ForegroundColor DarkGray }
if ($faltando.Count -gt 0) {
  Write-Host ("  {0} nao encontrados no pacote:" -f $faltando.Count) -ForegroundColor Yellow
  $faltando | ForEach-Object { Write-Host "    - $_" -ForegroundColor Yellow }
  Write-Host "  (o jogo usa a primitiva de fallback para esses)" -ForegroundColor DarkGray
}
Write-Host ""
