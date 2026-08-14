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

- [ ] **3. Octree no lugar da quadtree**
      A quadtree é 2D, uma por face do cubo. Volume exige subdivisão em três
      eixos. É o passo com mais risco de regressão de desempenho: um bloco de
      32³ tem 32x as amostras de um retalho 32².

- [ ] **4. Colisão e altitude**
      `sampleAt()` hoje responde com uma amostra. Com volume é preciso marchar
      ao longo do raio. Afeta nave, jogador, fauna, projéteis e props — é o
      passo que mais toca código existente.

- [ ] **5. Costuras entre níveis de LOD**
      Hoje resolvidas por saia. Em volume, exige algo como transvoxel, ou
      aceitar rachaduras nas transições.

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
