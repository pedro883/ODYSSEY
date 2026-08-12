# Projeto Odyssey — PoC de universo procedural seamless

Prova de conceito de um jogo web 3D no estilo *No Man's Sky*: um sistema
estelar gerado proceduralmente, voo livre entre planetas, **transição contínua**
do espaço até o pouso e exploração a pé — sem tela de carregamento em nenhum
momento.

Three.js `0.185` + Vite `8` + Web Workers. Sem dependências além dessas duas.

```bash
npm install
npm run dev
```

`http://localhost:5173/?seed=12345` reproduz sempre o mesmo sistema estelar.
Sem o parâmetro, o seed é aleatório.

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
| **Vegetação** | Arbustos, árvores, rochas e depósitos por `InstancedMesh`, distribuídos por bioma |
| **Multiferramenta** | Pulso de varredura e feixe de mineração |
| **Descobertas** | Catálogo de planetas e espécies com nomes procedurais e recompensa em unidades |
| **Inventário** | Slots com empilhamento, 4 recursos, recurso "assinatura" por planeta |
| **HUD** | Telemetria, navegação, carga, marcadores projetados na tela, prompts contextuais |

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
│   └── StarField.js           Campo de estrelas e estrela do sistema
│
├── shared/                    ── IMPORTADO PELA MAIN THREAD **E** PELO WORKER ──
│   ├── noise.js               Simplex 3D seedável, fBm, ridged multifractal
│   ├── terrain.js             Cube-sphere, campo de altura, biomas e cores
│   └── props.js               Pesos de espalhamento por bioma, recursos
│
├── workers/
│   ├── terrain.worker.js      Geometria + espalhamento de props, multi-planeta
│   └── WorkerPool.js          Pool compartilhado com balanceamento por carga
│
├── shaders/AtmosphereShader.js  Single scattering Rayleigh + Mie
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
└── ui/HUD.js                  Overlay HTML/CSS + marcadores projetados
```

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
| `Espaço` | Pular / jetpack |
| `V` | Pulso de varredura |
| `Mouse esq.` | Feixe de mineração |

`F3` alterna wireframe (mostra a quadtree subdividindo ao vivo). `Esc` libera o
cursor. No console: `__nms.activePlanet`, `__nms.inventory`, `__nms.disembark()`.

---

## 5. Próximos passos

- **Fauna procedural**: criaturas com IA simples e catalogação, reaproveitando o
  espalhamento por bioma que já existe.
- **Construção de bases**: o `PropScatter` já resolve instâncias em massa; falta
  persistência e um sistema de snap.
- **Estações espaciais e comércio**: o inventário já tem `sell()` e valores de
  mercado; falta o destino onde vender.
- **Clima**: tempestades de areia e chuva, modulando `GameState` — a
  infraestrutura de interpolação por altitude já serve.
- **Floating origin**: manter o jogador na origem e transladar o mundo. O
  `logarithmicDepthBuffer` resolve a faixa atual (0,1 → 90 000), mas distâncias
  interestelares exigem isso.
- **Atmosfera definitiva**: pass de tela cheia lendo o depth buffer, depois LUTs
  pré-computadas (modelo de Bruneton).
- **WebGPU**: exige importar de `three/webgpu` e reescrever os shaders em
  **TSL** — GLSL não é portado automaticamente. O ganho real são os compute
  shaders: a geração de terreno migraria dos workers para a GPU.

---

## 6. Limitações conhecidas

- **Colisão por uma única amostra** sob o centro da nave/jogador. Um jogo real
  amostraria vários pontos e reagiria à normal do terreno.
- **Sem fauna** — só flora e minerais.
- **Costuras entre faces do cubo**: normais contínuas dentro de cada face; nas
  12 arestas há descontinuidade mínima, visível só em luz rasante.
- **Brilho da atmosfera e exposição do terreno são escalas independentes.**
  `uSunIntensity` foi calibrado por medição (ver comentários em
  `AtmosphereShader.js`), mas não deriva da `DirectionalLight` da cena.
- **Sem sombras projetadas nem oclusão ambiente.** Shadow maps em escala
  planetária pedem cascatas.
- **Mineração sem raycast real**: a mira usa proximidade ao longo do olhar
  (aim assist), não interseção exata com a instância.
- **WebGL1 não testado.** O código assume WebGL2.
