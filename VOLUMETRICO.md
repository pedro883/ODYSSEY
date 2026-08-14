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

- [ ] **2. Malhar um chunk volumétrico no worker**
      Nova mensagem no worker, ao lado de `buildChunk`. Entrega o mesmo formato
      de payload (positions/normals/colors/indices) para o `ChunkManager` não
      precisar saber a diferença ainda. Critério: um chunk volumétrico com as
      cavernas desligadas tem de coincidir com o chunk de altura equivalente
      dentro da tolerância do tamanho de célula.

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
