# Projeto Odyssey — PoC de universo procedural seamless

Prova de conceito de um jogo web 3D no estilo *No Man's Sky*: um sistema
estelar gerado proceduralmente, voo livre entre planetas, **transição contínua**
do espaço até o pouso e exploração a pé — sem tela de carregamento em nenhum
momento.

Three.js `0.185` + Vite `8` + Web Workers, mais
[EZ-Tree](https://www.eztree.dev/) (`@dgreenheck/ez-tree`, MIT) para as árvores
procedurais.

```bash
npm install
npm run dev
```

`http://localhost:5173/?seed=12345` reproduz sempre o mesmo sistema estelar.
Sem o parâmetro, o seed é aleatório.

### Modelos 3D

Os `.glb` em `public/models/` **estão versionados** — o jogo roda direto após o
`npm install`. Eles vêm do pacote *Kenney Game Assets All-in-1* (CC0) e são
extraídos por:

```bash
npm run assets
```

O script procura o zip em `~/Downloads` e copia só os ~42 modelos usados (1,8 MB
de um pacote de 510 MB). Para apontar outro caminho:
`npm run assets -- "D:\caminho\Kenney.zip"`.

**Sem os modelos o jogo continua jogável**: `AssetLibrary` detecta a ausência e
cada sistema cai nas primitivas geradas por código (cones, icosaedros), com um
aviso no console. A fauna, que depende de animação embutida no arquivo,
simplesmente não aparece. Créditos em `public/models/CREDITS.md`.

---

## 1. O que está implementado

| | |
|---|---|
| **Sistema estelar** | 4–5 corpos reais (planetas + lua), todos com terreno, atmosfera e vegetação, na mesma cena desde o boot |
| **Voo** | 6DOF com booster, gravidade local, colisão e pouso |
| **Pulse drive** | Cruzeiro interplanetário a 26 000 u/s, com engate em rampa e corte automático ao chegar |
| **Transição seamless** | Espaço → atmosfera → superfície, tudo função contínua da altitude |
| **A pé** | Primeira pessoa sobre a esfera, corrida, pulo e **jetpack** com combustível |
| **Nave ↔ piloto** | Sair e embarcar a qualquer momento, com a nave ficando estacionada onde foi deixada |
| **Vegetação** | Modelos `.glb` reais (Kenney) por `InstancedMesh`, distribuídos por bioma, com até 4 variantes por tipo escolhidas pela classe do planeta |
| **Árvores** | Geradas por [EZ-Tree](https://www.eztree.dev/) a partir do seed: tronco e copa como partes separadas, com casca e folhagem de cores independentes e variação de matiz por indivíduo |
| **Nuvens volumétricas** | Ray marching de fBm 3D numa casca esférica, com Beer-Lambert, termo *powder* e fase para frente; cobertura, altitude e vento sorteados por planeta |
| **Vento** | Balanço por vértice em toda a vegetação instanciada, com fase derivada da matriz de instância |
| **Fauna** | 2–3 espécies por mundo, sorteadas de 10 modelos animados; máquina de estados `idle`/`walk`/`eat`/`run`, fuga ao se aproximar, matiz e porte próprios de cada planeta |
| **Multiferramenta** | Pulso de varredura e feixe de mineração |
| **Áudio** | Tudo sintetizado em Web Audio, sem um único arquivo: motor que muda de timbre com o acelerador, vento que só existe onde há atmosfera, pulse, feixe, passos, pouso e jingle de descoberta |
| **Descobertas** | Catálogo de planetas e espécies com nomes procedurais e recompensa em unidades |
| **Inventário** | Slots com empilhamento, 4 recursos, recurso "assinatura" por planeta |
| **HUD** | Telemetria, navegação, carga, marcadores projetados na tela, prompts contextuais |
| **Mapa galáctico** | 178 mil sistemas amostrados sob demanda de um hash do endereço; câmera amortecida, voo livre pela galáxia, seleção em espaço de tela e salto interestelar com troca de universo no auge do clarão |
| **Multijogador por sistema** | Sala por WebSocket dividida em **canais**: cada sistema estelar tem o próprio mundo compartilhado (posição, colheita, construção, escavação), e saltar é trocar de canal — dois jogadores só se veem se estiverem no mesmo lugar da galáxia |
| **Chat** | Dois alcances: **sistema** (o canal) e **global** (a sala inteira), com autor carimbado pelo servidor |
| **Descoberta de sistemas** | Todo sistema tem nome único e dono: quem chega primeiro fica registrado no banco, e a ficha do mapa mostra por quem e quando |
| **Oceano** | Casca no nível do mar com shader próprio: profundidade amostrada do relevo, quatro escalas de onda, espuma na arrebentação e nas cristas, e cor que se aprofunda com o fundo |
| **Nadar** | Empuxo, arrasto e mergulho, com a transição andar → nadar contínua pela fração do corpo submersa, e névoa densa debaixo d'água |
| **Clima** | Chuva, tempestade, neve, ventania de areia e neblina, **deduzidos** da umidade e da temperatura do lugar mais um campo lento no tempo — dois jogadores veem a mesma chuva sem trocar um byte |
| **Construção de bases** | 27 peças modulares do Kenney Space Station Kit em 6 categorias, numa grade tangente à superfície, com custo em recursos, encaixe assistido, prévia com moldura, animação e som ao assentar, demolição com devolução integral, colisão contra paredes e piso, sincronia na sala e gravação em MySQL |
| **Terreno deformável** | Cavar e elevar o solo com o terraformador, **permanente e compartilhado**: a deformação é uma camada somada ao ruído, sincronizada na sala e gravada no banco, com orçamento e descarte do mais antigo |
| **Terreno sob a base** | O relevo se aplaina sozinho embaixo do que se constrói, e o platô é recalculado por cada cliente a partir das peças — nada disso trafega |
| **Equipamento** | Barra de três ferramentas (multiferramenta, construtor, terraformador) com mãos e arma em primeira pessoa, balanço de passo, coice ao usar e gesto de saque na troca |
| **Painel (Tab)** | Inventário em grade com ícones próprios de cada recurso e catálogo de construção por categoria, com miniatura 3D gerada da própria peça e custo em "tenho/preciso" |
| **Voltar onde parou** | A sessão seguinte começa no ponto exato em que a anterior terminou — corpo, posição, modo (nave ou a pé), olhar e a nave estacionada onde ficou |

### Números medidos

Intel Iris Xe (integrada), a pé, LOD no máximo, 4 corpos no sistema:

| | |
|---|---|
| Custo de CPU por frame | **4,5 ms** (LOD 0,35 · scanner 0,09 · props 0,00 · física 0,01) |
| Chunks visíveis | 732 |
| Instâncias de vegetação | 3 328 |
| Draw calls | 125 |
| Triângulos renderizados | 365 k |
| Nível de LOD máximo | 9 (menor chunk ≈ 13 u, ~0,4 u por quad) |

Depois da troca das primitivas por modelos reais e da entrada da fauna, medido
na mesma máquina, a pé, com 12 criaturas vivas:

| | |
|---|---|
| Fauna | **0,64 ms** de CPU por frame — abaixo do teto de 1 ms que manteria o pool em 12 |
| Malhas de fauna | 76 (≈6,3 por criatura: os Cube Pets animam por hierarquia de nós, então não dá para mesclar) |
| Draw calls de props | 10 (eram 4: agora é um por par tipo×variante) |
| Texturas na GPU | 4 — os 13 modelos texturizados compartilham 2 colormaps |

Depois das árvores procedurais, das nuvens e do vento — medido **em GPU
dedicada**, no meio de uma floresta (seed 12345, planeta 3), a pé:

| | |
|---|---|
| Triângulos renderizados | 1,5 M (dos quais ~720 k são árvores) |
| Draw calls | ~237 (as árvores custam 2 por variante: casca + copa) |
| Custo das nuvens | +0,16 ms por frame ao nível do solo; ruído de medição em órbita |
| Demanda de árvores na floresta | 4 685 — o teto desenha as 900 mais próximas |
| Bundle | +4 MB: o EZ-Tree embute as texturas de casca e folha como data URI |

> **Orçamento.** A referência do projeto é uma Iris Xe integrada, então
> `MAX_INSTANCES[TREE]` (`PropScatter.js`) e o teto de passos em `Clouds.js`
> nascem conservadores. Em GPU dedicada, 600 árvores por variante e 48 passos
> de nuvem rodam folgados — são os dois primeiros números a subir.

---

## 2. Arquitetura

```
src/
├── main.js                    Bootstrap, modos nave/a pé, ordem do frame
│
├── core/
│   ├── Engine.js              Renderer, câmera, loop, resize, FPS
│   └── GameState.js           A TRANSIÇÃO: névoa, luz e exposição vs. altitude
│
├── world/
│   ├── StarSystem.js          N planetas + UM pool de workers + roteamento
│   ├── PlanetConfig.js        seed (1 inteiro) -> todos os parâmetros do planeta
│   ├── Planet.js              Corpo completo: quadtrees + oceano + atmosfera + props
│   ├── QuadTreeNode.js        Nó de LOD: split/merge sem buracos, horizon culling
│   ├── ChunkManager.js        Fila priorizada, index compartilhado, cache LRU
│   ├── PropScatter.js         Vegetação/rochas/depósitos com InstancedMesh
│   ├── Weather.js             Chuva/neve/areia deduzidas do lugar e da hora
│   └── StarField.js           Campo de estrelas e estrela do sistema
│
├── galaxy/
│   ├── GalaxyMap.js           178 mil sistemas sob demanda, navegação e seleção
│   ├── Nebula.js              Fundo de nebulosa por ruído
│   └── WarpJump.js            Túnel do salto e troca de universo no clarão
│
├── shared/                    ── IMPORTADO PELA MAIN THREAD **E** PELO WORKER ──
│   ├── noise.js               Simplex 3D seedável, fBm, ridged multifractal
│   ├── terrain.js             Cube-sphere, campo de altura, biomas e cores
│   ├── galaxy.js              Endereço, nome único e amostragem de sistemas
│   ├── edits.js               Camada de escavações somada ao relevo
│   └── props.js               Pesos de espalhamento por bioma, recursos
│
├── workers/
│   ├── terrain.worker.js      Geometria + espalhamento de props, multi-planeta
│   └── WorkerPool.js          Pool compartilhado com balanceamento por carga
│
├── shaders/
│   ├── AtmosphereShader.js    Single scattering Rayleigh + Mie
│   ├── OceanShader.js         Oceano: profundidade do relevo, ondas, espuma
│   └── SurfaceDetail.js       Grão e relevo do terreno, injetados por onBeforeCompile
│
├── entities/
│   ├── Ship.js                Modelo da nave (primitivas)
│   └── WarpLines.js           Riscos de velocidade do pulse drive
│
├── controls/
│   ├── ShipController.js      Voo, pulse drive, colisão, câmera de perseguição
│   └── PlayerController.js    Caminhada em primeira pessoa sobre a esfera
│
├── game/
│   ├── Inventory.js           Slots com empilhamento
│   ├── Discovery.js           Catálogo e nomes procedurais
│   └── Scanner.js             Pulso de varredura + feixe de mineração
│
├── net/Multiplayer.js         Sala: canal por sistema, avatares, chat
│
├── dev/
│   ├── Harness.js             Bancada de inspeção (`?dev=1`)
│   └── Capturas.js            Fotografa o jogo em disco (§3.17.1)
│
└── ui/HUD.js                  Overlay HTML/CSS + marcadores projetados
```

O servidor de sala vive fora de `src/`, em `server/` (`mp-server.js` e `db.js`),
porque roda no Node e não passa pelo Vite.

### A decisão estrutural: `shared/` é importado dos dois lados

`shared/terrain.js` roda **no worker** (para gerar a malha) e **na main thread**
(altitude da nave, posicionamento dos nós, bioma, colisão a pé). Como o campo de
ruído é determinístico a partir do seed, os dois lados concordam exatamente.

Se fossem duas implementações, o jogador afundaria no terreno visível — um bug
clássico e desagradável de diagnosticar. Por isso `shared/` não importa
Three.js: o worker não deve carregar a engine inteira. O bundle do worker sai
com **9 kB**.

### Ordem de atualização do frame

```
1. fundo estelar    -> direção do sol deste frame (dia/noite)
2. planeta ativo    -> o corpo cuja SUPERFÍCIE está mais perto governa tudo
3. física           -> nave OU jogador a pé
4. estado do jogo   -> lê a nova altitude, ajusta névoa/luz/exposição
5. câmera           -> posição final deste frame
6. LOD dos planetas -> subdivide em torno da câmera JÁ atualizada
7. ferramentas + HUD
```

Atualizar o LOD antes de mover a câmera custa um frame de atraso na
subdivisão — visível como terreno que "engrossa" tarde ao mergulhar.

---

## 3. Como funciona cada peça

### 3.0 A escala do corpo entra na config, não depois

Luas e planetas menores/maiores saem do mesmo sorteio, multiplicado por uma
escala. **Onde** essa multiplicação acontece é uma armadilha que já custou dois
bugs de gameplay: ela era aplicada em `StarSystem`, depois do `new Planet(...)`.

Naquele momento o planeta já tinha criado o sampler de colisão, **enviado a
config ao worker** (structured clone — uma cópia, que nunca mais vê a alteração)
e construído as malhas de atmosfera e de nuvens. Resultado: o terreno que se vê
nascia com o raio sorteado, enquanto `sampleAt()` — altitude, gravidade, pouso e
colisão — passava a usar o raio escalado.

| corpo | escala | efeito do bug |
|---|---|---|
| lua | 0,42 | raio de colisão 58% menor que o visível: a nave **atravessava o solo** e só parava lá dentro |
| planeta externo | até 1,3 | raio de colisão maior que o visível: a nave **"pousava" no ar**, e o jogo oferecia sair da nave no vazio |

A escala agora é argumento de `createPlanetConfig(seed, scale)` e tudo deriva
dela. O sorteio acontece na escala 1 e só depois é multiplicado, para que a
escala não consuma números do gerador — senão a mesma seed daria outro mundo.

Verificação: comparando 16 924 vértices vindos do worker contra
`sampler.heightAt()` na lua, o erro mediano e o p95 são **exatamente 0**.

### 3.0.1 Origem flutuante

Um `float32` tem 24 bits de mantissa: ~7 dígitos **significativos**, não 7 casas.
A precisão absoluta piora com a distância à origem:

| distância | menor diferença representável |
|---|---|
| 1 000 | 0,00006 u |
| 60 000 | 0,004 u |
| 1 000 000 | 0,06 u |

As posições em JS são `float64`, então a CPU não sofre — o problema é a GPU,
que recebe as matrizes em `float32`. A 1 000 000 de unidades o erro é de
centímetros e **muda a cada frame** conforme a câmera anda: uma nave parada
começa a tremer.

`core/FloatingOrigin.js` recentraliza tudo quando a câmera passa de 4 096
unidades: subtrai a posição dela de todo objeto absoluto e acumula o
deslocamento em `origin` (que fica em `float64` e nunca perde precisão).

**A regra que não pode ser quebrada**: o rebase é atômico. Um objeto esquecido
não fica "um pouco errado" — ele salta milhares de unidades de uma vez. Por
isso o registro é explícito, e não uma varredura de `scene.children`: o campo
de estrelas, por exemplo, acompanha a câmera de propósito e **não** deve
deslocar.

Dois cuidados que o rebase expôs:

- **Uniforms com posição de mundo precisam ser reescritos todo frame.** O
  centro do planeta ia para os shaders de atmosfera e de nuvens uma única vez,
  na construção. Com origem flutuante isso deixaria o céu para trás no primeiro
  rebase.
- **Ele roda depois da câmera e antes do LOD.** Depois da câmera porque é a
  posição dela que define o deslocamento; antes do LOD porque a quadtree
  subdivide em torno da câmera.

Verificação: com um rebase de 1 136 unidades forçado entre dois frames, as
distâncias câmera–nave, nave–planeta e planeta–planeta, a altitude e a posição
absoluta reconstruída mudaram **exatamente 0**; a imagem ficou idêntica exceto
por 1 pixel em 230 400 (arredondamento).

### 3.1 Sistema estelar com um pool compartilhado

Todos os corpos existem na cena desde o boot; o que muda com a distância é o
nível de detalhe, e disso a quadtree já cuida. É por isso que chegar num
planeta não tem carregamento: não há nada para carregar, só para subdividir.

Um **único** pool de workers atende todos os planetas (`{ type:'register',
planetId, config }` uma vez por corpo, depois `planetId` em cada job). Quatro
planetas × 6 workers seriam 24 threads disputando 8 núcleos, com troca de
contexto constante e nenhum ganho — só um planeta está perto da câmera por vez.

### 3.2 LOD: cube-sphere + quadtree

O planeta é um cubo de 6 faces projetado numa esfera; cada face é a raiz de uma
quadtree. Como só subdivide perto da câmera, o custo é O(log da distância) em
vez de O(área do planeta).

Detalhes que fazem diferença:

- **Projeção "spherified cube"**, não normalização simples — a normalização
  concentra vértices nos cantos do cubo e o LOD fica desigual.
- **Distância até a BORDA do chunk**, não até o centro — sem isso um chunk
  grande visto de rasante nunca subdivide.
- **Centro do nó deslocado pelo relevo** — com o raio médio, o LOD subdivide
  tarde demais no alto de uma montanha.
- **Horizon culling** — o frustum não resolve o outro lado do planeta: aqueles
  chunks estão dentro do campo de visão, só escondidos pela curvatura. Voando
  baixo, sem esse teste eles seriam subdivididos ao máximo sem nunca aparecer.
- **Cache LRU** (220 chunks) — voar em círculos faz os mesmos chunks entrarem e
  saírem; com cache o retorno é instantâneo.

### 3.3 LOD sem buracos e sem z-fighting

A geração é assíncrona: quando um nó decide dividir, os filhos ainda não estão
na GPU. Duas armadilhas:

- esconder o pai imediatamente → abre um buraco por onde se vê o espaço;
- mostrar pai **e** filhos → duas superfícies coplanares brigando no depth buffer.

A invariante em `QuadTreeNode.update()` é: **exatamente um nível cobre cada
área**. Ou o pai desenha (e a subárvore inteira fica escondida), ou os 4 filhos
estão prontos e o pai sai de cena. O retorno booleano de `update()` propaga essa
garantia recursivamente.

As fissuras entre níveis vizinhos são fechadas com **saias** cuja profundidade
acompanha o relevo local do chunk.

### 3.4 Vegetação com `InstancedMesh`

Cada tipo de prop custa **uma** draw call, independente de haver 10 ou 8000
instâncias.

Três decisões que só ficam óbvias depois de errar:

1. **Densidade constante por ÁREA.** Um número fixo de candidatos por chunk é o
   erro tentador: a área cai 4× a cada nível de LOD, então a mesma contagem
   produz 4× mais props por metro quadrado no nível seguinte — o planeta vira
   um tapete de pedras exatamente onde o jogador chega mais perto. O número de
   células é derivado do tamanho do chunk.

2. **Props seguem a VISIBILIDADE do chunk, não sua existência.** Um chunk de
   nível 8 já dividido continua carregado (só escondido, enquanto os filhos
   desenham). Sem `PropScatter.setVisible()`, seus props continuariam na malha
   instanciada por cima dos props dos filhos — vegetação duplicada.

3. **Escala absoluta.** Escalar a prop pelo tamanho do chunk faz a mesma planta
   encolher conforme você se aproxima dela.

O espalhamento roda no worker e **reaproveita a grade já amostrada** em vez de
reavaliar o ruído: cada candidato custa uma leitura de array em vez de ~20
oitavas de fBm.

Duas decisões vieram depois, quando a floresta ficou boa demais para caber:

4. **Teto de instâncias por TIPO, não global** (`MAX_INSTANCES` em
   `PropScatter.js`). Um arbusto tem ~60 triângulos e uma árvore procedural tem
   ~800; o mesmo teto para os dois estoura o orçamento da GPU alvo.

5. **O repack percorre os chunks do mais PERTO para o mais longe.** Numa
   floresta a demanda passa de 4600 árvores e o teto corta de verdade — a ordem
   do laço é quem decide o que some. Na ordem natural do `Map` (chegada dos
   chunks) sumiam árvores a dez passos do jogador enquanto o horizonte
   continuava cheio. Ordenar 233 centros de chunk custa microssegundos e
   transforma o teto num raio de visão.

### 3.4.1 Árvores procedurais (EZ-Tree)

**O problema:** as árvores eram `.glb` pintados com uma cor só —
`palette.grass × 1,35`, a mesma do gramado. Tronco verde, copa verde, e o mesmo
verde em todos os mundos. Variação de brilho por instância não resolve, porque
o defeito não é o tom: é que uma árvore de verdade tem **casca e folha**, que
são coisas de cores diferentes, e uma malha só com um material só não tem onde
guardar essa diferença.

**A solução:** [EZ-Tree](https://www.eztree.dev/) (`@dgreenheck/ez-tree`,
MIT) gera copa e tronco como **duas malhas separadas**, com texturas de casca e
de folha próprias, a partir de um seed. Isso encaixa na premissa do projeto: a
árvore deixa de ser um arquivo e passa a ser uma função do seed, como o
terreno, a paleta e a atmosfera.

- `assets/TreeFactory.js` gera, corta o detalhe (`levels 2`, seções e segmentos
  reduzidos, billboard simples: ~800 triângulos por árvore contra ~2000 do
  preset original) e normaliza pela mesma convenção do `AssetLibrary` — base em
  y=0, altura 1, **a mesma transformação nas duas partes**, senão a copa
  desgruda do tronco.
- As normais das folhas são substituídas pela direção "centro da copa →
  vértice". As normais do billboard fazem a copa acender e apagar em blocos
  conforme o sol gira, como uma pilha de cartas.
- Geometria é cacheada por (perfil, seed) e **compartilhada entre planetas**; o
  que muda por mundo é o material.
- **Linha vazia no manifesto = árvore procedural.** O mundo exótico continua
  declarando cogumelos gigantes do Kenney: nenhuma árvore procedural entrega a
  mesma estranheza.

A cor deixou de morar no material. Os materiais nascem **brancos** e a cor vai
inteira para `instanceColor`, em HSL, com desvio por variante e por indivíduo
(`config.foliage`: matiz próprio, `spread`, saturação, luminosidade e um marrom
de casca sorteado à parte). Com a cor no material, a variação por instância
ficaria limitada a "mais claro ou mais escuro que este verde" — que era
exatamente o sintoma.

### 3.4.2 Vento

`shaders/WindShader.js` injeta um deslocamento senoidal via `onBeforeCompile`,
antes de `<project_vertex>`. Três detalhes:

1. **No espaço do objeto.** A geometria tem base em y=0 e cada instância é
   girada para ficar perpendicular à esfera, então ali "para cima" é sempre +Y
   e "quanto balança" é literalmente `transformed.y`: a copa oscila, a base
   fica presa. No espaço de mundo seria preciso reconstruir o "para cima" local
   por vértice.
2. **A fase vem de `instanceMatrix[3].xyz`.** Sem isso a floresta inteira
   balança em uníssono e lê como terremoto. Não custa nem um atributo a mais.
3. **`customProgramCacheKey`** é obrigatório: a chave de cache do Three não
   inclui o corpo do `onBeforeCompile`, e sem ela o vento some em parte dos
   materiais.

### 3.5 Caminhar numa esfera

O problema central é que "para cima" muda a cada passo. Um controlador FPS comum
guarda yaw e pitch em relação a eixos globais e quebra quando você caminha 90° ao
redor do mundo.

A solução: em vez de ângulos globais, guardamos um **vetor** `forward` e o
reprojetamos no plano tangente a cada frame. O yaw do mouse gira esse vetor em
torno do "para cima" local; o pitch só é aplicado ao montar a câmera, nunca
acumulado no estado. O referencial acompanha a curvatura sem caso especial nos
polos.

A velocidade é separada em tangencial (responde ao input) e radial (responde à
gravidade). Misturar as duas faz o jogador deslizar para cima em encostas.

### 3.6 Atmosfera

Single scattering Rayleigh + Mie com marcha de raio (12 passos de visão × 3 de
sol) sobre uma casca esférica. Três coisas que **não** são óbvias:

1. **A face da casca muda com a câmera.** Fora, `FrontSide`; dentro,
   `BackSide`. Usar `BackSide` sempre é o erro clássico: as faces traseiras
   ficam atrás do planeta, o depth test as descarta sobre todo o disco e sobra
   apenas um anel de neon contornando o planeta.

2. **`ShaderMaterial` não recebe tone mapping nem conversão sRGB
   automaticamente.** O Three.js injeta as *declarações* mas não a *aplicação*.
   Sem `#include <tonemapping_fragment>` e `<colorspace_fragment>` no fim do
   `main()`, a atmosfera despeja valores lineares crus no framebuffer e o céu
   perde o matiz.

3. **Composição por transmitância, não blending aditivo.** Aditivo só soma luz
   e nunca atenua o fundo; no pior caso (planeta de face cheia, sol atrás da
   câmera) o disco satura em branco. Com alfa pré-multiplicado
   (`alfa = 1 − transmitância`) o blending produz
   `inscatter + fundo × transmitância` e o brilho passa a ser limitado pela
   própria física.

Os coeficientes partem da razão real ~1/λ⁴ e são interpolados em direção ao
matiz do planeta **mantendo os três canais vivos** — com o vermelho zerado não
existe pôr do sol, só um céu de neon.

### 3.6.1 Nuvens volumétricas

Casca esférica própria entre `radius + clouds.bottom` e `+ clouds.top`, com ray
marching de um campo de densidade 3D no fragment shader
(`shaders/CloudShader.js`). Nada é armazenado: o fBm é aritmética pura, então
cada planeta tem o próprio céu por um seed — uma textura 3D de 128³ custaria
8 MB de VRAM e uma passagem de CPU no boot.

| | |
|---|---|
| Marcha de visão | 12–32 passos, escalados pela altitude relativa à espessura da camada |
| Marcha de sol | 3 passos, só em amostras com densidade > 0,001 |
| Iluminação | Beer-Lambert + termo *powder* + Henyey-Greenstein para frente |
| Composição | Front-to-back, alfa pré-multiplicado (mesma equação da atmosfera) |
| `renderOrder` | 5 — depois do terreno, **antes** da atmosfera |

Quatro armadilhas que custaram medição:

1. **O limiar não é `1 − cobertura`.** Parece a conta óbvia e produz céu limpo
   em quase toda a faixa útil: um fBm de três oitavas tem média ~0,45 e quase
   nunca passa de 0,7, então cobertura 0,34 vira limiar 0,66 e descarta tudo.
   Medido: 0,0 de diferença de pixel entre a cena com e sem nuvens. A cobertura
   é mapeada para a faixa onde o ruído realmente vive (`mix(0,62, 0,18, c)`) e
   o que sobra é renormalizado.
2. **A face da casca muda com a câmera**, pelo mesmo motivo da atmosfera.
3. **Dither do ponto inicial da marcha.** Sem ele as amostras se alinham em
   cascas concêntricas e aparecem anéis; com ele, granulado — que o olho
   perdoa.
4. **Teto de comprimento do trecho.** Rasante ao horizonte o caminho dentro da
   casca chega a dezenas de milhares de unidades, e distribuir os mesmos passos
   por ele transforma o ruído em listras. O corte deixa a névoa da cena assumir
   dali para frente.

A base da camada fica acima de `maxElevation × 1,25`: se ela cruzasse o relevo,
ver uma cordilheira furar uma nuvem por dentro entregaria o truque.

#### LOD das nuvens

Ray marching é custo de **fragmento**: escala com a área de tela que a casca
cobre, e ao nível do solo isso é o céu inteiro. O LOD tem três níveis, que se
multiplicam:

| eixo | onde | efeito |
|---|---|---|
| **Perfil global** | `cloudQuality`, em `world/Clouds.js` | passos, oitavas e passos de sol; responde ao FPS medido |
| **Distância do planeta** | `Clouds.update()` | menos passos em órbita; planeta que não é o ativo cai para 1 passo de sol |
| **Distância na marcha** | dentro do shader | amostra longe perde uma oitava, dispensa a erosão e anda com passo maior |

O número de **oitavas** é a alavanca forte, não o de passos: cada oitava são
oito `hash` por amostra e multiplica *todas* as amostras, inclusive as da
marcha do sol. Cair de 3 para 2 oitavas corta quase metade do trabalho e a
nuvem só perde o rendilhado da borda.

**Dither ordenado, não ruído branco.** O ponto de partida da marcha precisa
variar entre pixels vizinhos, senão as amostras se alinham em cascas
concêntricas e aparecem anéis. A primeira versão sorteava esse deslocamento com
um hash por pixel — e trocou os anéis por **granulado sal-e-pimenta**, visível a
olho nu na borda de cada nuvem. Uma matriz de Bayer 4×4 cobre os mesmos 16
valores numa ordem espalhada e repetida a cada 4 pixels: a amostragem continua
sem viés, e o olho lê a repetição como textura fina em vez de chiado.

**Beer-Lambert sozinho deixa o miolo preto.** A lei descreve a luz que atravessa
a nuvem sem ser espalhada, e num cúmulo denso isso é ~zero. Mas essa luz não
sumiu: ela ricocheteou entre gotículas e sai difusa — por isso a barriga de uma
nuvem real é cinza, não preta. A aproximação padrão (Guerrilla, "Nubis") soma um
segundo termo com absorção bem menor: `max(exp(-τ), exp(-0,25τ) · 0,7)`.

Duas coisas que o LOD exigiu e não são óbvias:

- **Renormalizar o fBm por número de oitavas.** A soma máxima cai de 0,875 para
  0,75 e 0,5; sem corrigir, o limiar de cobertura passa a cortar tudo e a nuvem
  **desaparece** ao baixar a qualidade em vez de ficar mais lisa.
- **Acumular opacidade com o passo REAL da amostra** (`lodStep`), não com o
  passo base, senão a nuvem fica mais rala longe do que perto só por LOD.

O **salto de espaço vazio** é o que paga a conta: numa cobertura típica a
maioria das amostras cai em céu limpo e paga o fBm inteiro para descobrir isso.
Amostra vazia avança 2,5×, o que é seguro porque o campo é suave na escala de
`featureScale`, muito maior que o passo.

O controlador de qualidade é automático porque o mesmo build roda numa Iris Xe
e numa RTX: escolher um número fixo é escolher qual das duas será mal servida.
Descer é rápido (abaixo de 40 fps, imediato), subir é lento (4 s de folga
sustentada acima de 57 fps) — sem essa assimetria a coisa oscila. Cada troca de
nível sai no console. Para fixar o nível e desligar o automático:

```
?clouds=off | minimo | baixo | medio | alto
```

**Ainda não há sombra de nuvem no chão** — exigiria amostrar o mesmo campo de
densidade na iluminação do terreno.

### 3.6.3 Perspectiva aérea com pass de profundidade

A casca de atmosfera resolve o **céu** — o trecho do raio sem geometria. O que
estava entre a câmera e uma montanha continuava sendo aproximado por `FogExp2`:
uma névoa de cor média, que não sabe que o ar rareia com a altitude nem
avermelha no poente.

`shaders/AerialPerspective.js` fecha o buraco. A cena vai para um render target
(`HalfFloat`, MSAA 4x, com `DepthTexture`), e um pass de tela cheia reconstrói a
posição de mundo de cada pixel **com geometria** e integra o mesmo espalhamento
da casca no trecho câmera → superfície:

```
cor_final = cor_do_terreno × transmitância + inscatter
```

**Só age dentro da atmosfera**, e não por performance: de dentro, a casca é
`BackSide` e o depth test a descarta sobre o terreno, então não há espalhamento
ali e o pass é quem fornece. De fora ela vira `FrontSide` e já cobre o disco —
aplicar o pass somaria a mesma luz duas vezes.

**A armadilha: depth logarítmico.** O projeto usa `logarithmicDepthBuffer`,
então o valor gravado é `log2(1+w) · FC · 0,5`, e a reconstrução padrão devolve
lixo. Invertendo, `w = exp2(2d/FC) − 1`, e a posição sai sem a inversa da
projeção. Verificado contra distâncias conhecidas:

| altitude real | reconstruída | erro |
|---|---|---|
| 44,5 u | 43,9 u | dentro da quantização da leitura |
| 599,5 u | 597,6 u | 0,31% |
| 2 999,5 u | 3 011,8 u | 0,41% |
| 11 999,5 u | 12 047,1 u | 0,40% |

A física também confere — a 60 u do solo, olhando o horizonte:

| distância | transmitância R/G/B | inscatter |
|---|---|---|
| 60–150 u | 0,98 / 0,96 / 0,89 | 0,004 / 0,010 / 0,031 |
| 150–400 u | 0,96 / 0,92 / 0,80 | 0,007 / 0,018 / 0,050 |
| 400–1 500 u | 0,91 / 0,85 / **0,63** | 0,015 / 0,036 / **0,094** |

O azul é o que mais se extingue e o inscatter é azul e cresce com a distância.

**E era invisível.** O inscatter repunha quase exatamente o que a extinção
tirava: 3 níveis de diferença em 255. Correto e inútil — o motivo é a escala,
2,5 km de raio contra 6 371 km da Terra. `uBoost` (4,5) multiplica a
profundidade óptica do trecho; extinção e inscatter crescem juntos, então a
relação entre eles continua a da física e só muda a distância em que o efeito
aparece. Medido a 400–1 500 u, a diferença sobe de 4/3/1 para 18/11/8 níveis.

> **Efeito colateral honesto: a cor de toda a cena mudou.** O tone mapping saiu
> de dentro dos materiais e virou a última etapa do pass — o certo, porque
> somar espalhamento a cores já comprimidas é somar luz a um branco saturado.
> Só que o termo de *offset* do Khronos Neutral subtrai o canal mínimo, e antes
> ele incidia camada por camada; agora incide uma vez sobre a soma. Média da
> tela em órbita: azul cai de 25,6 para 15,0; na superfície, de 111 para 93.
> Conferi a fórmula por dois caminhos (referência em JS e conta à mão) e ela
> está fiel ao Khronos — **a diferença é estrutural, não um erro de
> implementação**, e a calibração de `uSunIntensity` documentada acima foi
> feita no pipeline antigo. Subir a intensidade da casca de 4 para 8 recupera
> só ~40% da diferença, então não é um número só que conserta.
>
> `?aerial=off` volta ao caminho antigo (cena direto no canvas, tone mapping
> por material) para comparar lado a lado.

### 3.6.2 A luz do sol acompanha o céu

A direcional era branca de meio-dia enquanto o céu ardia em vermelho — a maior
causa isolada de "cena que não fecha". `GameState` agora tinge e atenua a luz
do sol pelo caminho óptico (`grazing × atmosfera`): rasante ao horizonte a luz
chega mais laranja e mais fraca, que é o mesmo fenômeno que a atmosfera já
calculava para o céu.

### 3.6.4 Oceano, e nadar dentro dele

O mar era uma esfera com material padrão translúcido. Da órbita passava; ao
nível dos olhos era uma chapa de plástico azul, sem movimento e com a mesma cor
sobre um banco de areia e sobre uma fossa. Água que não muda de cor com a
profundidade não lê como água — lê como um plano pintado atravessando a
paisagem.

O shader de hoje (`src/shaders/OceanShader.js`) tem quatro peças:

- **Profundidade por vértice, amostrada do próprio relevo no nascimento do
  planeta.** O caminho usual seria ler o depth buffer da cena; aqui isso seria
  caro e frágil (o terreno vai para um alvo separado quando a perspectiva aérea
  está ligada). Em compensação este projeto tem uma vantagem que jogo com
  terreno autorado não tem: **a profundidade é uma função**, conhecida na CPU
  antes do primeiro quadro. Uma passada de 72 mil amostras dá gradiente de
  praia, espuma e cor por profundidade sem nenhum passe extra.
- **Ondas na NORMAL, não na posição.** Deslocar vértices numa esfera planetária
  daria cristas de dezenas de unidades, visíveis da órbita como uma bola
  amassada. O que se vê do convés é o brilho quebrando, e isso é normal.
- **Espuma em duas fontes**: a arrebentação (onde o fundo sobe) e as cristas em
  mar aberto — sem a segunda, o mar longe da costa fica liso demais e denuncia
  que a "onda" é só iluminação.
- **Fresnel comedido.** De cima a água deixa ver o fundo; de raspão vira espelho
  do céu.

**Nadar** entrou junto: empuxo um pouco acima do peso (com empuxo exato o corpo
fica em equilíbrio neutro e PARA onde estiver, o que na prática é voar dentro da
água), arrasto horizontal e vertical, `Espaço` para subir e `Ctrl`/`C` para
mergulhar. A transição andar → nadar é contínua pela fração do corpo submersa:
tratá-la como interruptor produz o personagem alternando entre correr e boiar a
cada onda. Debaixo d'água a névoa fica azul e densa, e a casca do oceano passa a
ser desenhada dos dois lados — com face única, mergulhar fazia a água sumir e o
nadador via o céu por dentro do mar.

Dois erros meus que valem registro, porque explicam por que isto demorou:

- **O shader não compilava.** Dois uniforms declarados no JavaScript e
  esquecidos no GLSL derrubavam o programa inteiro em silêncio — e o que se via
  como "água feia" era o **fundo do mar sem oceano nenhum por cima**. Todo
  ajuste de cor feito antes disso era invisível por construção.
- **A esfera era grossa demais para o planeta novo.** Com 160×112 num raio de
  4 600, cada quadrilátero tem ~180 unidades e a profundidade por vértice não
  sabe onde a praia começa: quadrantes inteiros de mar raso eram classificados
  como terra e recortados, e o oceano aparecia em xadrez. A resolução subiu, e o
  recorte por vértice saiu de cena — **quem esconde a água sob o continente é o
  z-buffer**, que já tem o terreno opaco desenhado antes e resolve isso com
  precisão de pixel.

### 3.6.5 Clima

Chuva, tempestade, neve, ventania de areia e neblina, em `src/world/Weather.js`.

**O tempo é deduzido, não sorteado.** Não há estado de clima guardado nem
simulação de frentes frias: umidade e temperatura do terreno dizem o que PODE
cair ali (chuva num bosque, neve num planalto gelado, areia num deserto) e um
campo lento no tempo diz se está caindo agora. É a mesma escolha que rege o
resto do projeto — o mundo é uma função, não um banco de dados — e dá de graça
duas coisas difíceis de outro jeito: dois jogadores na mesma sala veem a mesma
chuva **sem trocar um byte**, e sair voando e voltar meia hora depois encontra o
tempo que a hora pede, não o que ficou salvo numa variável.

As partículas vivem num grupo ancorado na câmera, em coordenadas locais a ele.
Isso resolve sem código extra o problema que mais atrapalharia aqui: a origem
flutuante (§3.0.1) desloca a cena inteira quando o jogador anda, e partículas em
coordenadas de mundo saltariam a cada recentragem. O mesmo sistema vira gota
esticada, floco redondo ou grão horizontal por um uniform de alongamento, e a
queda é **radial ao planeta** — a cem quilômetros dali a vertical é outra.

Metade do efeito não são as gotas: é a **névoa**. Ar carregado encurta o alcance
da vista, e a paisagem sumindo atrás da chuva convence muito mais do que a
cortina em si.

### 3.7 A transição seamless

`GameState.js` não move nada: lê a altitude e interpola todo o ambiente.

| | espaço | superfície |
|---|---|---|
| Densidade da névoa | 0 | `atmo³ × 5,5e-4` |
| Luz ambiente | 0,04 | até 0,94 |
| Opacidade das estrelas | 1,0 | 0,02 |
| Exposição do tonemapper | 0,95 | 1,25 |
| Responsividade do voo | 0,9 | 2,6 |
| Velocidade máxima | 900 (3200 no booster) | 260 |

A mesma variável `atmosphere` alimenta os cinco — é o que faz a entrada na
atmosfera ser **sentida no controle**, não só vista.

### 3.8 Pulse drive

Os planetas estão a dezenas de milhares de unidades. A 3200 u/s do booster o
vizinho levaria minutos de linha reta — tempo morto, não exploração.

Duas regras o transformam em mecânica em vez de teleporte:

- **Corte automático** perto de qualquer corpo, em múltiplos da atmosfera local
  (um valor absoluto seria alto demais numa lua e baixo demais num gigante).
- **Trava anti-tunelamento**: a 26 000 u/s a nave avança ~430 unidades por
  frame, mais que a espessura inteira da zona de corte — ela atravessaria o
  planeta entre dois frames sem nunca "ver" a superfície. Limitando a velocidade
  a um múltiplo da altitude, a aproximação vira desaceleração suave.

A trava acima limita a velocidade **alvo**, e sozinha não bastava. A velocidade
real converge para o alvo com constante de tempo ~0,3 s: a 20 000 u/s isso são
~5 800 unidades de frenagem, mais que o raio de um planeta. E `dt` é limitado a
0,1 s — um engasgo de GC a 26 000 u/s é um salto de **2 600 unidades num frame
só**, contra os 2 036 de diâmetro da lua. Como a colisão testa um PONTO e não o
trajeto, o planeta não estava lá em nenhum dos dois frames.

A segunda trava, em `_integrate()`, limita o **passo do frame a metade da
altitude atual** (com piso de duas folgas de pouso, senão a nave nunca
encostaria no chão). É uma série geométrica: chega sempre perto, nunca
atravessa. Medido com mergulho vertical a 26 000 u/s direto no centro:

| | antes | depois |
|---|---|---|
| dt = 0,016 | penetra o solo | pousa a 2,2 u de folga |
| dt = 0,1 (engasgo) | 575 u **dentro** da lua antes de a colisão notar | pousa a 2,2 u de folga |

### 3.9 Áudio sintetizado

Nenhum arquivo de som no projeto. O jogo inteiro se sustenta na ideia de que
nada é armazenado — um motor em `.mp3` seria o único lugar onde um universo
procedural soa idêntico em todos os planetas, e ainda pesaria no bundle.

Osciladores e ruído filtrado dão de graça o que uma amostra não dá: o motor não
toca um loop, ele **muda de timbre**; o vento não é um sample em fade, é ruído
cuja banda abre conforme a atmosfera engrossa.

| camada | síntese | responde a |
|---|---|---|
| Motor | 2 dentes-de-serra desafinados + sub senoidal num passa-baixa | acelerador **e** velocidade real |
| Sopro do booster | ruído em passa-banda | só o fim do curso do acelerador |
| Vento | ruído em passa-banda, frequência pela velocidade | atmosfera × velocidade — **zero absoluto no vácuo** |
| Pulse | triangular + ruído, ambos subindo | rampa de engate |
| Feixe | serra grave com LFO quadrado no ganho | mineração ativa |
| Pontuais | envelopes ataque/decaimento | varredura, coleta, descoberta, pouso, passos, reentrada |

> **A armadilha que custou caro.** Um `AudioParam` vale
> `valor intrínseco + soma dos sinais conectados`. O trêmulo do feixe ligava o
> LFO direto em `beamGain.gain`; com o alvo em 0 (sem minerar), o ganho não
> ficava em zero — ficava oscilando entre −0,5 e +0,5. A serra grave tocava a
> meio volume, picotada a 22 Hz, **o tempo inteiro, em todo lugar do jogo**.
> Medido: 0,0657 de RMS parado a pé, contra 0,099 voando a plena potência — o
> parasita sozinho valia dois terços da nave acelerando. A correção é separar
> os papéis: um nó de trêmulo que oscila em torno de 0,5 (nunca negativo) e,
> depois dele, a torneira que de fato fecha em zero. Hoje, parado a pé, o RMS
> é exatamente 0.

Quatro decisões que evitam os erros clássicos de Web Audio:

1. **O `AudioContext` nasce no clique de "iniciar"**, nunca no import. Criado no
   boot ele nasce `suspended` e o jogo fica mudo *sem nenhum erro no console*.
2. **Osciladores são criados uma vez e nunca param.** Ligar e desligar o
   oscilador do motor conforme o acelerador dá um clique a cada mudança
   (descontinuidade na onda) e aloca por frame. Cada camada tem um `GainNode`
   de torneira e todo parâmetro anda por `setTargetAtTime`.
3. **Compressor no barramento principal.** Motor + vento + pulse somados
   estouram fácil, e clipping digital é o som mais feio que existe.
4. **Estouros de ruído começam num ponto aleatório do buffer.** Sem isso todo
   passo ataca a mesma sequência de amostras e o ouvido percebe a repetição.

Os passos são disparados por **distância percorrida**, não por temporizador:
correr aumenta a cadência sozinho e parar no meio de um passo não dispara nada.
O peso do pouso vem da velocidade de chegada — baque fixo faz encostar de leve
soar igual a espatifar.

Níveis medidos (RMS na saída do barramento principal):

| situação | RMS |
|---|---|
| a pé, parado | 0,000 |
| espaço, motor em marcha lenta | 0,007 |
| minerando | 0,016 |
| voando a plena potência na atmosfera | 0,099 |

`M` liga e desliga, e a preferência sobrevive ao F5. No console,
`__nms.audio.setVolume(0..1)` ajusta em tempo real e `__nms.audio.level()`
devolve o RMS — é o jeito de responder "isso está tocando alguma coisa?" sem
depender do ouvido.

### 3.10 Tela inicial e nome do piloto

A abertura pede um nome antes de liberar o voo. Três detalhes que fazem
diferença no uso:

- **O campo já vem preenchido** com o último nome usado (ou um sugerido). Quem
  só quer jogar aperta Enter; quem se importa apaga e escreve o seu. Campo vazio
  transforma "começar" numa tarefa.
- **É um `<form>` de verdade**, então Enter envia. Sem isso, digitar o nome e
  apertar Enter não faz nada — e o botão está logo ali.
- **A crítica só aparece depois de tentar**, e some assim que a pessoa começa a
  corrigir. Marcar erro enquanto ela digita o terceiro caractere é hostil.

O nome fica no `localStorage`, vai para a sala de multijogador e assina o chat e
as descobertas. A senha ao lado é **opcional** e é o que separa nome de conta
(§3.12): sem ela o jogo roda igual e só não salva.

### 3.11 Multijogador

```bash
npm run mp     # sala em ws://localhost:5200
npm run dev    # abrir o jogo normalmente: ele entra na sala sozinho
```

O cliente **liga por padrão** e fica tentando reconectar, então subir o servidor
depois do jogo funciona sem recarregar. Sem servidor no ar, o painel diz OFFLINE
e o jogo segue igual. `?mp=off` joga sozinho; `?mp=ws://host:5200` aponta para
outra máquina.

**O que trafega é só o que não deriva do seed.** O universo inteiro é função de
um inteiro: terreno, biomas, posição de cada arbusto e espécie de cada bicho os
dois clientes calculam iguais. Sobram duas coisas:

1. **Onde cada jogador está** — posição, orientação, modo (nave/a pé) e a nave
   dele, que fica parada onde foi deixada.
2. **O que já foi colhido** — a única mutação persistente do mundo.

Por isso o servidor guarda só uma tabela de jogadores e um conjunto de props
colhidos. Nenhum vértice de terreno passa pela rede.

#### Canais: um sistema, um mundo

A sala **não é um universo só**. Cada sistema estelar é um canal com o próprio
estado compartilhado — colhidos, bases, escavações e presentes —, e posição,
colheita, construção e terraformação circulam apenas entre quem está no mesmo
seed. **Saltar é trocar de canal.**

Isto substituiu o desenho anterior, em que o servidor fixava um seed e obrigava
todo mundo a ele: quem entrava com outro tinha a página recarregada até
coincidir. Era simples e fazia do hiperimpulsor uma mentira — dois jogadores
saltavam para sistemas diferentes e continuavam se vendo, cada um voando dentro
do planeta que o outro não tinha.

Três coisas que caem no lugar com essa mudança:

- **O banco já estava pronto.** `colhido`, `construcao` e `terreno` sempre
  tiveram `seed` na chave primária — o esquema modelava sistemas separados desde
  o início, e era só o servidor que lia um deles e ignorava o resto. Não houve
  migração; o que mudou foi QUANDO cada conjunto é lido: um canal é carregado na
  primeira vez que alguém entra nele, e não no boot. Um servidor com cem
  sistemas visitados não tem por que ler os cem para servir quem está em um.
- **Difundir exige nomear o alcance.** A função antiga que mandava para a sala
  inteira deixou de existir; sobraram `transmitirNoCanal` e
  `transmitirParaTodos`, e o nome comprido da segunda é de propósito — usar o
  alcance errado passa a ser uma escolha visível no código. Só duas coisas
  atravessam canais: o catálogo de descobertas (é da galáxia) e o chat global.
- **O realinhamento de seed sobreviveu, mas só para quem não escolheu.** Abrir o
  jogo sem `?seed=` continua colocando você junto de quem já está na sala — é o
  que faz "entrar com um amigo" funcionar sem combinar número nenhum. Chegar com
  `?seed=` agora é respeitado: seeds diferentes deixaram de ser um conflito a
  resolver e passaram a ser dois lugares diferentes da galáxia.

A troca de canal é avisada **no auge do clarão do salto**, depois de o cliente
reconstruir o universo local e antes de o primeiro pacote de posição sair: um
`state` com o universo novo e o canal antigo poria o avatar dentro do planeta de
quem ficou para trás. Os avatares remotos são apagados no envio, não na
resposta — entre uma coisa e outra passam alguns quadros.

Verificado com três clientes: dois no mesmo sistema se veem e não recebem nada
do terceiro; chat local fica no canal e o global alcança os três; colheita e
construção não atravessam; ao saltar, quem chega recebe o mundo do destino
(bases, colheitas, escavações e presentes) e quem fica vê a saída.

#### Chat

Dois alcances — **sistema** e **global** —, e a diferença é a razão de o chat
existir num jogo de galáxia: o local é conversa com quem está no mesmo lugar, e
o global é o único caminho por onde duas pessoas separadas por mil anos-luz
combinam de se encontrar.

`Enter` abre a linha, `Tab` troca o alcance, `Esc` cancela. Três detalhes que
não são cosméticos:

- **O `keydown` da caixa para a propagação.** Sem isso, digitar "wasd" faz o
  personagem andar e "1" troca de ferramenta.
- **O eco é do servidor, não local.** Ele carimba autor e hora, e é o mesmo
  pacote que chega para os outros; imprimir localmente antes faria a própria
  mensagem aparecer duas vezes — ou, pior, aparecer mesmo quando o servidor a
  recusou.
- **O nome vem do servidor, nunca do pacote.** Deixá-lo vir do cliente seria
  deixar qualquer um assinar como qualquer um.

Uma mensagem a cada 700 ms por conexão, 200 caracteres, histórico de 12 linhas
que esmaece depois de 14 segundos.
- **Posições viajam em espaço LOCAL DO PLANETA**, nunca em espaço de mundo. Com
  origem flutuante (§3.0.1) o mundo se desloca sob os pés de cada jogador em
  momentos diferentes: a mesma coordenada de cena significa lugares diferentes
  em duas máquinas. O centro do planeta é o único referencial comum.
- **Envio a 12 Hz, desenho a 60.** A suavidade vem da interpolação local (o
  avatar persegue exponencialmente o último estado), não da taxa de pacotes.
- **A colheita remota entra pelo MESMO caminho da local** (`PropScatter.collect`),
  então ela some da malha instanciada no próximo repack e continua sumida se o
  chunk descarregar e voltar. Se o chunk ainda não chegou do worker, o índice
  vai para o histórico e é aplicado quando chegar.

Verificado com dois clientes reais: a posição do jogador B chegou em A com os
mesmos `[838, 2515, 559]` em espaço do planeta, e um prop colhido em B ficou
registrado como colhido em A.

#### Encontrar os outros

Um painel **SALA** (sob o de navegação) lista quem está online: você em
destaque, os demais ordenados por proximidade. E cada jogador ganha um
**marcador projetado na tela**, com nome e distância.

O que a distância mostra depende de onde a pessoa está:

| situação | painel |
|---|---|
| mesmo corpo celeste | `33 m`, `4.7 km` |
| outro corpo | o NOME do corpo, em âmbar |

Mostrar "38 km" para alguém que está numa lua diferente é tecnicamente correto
e inútil: ninguém vai caminhar até lá. O nome do corpo responde a pergunta que
importa — dá para chegar a pé, ou precisa da nave?

Cinco defeitos que só apareceram abrindo dois navegadores de verdade:

- **O multijogador era opt-in por `?mp=1`.** Abrir o jogo normalmente não entrava
  em sala nenhuma, dois navegadores lado a lado não se viam, e o painel nem
  aparecia — porque ele só era mostrado quando havia conexão. Um recurso que
  precisa de um parâmetro secreto para existir é um recurso que ninguém usa.
- **Quem entrava primeiro e ficava parado era invisível para o segundo.** O
  `welcome` filtrava jogadores sem posição conhecida (`&& j.estado`), e o
  `entrou` do primeiro tinha sido transmitido antes de o segundo existir.
  Resultado: cada um via uma sala vazia. O filtro caiu; o cliente lida com
  `estado: null` sozinho.
- **O seed só era alinhado no `join`.** Como cada aba sorteia um seed, a pessoa
  escolhia o nome, clicava em INICIAR VOO e a página recarregava de volta para o
  menu. O servidor passou a mandar `hello` com o seed assim que a conexão abre,
  e o realinhamento acontece durante a geração do terreno. (Hoje esse
  realinhamento só vale para quem não escolheu sistema — ver *Canais*.)
- **O painel escondia a diferença entre "sala vazia" e "sem sala".** Agora ele é
  sempre visível, e o contador mostra `OFFLINE` ou `…` quando não há conexão —
  com a linha `npm run mp` dizendo como resolver.
- **Quem acabou de conectar não contava no total.** Aparece como
  `localizando…` até o primeiro pacote de posição, em vez de sumir da lista.

E três que já estavam previstos:

- **Marcador atrás da câmera vai para a BORDA, não some.** A versão anterior
  descartava pontos com `z > 1`, e o companheiro desaparecia da interface
  exatamente quando você virava de costas — que é quando você mais precisa
  saber para onde voltar. Negar as coordenadas desfaz a inversão da projeção;
  o marcador encosta na borda do lado certo, a 45% de opacidade.
- **O avatar remoto fica invisível até o primeiro pacote de estado.** Sem essa
  guarda ele nasce em (0,0,0) do planeta 0 — o CENTRO do primeiro corpo — e o
  HUD anuncia um companheiro a 34 km enterrado num planeta.
- **O nome do outro jogador é escapado antes de ir para `innerHTML`.** Ele vem
  pela rede e é escolhido por um desconhecido: sem isso, alguém entra na sala
  com um `<img onerror=…>` no nome e executa script na sua máquina.

**O que este servidor não é**: autoritativo sobre movimento. Ele confia na
posição que o cliente manda — suficiente para cooperação, convite a trapaça num
jogo competitivo.

### 3.12 Persistência em MySQL

```bash
mysql -u root < server/schema.sql    # cria banco, tabelas e o usuário da aplicação
npm run mp                            # a sala conecta sozinha
```

**Seis tabelas bastam** — e o motivo é a premissa do projeto. O universo inteiro
é função do seed: terreno, biomas, posição de cada arbusto e espécie de cada
bicho se recalculam iguais em qualquer máquina. Nada disso vai para o banco.
Sobra só o que o jogador MUDA:

| tabela | o quê | escopo |
|---|---|---|
| `conta` | login e hash da senha | — |
| `progresso` | unidades, inventário e descobertas | conta **×** sistema |
| `colhido` | props extraídos — mutação permanente do mundo | sistema |
| `construcao` | uma peça de base por linha, com o slot na chave | sistema |
| `terreno` | escavações, com orçamento e descarte do mais antigo | sistema |
| `descoberta` | quem chegou primeiro em cada sistema | **galáxia** |

A coluna `seed` nas três tabelas de mundo é o que permitiu, depois, dividir a
sala em canais por sistema (§3.11) sem migração nenhuma: o esquema já modelava
sistemas separados, e era só o servidor que lia um deles e ignorava o resto.

`progresso` é por conta **e** por sistema porque o mesmo jogador em outro sistema
estelar é outro progresso — sem isso, saltar traria um inventário coletado num
mundo que não existe mais. Ao entrar, o servidor devolve a linha **mais
recente** da conta, de qualquer sistema: o estado guardado carrega o campo
`sistema`, então o cliente sabe para onde voltar, e pedir a linha do sistema de
entrada devolveria o estado de um lugar onde a pessoa talvez não esteja há
semanas.

`descoberta` é a exceção: o endereço identifica um lugar da galáxia, que é o
mesmo em qualquer partida, então ela não tem `seed` (§3.12.1).

Decisões que merecem nota:

- **`scrypt` do próprio Node**, sem dependência externa para algo tão sensível.
  É lento e usa memória de propósito — um ataque de força bruta paga o mesmo
  custo por tentativa. A comparação usa `timingSafeEqual`, porque `===` vaza
  pelo TEMPO quantos caracteres iniciais estavam certos.
- **A conta é opcional.** Sem senha, o jogo roda exatamente como antes e só não
  salva. Exigir cadastro para ver um planeta girar é cobrar pedágio antes de
  mostrar o que se está vendendo.
- **Registro implícito**: login inexistente vira conta nova. Numa PoC, uma tela
  a mais para escolher entre "entrar" e "criar" é atrito puro.
- **JSON para inventário e catálogo**, não tabelas normalizadas: os dois são
  lidos e escritos SEMPRE inteiros, nunca consultados por item. Normalizar só
  criaria junções para reconstruir o objeto que o cliente já manda pronto.
  (`Map` e `Set` não sobrevivem a `JSON.stringify` — viram `{}` em silêncio —,
  daí o `toJSON()`/`restaurar()` em `Inventory` e `Discovery`.)
- **Sem banco, tudo continua funcionando.** `db.js` degrada em silêncio: a sala
  volta a ser memória volátil e o login responde "servidor sem banco de dados".
- **Salva a cada 20 s e no `beforeunload`.** Perder 20 segundos de coleta é
  irrelevante; gravar por frame faria o banco ser o gargalo de um jogo a 60 Hz.

Verificado de ponta a ponta: com a conta criada, 4 321 unidades, 77 de ferrite,
uma descoberta e três props colhidos, **o servidor foi reiniciado** — ele
anunciou `5 props colhidos restaurados` e o cliente voltou com as unidades, o
inventário, o catálogo e os arbustos ainda colhidos. Senha errada responde
`senha incorreta`; senha curta é recusada antes de tocar no banco.

> **Ajuste do ambiente**: a tabela `mysql.db` do MariaDB do XAMPP estava com o
> índice corrompido, e por isso nenhum `GRANT` gravava. `REPAIR TABLE mysql.db`
> resolveu. Se os privilégios do usuário `odyssey` não colarem, é o primeiro
> lugar a olhar.

### 3.12.1 Descoberta de sistemas

Todo sistema tem **nome único** e **dono**: quem chega primeiro fica registrado,
e a ficha do mapa mostra por quem.

O nome precisou ser refeito para isso valer. As três tabelas de sílabas geram
22 × 10 × 12 = 2 640 combinações para cerca de 178 mil sistemas — não é risco de
colisão, é a garantia de que dezenas dividem o mesmo nome. Enquanto ninguém
comparava dois deles isso passava despercebido; a partir do momento em que um
sistema tem dono, dois "Kelaenova" diferentes tornam a informação inútil.

A saída foi acrescentar uma **designação**: o endereço do sistema (galáxia,
voxel e índice) empacotado em 31 bits e escrito em base 36 — `Toriavex 0MB-EIO`.
Não é um hash: é uma **bijeção**. Endereços distintos têm designações distintas,
então a unicidade é aritmética e continua valendo sem registro central nenhum.

A tabela `descoberta` é a única que **não** é por universo: o endereço identifica
um lugar da galáxia, que é a mesma em qualquer partida, então a descoberta
acompanha o lugar e não o seed da sala. A chave primária no endereço implementa
a regra inteira — `INSERT IGNORE` faz o próprio banco recusar o segundo a
chegar, sem trava nem comparação de horário no servidor.

Duas decisões do lado do cliente:

- **Quem decide é o servidor.** O cliente reivindica todo sistema em que entra,
  inclusive um que já visitou e um que outra pessoa descobriu ontem; ele não
  teria como decidir sozinho de qualquer forma, porque só conhece o catálogo do
  momento em que entrou. A marca no mapa só aparece quando a confirmação volta.
- **A tentativa vive no laço, não na chegada.** A tentação é reivindicar logo
  depois de situar o mapa, e não funciona: no boot o jogo entra no sistema ANTES
  de a sala responder, e a reivindicação sairia sem o catálogo em mãos — o
  cliente marcaria como inédito um sistema descoberto no mês passado. Esperar a
  conexão numa chamada única traria o problema oposto: quem joga sem servidor
  nunca registraria nada. Uma tentativa por quadro, guardada por um endereço já
  resolvido, cobre os dois casos sem nenhuma coordenação.

No campo de estrelas há dois degraus de brilho, porque são duas perguntas
diferentes: forte onde **você** esteve, médio onde **alguém** registrou.

### 3.13 Construção de bases

`B` a pé abre o modo construção. Botão esquerdo constrói, direito demole e
devolve tudo, `R` gira, roda do mouse ou `1`–`9` troca a peça.

**O problema:** peças modulares pressupõem uma grade cartesiana infinita. Um
planeta não tem isso — cobrir uma esfera com quadrados iguais falha nos polos ou
abre fendas no equador, que é o mesmo motivo pelo qual todo mapa-múndi mente.

**A saída é não tentar.** Uma base não é recorte de uma grade global; é uma
*placa tangente* com grade própria. A primeira peça fixa uma origem no terreno e
um referencial ortonormal (Y radial, Z na direção do olhar arredondada para o
múltiplo de 90° mais próximo dos eixos do planeta), e todas as peças seguintes
moram na rede de INTEIROS desse referencial. O encaixe passa a ser exato,
sincronizar uma peça vira três inteiros, e a curvatura só apareceria numa base de
centenas de metros.

O truque que apaga a conversão do resto do código: `grupo.scale = 3`. Como o kit
do Kenney já é 1×1, a rede de inteiros do grupo **é** a grade da base.

Três decisões que o primeiro teste corrigiu:

- **A placa se apoia no ponto mais alto da vizinhança, não no ponto clicado.** A
  primeira versão ancorava onde o jogador mirou, e o resultado foi um cômodo
  inteiro com areia por dentro: o terreno ondula mais que a espessura da laje.
  Numa encosta a base agora fica sobre palafitas visíveis, que é honesto — dá
  para ver o chão descendo por baixo dela.
- **Mobília é uma camada separada do piso.** Tratá-las como o mesmo encaixe
  fazia colocar uma mesa EXIGIR arrancar o piso debaixo dela. A mobília também
  sobe a espessura da laje sozinha, medida do próprio modelo.
- **Cada aresta tem um dono só.** A aresta +Z de uma célula é fisicamente a mesma
  que a −Z da célula seguinte; guardá-las como slots diferentes permitiria duas
  paredes no mesmo plano — invisível ao construir e impossível de demolir depois,
  porque só uma responde ao clique.

**Render:** um `InstancedMesh` por tipo de peça e por base, refeito quando a base
muda. Clonar um `Object3D` por peça custaria um draw call por parede — 150 numa
base modesta, mais do que o jogo inteiro gasta com terreno. Assim o custo é o
número de tipos distintos, no máximo 14.

**Colisão:** roda depois do `PlayerController`, sobre a posição já resolvida
contra o terreno, e no espaço da base — onde tudo é alinhado aos eixos e a
separação cilindro-contra-caixa cabe em vinte linhas. Em espaço de mundo cada
parede seria uma caixa orientada e exigiria SAT. Portas têm `solido: false`: um
vão que bloqueia é uma parede pintada.

Verificado de ponta a ponta: um cômodo de 4×4 com 37 peças foi construído,
enviado à sala e gravado; **o servidor foi reiniciado** (`37 peças de base
restauradas em 1 bases`) e um cliente NOVO, sem estado local, recebeu a base
inteira e a desenhou na mesma posição de mundo. O jogador solto acima do piso
pousa em `y = 0.300` — exatamente o topo da laje —, para a 0,15 da face interna
da parede (o próprio raio do corpo) e atravessa a porta sem obstáculo. Demolir
devolveu 15 de ferrite e apagou a linha do banco.

### 3.13.1 Voltar onde parou

O ponto em que a pessoa saiu entra no mesmo registro de progresso (§3.12) e é
restaurado ao entrar com a conta.

**Coordenadas relativas ao planeta, nunca de mundo** — pelo mesmo motivo que a
rede usa espaço local (§3.11): a origem flutuante desloca a cena inteira conforme
o jogador anda, então a mesma coordenada de cena significa lugares diferentes em
duas sessões. O centro do planeta é o único referencial que sobrevive a um
recarregamento, e ele próprio deriva do seed.

**A nave vai junto, sempre.** Guardar só o jogador funciona enquanto ele estiver
pilotando. Quem sai do jogo a pé, a duzentos metros da nave, voltaria com ela no
ponto inicial do sistema — ou seja, a pé, sem transporte, num planeta qualquer.
A nave estacionada é parte de onde você parou. O olhar também entra, para não
devolver a pessoa girada para um lado aleatório.

Duas sutilezas que o código registra:

- `?spawn=` manda mais que o save. Quem abre com `?spawn=orbita` quer ver a
  órbita, não voltar para onde parou — e sem essa precedência o cenário de teste
  sobrescreveria a posição alguns frames depois, com um salto visível.
- No banco, `posicao = COALESCE(VALUES(posicao), posicao)`. Um cliente que grave
  sem posição não pode apagar o ponto da sessão anterior.

Se o ponto salvo estiver em outro corpo, a malha de lá ainda não existe quando o
jogo começa — e isso é seguro: colisão e altitude usam o amostrador analítico,
que responde certo mesmo onde nenhum chunk chegou. O terreno aparece em volta nos
segundos seguintes.

Verificado de ponta a ponta: jogador a pé em **Fenivex VI** (corpo 2, não o
inicial), **servidor reiniciado**, e ao entrar de novo o desvio foi de `0.00`
tanto para o jogador quanto para a nave, com altitude 0 — de pé no chão, sem
queda.

### 3.14 Terreno deformável

O terraformador (`3`) cava com o botão esquerdo e eleva com o direito.

**O conflito:** o planeta inteiro é função pura do seed — é isso que permite dois
jogadores verem a mesma montanha sem trocar um byte de terreno. Cavar quebra essa
pureza por definição.

A saída é não misturar. O ruído continua intocado e as escavações vivem numa
camada à parte que se soma por cima:

```
altura final = ruído(direção) + edições(direção)
```

Só a lista de edições trafega e vai para o banco — a mesma ideia que faz os props
colhidos caberem em quatro colunas. E a camada é compartilhada entre a main
thread (colisão, altitude) e o worker (malha), porque se as duas discordarem o
jogador cai dentro do chão que está vendo.

**Custo por área, não por tempo.** O caminho ingênuo emite uma deformação por
frame: dois segundos cavando viram 120 registros permanentes que todo vértice
daquele chunk vai percorrer para sempre. Aqui a escavação em curso é UMA edição
que ganha profundidade, e só quando a mira se afasta o bastante uma nova começa.

Isso exigiu uma correção depois de medir: enquanto o buraco fundo, a superfície
desce, o raio encontra o chão mais adiante e o ponto mirado escorrega sozinho —
sem o jogador mexer o mouse. Com limiar baixo, um buraco custava sete registros.
Agora o limiar é um raio inteiro, com carência de 0,35 s.

**Orçamento com descarte.** Deformação é o único dado do jogo que cresce sem
limite natural: props acabam, peças param, mas cavar é uma ação que se repete
para sempre. Há um teto de 400 escavações por planeta, e ao estourá-lo as mais
antigas são abandonadas — aquele pedaço volta à forma procedural. É perda de dado
deliberada, e é a escolha certa: o alternativo é o mundo ficar lento para todos
por causa de uma vala que alguém cavou e esqueceu.

> **Limitação da representação**: o terreno é um *heightmap* sobre a esfera, e a
> deformação é um deslocamento radial. Dá para abrir crateras e platôs, não para
> cavar túneis ou saliências — isso exigiria campo de densidade 3D e marching
> cubes, ou seja, reescrever o worker inteiro.

#### Dois defeitos que só apareceram medindo

**O platô apagava as escavações.** `NIVELAR` com peso 1 *atribui* a altura, e
portanto apaga o que foi somado antes dela. Em ordem de inserção, cavar dentro do
platô de uma base funcionava até a base crescer — aí o platô era reemitido,
passava a vir depois na lista, e o buraco sumia sem que nada tivesse acontecido
com ele. Uma escavação de 8,6 unidades media zero. A correção é ordenar: nivelar
sempre antes de somar. Primeiro se terraplena, depois se cava.

**A restauração chegava no meio da geração.** O `join` que provoca o `welcome` só
é enviado quando já existem chunks suficientes para liberar o jogo — então há
dezenas de chunks em voo, pedidos a workers que ainda não conheciam as
escavações, e eles chegam depois da invalidação já aceitos e com o relevo antigo.
O sintoma era exato e confuso: a cratera existia para a colisão e para a altitude
(que consultam o amostrador da main thread) e não existia na malha. Dava para
cair num buraco invisível. Uma segunda varredura depois que a fila esvazia
resolve sem precisar de confirmação por chunk.

**Reconstruir agrupado, não por frame.** Segurando o botão, a mesma escavação é
reaplicada a cada frame — 60 por segundo. Invalidar em cada uma descarta ~25
chunks e os repede, e o pool processa ~12 por vez: a fila crescia mais rápido do
que drenava e *nenhum* chunk chegava a ser entregue antes de ser descartado de
novo. Na tela, o terreno piscava, aparecia em retalhos ou simplesmente não
mudava enquanto se cavava — e como a colisão lê o amostrador da main thread, dava
para afundar num chão que continuava desenhado. Agora há dois relógios: um curto
(0,18 s) que reinicia a cada mudança e um teto (0,75 s) que dispara mesmo com a
escavação em andamento. Uma cavada de dois segundos custa duas ou três
reconstruções em vez de cento e vinte. Medido: fila de 274 pedidos antes,
**0 durante a escavação**.

**Terra remexida não é paredão de rocha.** O declive governa duas escolhas de cor
— rocha exposta em encosta íngreme e ausência de neve em parede vertical — e as
duas estão certas para relevo natural e erradas para uma vala. O declive de um
buraco recém-cavado satura o medidor, e o interior saía pintado de leito
rochoso: de `228,239,255` (areia quase branca) para `7,5,4` (quase preto) em dois
metros, com borda dura. Era o "glitch de textura".

A correção amolece o declive **só para efeito de cor**, na proporção de quanto
aquele ponto foi mexido; geometria, colisão e bioma continuam com o declive real.
A máscara usa a curva de platô e não o peso da própria edição — no domo do
`SOMAR` o peso é mínimo na borda, que é justamente onde a parede fica mais
íngreme, e a primeira tentativa acertou o fundo da cratera deixando um anel preto
no meio dela. Com folga de 30% além do raio, some também o contorno escuro.

Verificado — perfil atravessando uma cratera, a cada 2 unidades:

| | −12 m | −8 m | −4 m | 0 | 4 m | 8 m | 12 m |
|---|---|---|---|---|---|---|---|
| elevação | 23,2 | 22,6 | 17,9 | **12,5** | 16,8 | 20,0 | 19,3 |
| cor (R) | 228 | 220 | 222 | 231 | 228 | 227 | 232 |

A elevação desenha a cratera; a cor atravessa sem salto. E uma cratera restaurada
do banco num cliente novo mede
`23,4 · 23,4 · 19,5 · 14,9 · 19,5 · 23,4 · 22,9` — simétrica, com o fundo 8,5
abaixo do terreno original.

### 3.15 Equipamento e primeira pessoa

Varrer, minerar, construir e cavar competem pela mesma mira e pelo mesmo botão.
A alternativa a modos seria espalhá-los por teclas diferentes — que era o estado
anterior, e nada na tela dizia o que o clique fazia. Com equipamento, a pergunta
tem uma resposta só, visível em dois lugares: o item aceso na barra e o objeto na
mão. Por isso a barra e o modelo em primeira pessoa foram feitos juntos.

A cena da ferramenta é **separada**, com câmera própria de plano próximo curto,
desenhada por último e com o depth buffer limpo. Numa câmera de escala planetária
(o `tuneCameraPlanes` empurra o *near* para dezenas de unidades em órbita), um
objeto a 40 cm é cortado antes de existir — e mesmo com *near* pequeno, o terreno
logo à frente venceria o teste de profundidade.

As mãos são geometria, não modelo: o pacote não tem um par de mãos em primeira
pessoa, e recortá-las de um boneco exigiria rig. Em primeira pessoa o que
comunica "isto é seu" não é a anatomia do dedo, são dois volumes segurando a
ferramenta e acompanhando o movimento.

> **Nota de método**: a orientação da arma errou duas vezes por dedução em vez de
> observação — primeiro um quarto de volta (supondo que o pacote exporta ao longo
> de X), depois meia volta, deduzida de uma captura em que confundi as mãos com o
> cano, e a arma passou a apontar para o próprio jogador. A caixa envolvente é
> simétrica em Z e **não diz** para que lado o cano aponta. Só olhar a tela diz.

### 3.16 Alcance das ferramentas

O feixe de mineração alcançava 32 unidades — 26 nominais mais até 6 de tolerância
de mira, que virava alcance extra de graça. Dava para extrair praticamente
qualquer coisa no campo de visão, inclusive do outro lado de uma ravina.

Agora são 14 (uns sete corpos à frente), a tolerância cresce com a distância para
manter o ÂNGULO constante em vez do raio, e há um limite rígido: um alvo
encontrado perto do último ponto amostrado mas lateralmente afastado é
descartado. Construção alcança 18 e o terraformador 20 — maior que o feixe porque
uma ferramenta que remodela o chão precisa alcançar além do raio da própria
deformação, senão cavar sempre abriria um buraco sob os próprios pés.

### 3.17 Publicar

```bash
npm run deploy    # build + odyssey-deploy.zip
```

O zip tem os arquivos na RAIZ (não dentro de `dist/`), que é o que o extrator do
gerenciador de arquivos espera. Sobe, extrai em `public_html/`, apaga o zip.
`base: './'` no `vite.config.js` faz o mesmo build funcionar na raiz do domínio
ou em subpasta, e o `.htaccess` vai junto com MIME dos workers, gzip e cache.

#### O jogo sozinho roda em qualquer hospedagem

É tudo estático: HTML, JS e `.glb`. Hospedagem compartilhada comum (Hostinger,
cPanel) serve isso sem nenhuma configuração. Sem servidor de sala declarado, o
cliente nem é criado — o jogo roda em modo solo e o painel não aparece.

#### O multijogador NÃO roda em hospedagem compartilhada

Ele precisa de um processo Node vivo e de uma porta aceitando WebSocket. Plano
compartilhado não dá nenhum dos dois: não há Node, não há processo persistente e
não há porta arbitrária. Só PHP por requisição.

Dois caminhos:

**1. VPS** (o mesmo provedor costuma vender). Node + PM2, com o Nginx
terminando o TLS e repassando:

```bash
npm ci --omit=dev
pm2 start server/mp-server.js --name odyssey-mp -- --seed=12345
pm2 save && pm2 startup
```

```nginx
location /mp {
    proxy_pass http://127.0.0.1:5200;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;      # sem estes dois cabeçalhos
    proxy_set_header Connection "upgrade";       # o WebSocket não sobe
    proxy_read_timeout 3600s;                    # senão a sala cai a cada 60 s
}
```

**2. Serviço de Node** (Render, Railway, Fly). O repositório já tem
`npm start` e `engines.node`, e o servidor respeita `process.env.PORT` — que é
justamente o que essas plataformas exigem. O jogo continua na hospedagem barata
e só a sala vive lá.

Nos dois casos, o endereço vai na meta tag do `index.html` **publicado** — dá
para editar direto no gerenciador de arquivos, sem recompilar:

```html
<meta name="nms-mp-server" content="wss://seudominio.com/mp" />
```

> **`wss://`, nunca `ws://`.** O `.htaccess` força HTTPS, e uma página segura não
> abre WebSocket inseguro: o navegador bloqueia como conteúdo misto. O jogo
> agora detecta essa combinação e explica no console, porque o sintoma sozinho
> (sala eternamente OFFLINE) não aponta para a causa.

### 3.16.1 Pós-processamento

`src/shaders/PostProcess.js` fecha o pipeline: bloom, exposição, tone mapping,
saturação, contraste, vinheta e grão.

Ele só existe porque o passe de perspectiva aérea (§3.6.3) já tinha feito o
trabalho difícil — renderizar a cena num alvo **linear** com o tone mapping
desligado. Bloom precisa exatamente disso: somar um halo a um pixel já
comprimido para [0,1] não tem para onde crescer, e o brilho vira uma mancha
acinzentada. O tone mapping **saiu** da perspectiva aérea e passou a ser a
última coisa que acontece:

```
cena -> alvo HDR linear
     -> perspectiva aérea (soma espalhamento, sem comprimir)
     -> extração de brilho + borrão em cascata (4 níveis, meia resolução)
     -> composição: soma o bloom, expõe, comprime, tinge, vinheta, grão
     -> tela
```

Decisões que valem nota:

- **Cascata, não um borrão só.** Um Gaussiano largo o bastante para o halo de um
  sol custa dezenas de amostras por pixel; borrar em resoluções decrescentes e
  somar de volta dá o mesmo alcance com um punhado, porque cada nível cobre o
  dobro da distância — o pixel dele é o dobro do tamanho. O borrão separável usa
  cinco leituras para cobrir nove texels, deixando a interpolação bilinear da
  GPU fazer metade do trabalho.
- **Joelho na extração de brilho.** Um corte duro no limiar faz um pixel que
  oscila em torno dele entrar e sair do bloom a cada quadro, e a imagem pisca em
  movimento.
- **Contraste com pivô em 0.42 e levante de sombra.** Com pivô no meio, uma
  floresta densa perdia a folhagem escura inteira para o preto: mais dramático
  numa captura parada, ilegível em movimento.
- **Grão mascarado por luminância.** Ele existe para quebrar o *banding* de
  degradês grandes (céu, névoa, água profunda) que 8 bits por canal não
  resolvem. Sem a máscara, o preto do espaço no mapa galáctico ficava
  chuviscando — ruído onde não há sinal nenhum para proteger.
- **O mapa galáctico passa pelo mesmo caminho**, e é onde o efeito mais aparece:
  24 mil estrelas em blending aditivo são a fonte pontual que o bloom existe
  para espalhar.

Custo medido: **1,4 ms por quadro** a 1280×720 (5,7 ms contra 4,3 ms).
`?post=off` desliga tudo e volta ao caminho anterior, com o tone mapping de novo
dentro do passe atmosférico — é assim que se compara lado a lado.

### 3.17.1 Ver o que o jogo está desenhando

Um endpoint `/__captura` no `vite.config.js` (só em `serve`) recebe um quadro do
canvas e grava em `capturas/`; `src/dev/Capturas.js` posiciona a nave em pontos
escolhidos do planeta, deixa a cena assentar e dispara a foto:

```js
const c = await import('/src/dev/Capturas.js');
await c.ensaio();   // chão, panorâmica e beira-mar, do lado iluminado
```

Existe por uma limitação concreta: **o canvas WebGL não pode ser lido de fora do
navegador**. Sem isso, avaliar uma mudança de shader vira descrever a tela em
palavras — e foi exatamente assim que um defeito passou despercebido por várias
iterações: dois uniforms declarados no JavaScript e esquecidos no GLSL faziam o
shader do oceano falhar em silêncio, então todo ajuste de cor da água era
invisível por construção. A primeira captura respondeu em dez segundos o que
três rodadas de ajuste não tinham respondido.

Duas armadilhas do próprio harness, aprendidas do jeito difícil:

- **A hora do dia precisa ser fixa.** `elapsed` governa o ciclo dia/noite, então
  passar o relógio real fazia o sol andar entre a escolha do ponto e o disparo:
  o lugar era escolhido no lado iluminado e fotografado à meia-noite.
- **A posição precisa ser reafirmada a cada quadro.** A física continua rodando,
  e a nave despenca durante os segundos que a cena leva para carregar os chunks.

`capturas/` está no `.gitignore`: é saída de ferramenta, não fonte.

---

## 4. Controles

| Nave | |
|---|---|
| `Mouse` | Arfagem / guinada (manche virtual auto-centrante) |
| `A` `D` | Rolagem |
| `W` `S` | Acelerar / desacelerar |
| `Shift` | Booster |
| `X` | Pulse drive |
| `Espaço` | Freio de inércia |
| `G` | Piloto automático: mergulho no planeta |
| `C` | Câmera 3ª pessoa / cockpit |

| A pé | |
|---|---|
| `F` | Sair da nave / embarcar |
| `W A S D` | Caminhar |
| `Shift` | Correr |
| `Espaço` | Pular / jetpack — **na água**, subir |
| `Ctrl` / `C` | Mergulhar (só nadando) |
| `V` | Pulso de varredura |
| `1` `2` `3` / `Roda` | Trocar de equipamento |
| `Tab` | Inventário e catálogo de construção |
| `B` | Atalho para o construtor |

| Mapa galáctico | |
|---|---|
| `N` | Abrir / fechar (o jogo PARA enquanto ele está aberto) |
| `W A S D` | Voar pela galáxia |
| `R` / `Q` | Subir / descer |
| `Botão esq.` | Girar a câmera |
| `Botão dir.` | Arrastar o mapa |
| `Roda` | Aproximar |
| `Duplo clique` / `Enter` | Saltar para o sistema |
| `C` / `F` | Centrar em você / no destino |
| `[` `]` | Trocar de galáxia |

| Chat | |
|---|---|
| `Enter` | Abrir a linha de digitação |
| `Tab` | Alternar entre SISTEMA e GLOBAL |
| `Esc` | Cancelar |

| Equipamento | Botão esquerdo | Botão direito |
|---|---|---|
| Multiferramenta | Extrair | — |
| Construtor | Construir | Demolir (devolve tudo) |
| Terraformador | Cavar | Elevar |

Com o construtor na mão, `Q` e `E` trocam de peça e `R` gira um quarto de volta.

**Uma tecla, um comando.** Três sobreposições foram removidas depois de
apontadas: os dígitos casavam `[1-9]` e o índice entrava num módulo, então `4`
equipava silenciosamente a primeira ferramenta; `Shift+R` girava ao contrário,
mas `Shift` é correr, então girar para trás fazia o jogador disparar junto; e a
roda do mouse trocava de peça ou de ferramenta conforme o que estivesse na mão —
um controle com dois significados obriga a pessoa a lembrar em que estado está
antes de usá-lo.

### Parâmetros de URL

| | |
|---|---|
| `?seed=12345` | reproduz o mesmo sistema estelar — e, na sala, entra no **canal** dele em vez de adotar o sistema de entrada do servidor |
| `?mp=1` | entra na sala local (`ws://localhost:5200`); aceita outra URL |
| `?spawn=superficie\|alto\|orbita` + `&planet=N` | nasce direto na situação, pulando a abertura |
| `?clouds=off\|minimo\|baixo\|medio\|alto` | fixa a qualidade das nuvens |
| `?aerial=off` | volta ao pipeline de cor antigo (§3.6.3) |
| `?post=off` | desliga o pós-processamento (§3.16.1), para comparar lado a lado |
| `?dev=1` | instala a bancada de inspeção em `window.__dev` (só em `npm run dev`) |

`M` liga/desliga o som (fica salvo). `F3` alterna wireframe (mostra a quadtree
subdividindo ao vivo). `Esc` libera o
cursor. No console: `__nms.activePlanet`, `__nms.inventory`, `__nms.disembark()`.

---

## 5. Próximos passos

- **Carga sob demanda por CORPO.** Metade disto já aconteceu: o servidor virou
  canais por sistema e carrega o mundo de cada um na primeira visita (§3.11), em
  vez de ler o universo inteiro no boot. Falta o degrau seguinte — o cliente
  pedir o conteúdo de um PLANETA ao chegar perto dele, em vez de receber o
  sistema todo no `welcome`.
- **Áudio posicional**: o som já existe (§3.9), mas é todo mono e centrado no
  jogador. Fauna e depósitos pedem `PannerNode` com a posição da câmera para
  virarem pistas de navegação em vez de decoração.
- **Escala de qualidade automática**: detectar FPS baixo e reduzir `lod.maxLevel`
  e a densidade de props.
- **Props por bioma, não por classe de planeta**: hoje `assets/manifest.js`
  escolhe os modelos pela classe do mundo porque o bioma é calculado dentro do
  worker e não chega ao `PropScatter`. Levá-lo junto exigiria mudar o protocolo
  e o stride do worker.
- **Estações espaciais e comércio**: o inventário já tem `sell()` e valores de
  mercado; falta o destino onde vender.
- **Nuvens sem banding**: a casca é amostrada em passos grandes e a borda mostra
  dithering em algumas altitudes (ver §6). Passos adaptativos por distância
  resolveriam sem custar em toda a tela.
- **LUTs de espalhamento pré-computadas** (modelo de Bruneton): o pass de
  profundidade já existe (§3.6.3), mas ainda integra por marcha a cada frame.
- **WebGPU**: exige importar de `three/webgpu` e reescrever os shaders em
  **TSL** — GLSL não é portado automaticamente. O ganho real são os compute
  shaders: a geração de terreno migraria dos workers para a GPU.

---

## 6. Limitações conhecidas

- **Colisão por uma única amostra** sob o centro da nave/jogador. Um jogo real
  amostraria vários pontos e reagiria à normal do terreno.
- **A base não colide com a nave**, só com o jogador a pé: dá para pousar dentro
  do próprio cômodo.
- **A escavação é radial**, não volumétrica: crateras e platôs sim, túneis e
  saliências não (§3.14).
- **Não há cavernas, e não é questão de esforço.** O terreno é um campo de
  altura — uma elevação por direção —, e caverna exige duas superfícies no mesmo
  raio (chão e teto). As saídas reais são terreno volumétrico com marching
  cubes, que reescreve worker, LOD e colisão, ou entradas que levam a uma cena
  de interior separada. Os cânions são o que cabe no modelo atual: um lugar onde
  se desce, se percorre e do qual se sai por outro ponto.
- **Prop colhido reaparece ao trocar de nível de LOD.** A identidade do prop é
  *(chunk, índice)*, e o índice é outro em cada nível. Antes isso se escondia no
  ruído — todo o espalhamento mudava junto —; depois que ele foi estabilizado
  (§3.4), o defeito ficou limpo e visível. A correção troca a identidade pela
  CÉLULA do espalhamento e mexe no protocolo e no significado das colunas de
  `colhido`.
- **Nuvens com aspecto quadriculado** em algumas altitudes: a casca é amostrada
  em passos grandes e a borda mostra dithering.
- **O terreno deformado é compartilhado e permanente**, diferente do jogo do
  gênero — que guarda a deformação só no save local de quem cavou. Foi uma
  escolha deliberada de projeto (uma sala cooperativa em que o buraco do outro
  existe para você), e o preço é o orçamento de 400 escavações por planeta.
- **Fauna sem colisão e sem ciclo de vida**: as criaturas atravessam props e
  umas às outras, não comem de verdade e não podem ser caçadas. O pool é de 12
  e elas só existem abaixo de 260 unidades de altitude.
- **Variedade de props por classe de planeta, não por bioma** (ver §5).
- **Costuras entre faces do cubo**: normais contínuas dentro de cada face; nas
  12 arestas há descontinuidade mínima, visível só em luz rasante.
- **Brilho da atmosfera e exposição do terreno são escalas independentes.**
  `uSunIntensity` foi calibrado por medição (ver comentários em
  `AtmosphereShader.js`), mas não deriva da `DirectionalLight` da cena.
- **Sem sombras projetadas nem oclusão ambiente.** Shadow maps em escala
  planetária pedem cascatas. As nuvens também não projetam sombra no chão —
  exigiria amostrar o campo de densidade dentro da iluminação do terreno.
- **Árvores sem LOD.** Uma árvore a 400 unidades desenha os mesmos ~800
  triângulos que a do lado do jogador. O teto de instâncias ordenado por
  distância é o paliativo; a solução é um impostor (billboard) para o anel
  distante.
- **O EZ-Tree embute as texturas como data URI**, o que sozinho responde por
  4 MB do bundle. Servir os `.jpg`/`.png` como arquivos exigiria importar do
  `src/` do pacote, que o `exports` do `package.json` não expõe.
- **Mineração sem raycast real**: a mira usa proximidade ao longo do olhar
  (aim assist), não interseção exata com a instância.
- **WebGL1 não testado.** O código assume WebGL2.
