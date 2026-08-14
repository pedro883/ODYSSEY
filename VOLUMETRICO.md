# Migração para terreno volumétrico

Objetivo: cavernas. Um campo de altura não as comporta — dentro de uma, olhando
para cima, há teto acima e chão abaixo na mesma direção, e `heightAt` devolve um
número só.

## Regra da migração

O pipeline novo cresce **ao lado** do atual, atrás de `?volumetrico=1`. O jogo
tem de continuar jogável em todo commit. Nada é apagado antes de o substituto
estar verificado.

A ponte que torna isso possível:

```
d(p) = |p| - (raio + heightAt(p/|p|))
```

O cruzamento por zero é exatamente a superfície de hoje. Logo o mesher pode ser
**exigido a reproduzir o terreno atual** antes de ganhar qualquer feição 3D, e
toda divergência é defeito do mesher, não mudança de conteúdo.

## Passos

- [x] **1. Campo de densidade e marching cubes** (`486bca1`)
      Módulos puros, verificados contra esfera (Euler 2, volume 99,59%) e toro
      (Euler 0, quatro cruzamentos numa direção).

- [x] **2a. Malhar um chunk volumétrico (módulo puro)**
      `chunkVolumetrico.js`, sobre grade ESFÉRICA `(u, v, raio)` e não
      cartesiana. Critério do plano cumprido: com as cavernas desligadas o erro
      médio contra a superfície de altura é **0,009 unidade** (tolerância ~2,3),
      e nenhuma normal aponta para baixo. Com as cavernas ligadas, 2,6% das
      normais apontam para baixo — teto de caverna, a coisa que o campo de
      altura não representa.

      **A grade esférica é o que torna o volumétrico viável.** `heightAt` custa
      0,88 µs (~20 oitavas). Numa grade cartesiana de 43³ seriam 79.507
      chamadas, 70 ms por chunk. Numa grade esférica a altura depende só da
      direção, então é uma chamada por coluna: **1.225 — exatamente o mesmo
      número que o chunk de altura de hoje**. A parte cara custa igual; o que se
      acrescenta é o trabalho barato por amostra.

      Medido: 5,2 ms sem cavernas, 8,9 ms com (era 47 ms antes de a otimização
      ser de fato ligada — eu tinha montado a tabela de alturas e continuava
      chamando `densidadeEm`, que a recalculava).

- [x] **2b. Ligado no worker, atrás de `?volumetrico=1`**
      `construirChunkVolumetrico` convive com `buildChunk`; quem decide é a
      REQUISIÇÃO, não o worker — o que permite, mais adiante, só os níveis finos
      serem volumétricos. O payload ganhou `indices` (a topologia de altura é
      compartilhada entre chunks, a volumétrica é própria de cada um).

      A cor sai de `colorAt` como antes, mas o declive vem da NORMAL e não de
      amostras vizinhas do relevo: em parede de caverna não existe "relevo
      vizinho" que faça sentido.

      Verificado no jogo: 252 chunks, 301 malhas, 658 mil triângulos, mundo
      pronto e navegável.

      **Pendências conhecidas deste passo:** props não são gerados no caminho
      volumétrico (devolve array vazio), e as cavernas existem mas ainda não há
      como descer até elas.

- [x] **3a. Protocolo de faixa radial**
      O chunk passou a ser pedido por FAIXA DE PROFUNDIDADE abaixo da superfície
      local, e não por raios absolutos. É a coordenada natural do problema (as
      cavernas são definidas por profundidade), e um relevo que varia 200
      unidades dentro do chunk faria uma faixa absoluta cobrir a superfície num
      canto e o subsolo no outro.

      Verificado: a faixa 0 devolve V2901 F5524 — bit a bit o mesmo de antes.
      As faixas fundas mostram o que estava invisível: a faixa 200..310 tem 2.599
      vértices de caverna que nunca eram desenhados.

- [~] **3b. Faixas fundas — escrito, NÃO verificado numa descida real**
      `CascaProfunda.js`. Evita a reescrita do `QuadTreeNode` com uma observação:
      as faixas profundas só interessam ONDE O JOGADOR ESTÁ, então não precisam
      de LOD, cache nem hierarquia — só de um punhado de blocos que nascem
      quando ele desce e somem quando sobe. Isso cabe num mapa à parte, e o
      recorte angular vem das folhas da quadtree (que já subdivide na direção da
      câmera), o que evita inverter a projeção do cubo esferificado.

      **Estado honesto:** a lógica funciona quando chamada diretamente — pedi e
      despachei 4 blocos para a faixa correta. Mas NÃO consegui verificar numa
      descida de verdade: o laço do jogo reposiciona a câmera a cada quadro e a
      bancada não consegue segurar o observador dentro da caverna. Sem essa
      verificação, considere o recurso não comprovado.

      Não afeta quem joga sem `?volumetrico=1`.

- [x] **4a. Sonda do campo (`sonda.js`)**
      `chaoAbaixo`, `tetoAcima`, `solidoEm` por marcha radial com bisseção.

      **A marcha é barata pelo mesmo motivo que o chunk é**: ela é RADIAL, a
      direção não muda ao longo dela, e a altura da superfície só depende da
      direção. `heightAt` é avaliado uma vez por marcha, não por passo. Medido:
      3,7 µs por marcha de 400 unidades, contra 0,88 µs de um `heightAt` sozinho
      — sem o truque seriam ~176 µs.

      Verificado: sem cavernas a sonda acha o chão em 400 de 400 direções com
      erro máximo de 0,0002 unidade, isto é, reproduz a colisão de hoje.

- [x] **4b. `sampleAt` consulta a sonda**
      Mudança em UM ponto — `Planet.sampleAt` — em vez de nas oito chamadas
      espalhadas. Tudo a jusante (altitude, pouso, colisão, fauna, projéteis)
      passou a funcionar dentro de caverna sem saber que algo mudou.

      **A guarda é o que mantém o custo.** A sonda custa 3,7 µs contra 0,88 µs
      de uma amostra, e `sampleAt` roda dezenas de vezes por quadro. Mas
      cavernas só existem ABAIXO da superfície (`margemTeto` garante rocha
      maciça sob ela), então quem está acima do relevo já tem a resposta certa e
      não marcha. Só paga quem está de fato dentro de uma caverna.

      Verificado no jogo: de um ponto dentro de uma caverna a 135 unidades de
      profundidade, `sampleAt` devolve o PISO DA CAVERNA (4290,4) e não a
      superfície lá fora (4425,6), com altitude de 3,27 unidades acima do piso.

- [x] **6a. Props no caminho volumétrico**
      `scatterProps` serviu sem adaptação: desde que passou a usar uma grade
      global de células (a correção dos props que saltavam entre LODs), ele é
      independente da malha. 5.651 instâncias na superfície, 50 de 56 chunks.

- [x] **7. Bocas de caverna**
      Campo de baixa frequência com limiar alto suspende a margem de teto onde
      é forte. Raro e contíguo de propósito: entrada de caverna deve ser algo
      que se PROCURA, não um crivo na paisagem.

      Medido, isolando o efeito na faixa rasa (<=6 unidades da superfície):

        sem bocas ........... 0,00% das direções abertas (superfície selada)
        bocas limiar 0,45 ... 0,75%
        bocas limiar 0,55 ... 0,48%   <- escolhido, ~1 em 200
        bocas limiar 0,65 ... 0,37%

      Perfil vertical de uma boca real no jogo: sólido na superfície, VAZIO de 5
      a 35 unidades, sólido de novo aos 45. Um poço com 40 unidades de vão.

## Pendências conhecidas

- [x] **6b. Props não nascem sobre bocas.** Uma amostra de densidade 1,5 unidade
  abaixo da superfície responde se ali há rocha; se não há, a célula é boca e
  não recebe prop. Custa uma avaliação barata (a altura já está calculada) e só
  nos chunks volumétricos. 5.651 props na superfície, nenhum pairando.
- **Passo 3 (octree) e passo 5 (costuras de LOD) não foram feitos.** A quadtree
  atual subdivide só nos eixos angulares, então a casca radial tem espessura
  fixa: cavernas mais fundas que ~90 unidades abaixo da elevação mínima não são
  desenhadas, ainda que a sonda as encontre.
- **Sem captura visual limpa de uma boca.** A verificação é numérica. As
  tentativas de fotografar puseram a câmera dentro da geometria.

- [x] **5a. Costura entre chunks do MESMO nível**
      A causa não era o LOD: cada chunk derivava a retícula radial do PRÓPRIO
      relevo, então dois vizinhos amostravam raios diferentes —

        A: 4299,26  4303,91  4308,55 ...  (passo 4,649)
        B: 4299,92  4304,70  4309,48 ...  (passo 4,777)

      e os vértices interpolados no plano de contato caíam em raios diferentes.
      Medido: ZERO vértices de borda coincidiam, e o vizinho mais próximo estava
      a 1,8 unidade.

      Com a retícula radial ancorada numa grade GLOBAL (passo fixo, início num
      múltiplo dele), os dois passaram a partir do mesmo rMin e 28 vértices de
      borda têm par EXATO. O número de camadas passa a variar com o relevo
      local, que é o preço, e é barato.

- [x] **5b. Costura entre níveis DIFERENTES — resolvida por SAIA**
      Entre níveis diferentes não há como casar: o chunk fino tem o dobro de
      amostras angulares na borda, então sobram vértices em T. A saída canônica
      é o transvoxel (tabela nova, bastante código); a escolhida é a saia, que é
      o que o caminho de campo de altura já usa aqui.

      Ela não fecha a fresta — esconde. Cada aresta de borda vira uma cortina
      descendo 7,6 unidades, com a normal herdada do vértice de cima (normal
      própria acenderia diferente e criaria a linha que a saia existe para
      esconder). A orientação vem da aresta dirigida do triângulo dono, senão a
      cortina apareceria preta.

      Medido: 85,8% dos vértices seguem na superfície com mediana de erro
      0,0002 u; os outros 14,2% são a saia, exatamente a 7,60 u abaixo. Custo
      +0,6 ms por chunk.

      **Antes disso ficou provado que o mesmo nível já estava perfeito**: as
      posições coincidem e as normais divergem 0,01 grau.

- [ ] **6. Bioma, cor, props e oceano**
      Todos derivam de `heightAt`. Precisam de critério novo: a cor passa a
      depender da normal e da profundidade, não só da elevação.

- [ ] **7. Entradas de caverna como conteúdo**
      Escolher regiões onde um túnel sobe até a margem do teto, em vez de deixar
      o ruído abrir buracos aleatórios no chão.

## Riscos aceitos

- **Custo de CPU e memória por chunk sobe muito.** Mitigação: medir a cada
  passo, e o interruptor permite comparar lado a lado.
- **`densidadeEm` não é distância mínima real**, e sim radial. Enviesa a
  interpolação em paredes quase verticais e impede sphere tracing sem fator de
  segurança. É a aproximação que praticamente todo terreno volumétrico usa.
- **Quatro sistemas hoje estáveis** (LOD, colisão, oceano, props) serão
  reescritos. Era o argumento contra este caminho; foi uma decisão tomada com
  conhecimento do custo.
