/**
 * Nuvens volumétricas por ray marching numa casca esférica.
 *
 * COMO FUNCIONA
 * Igual à atmosfera, desenhamos uma esfera maior que o planeta e fazemos todo
 * o trabalho no fragment shader. A diferença é que aqui não integramos um gás
 * homogêneo, e sim um campo de densidade 3D (fBm de ruído de valor): para cada
 * pixel, cortamos o trecho do raio que está DENTRO da casca [inner, outer],
 * caminhamos por ele somando densidade e, em cada amostra com nuvem, damos
 * alguns passos em direção ao sol para saber quanta luz sobrou de chegar ali.
 *
 * POR QUE PROCEDURAL E NÃO TEXTURA 3D
 * Uma textura 3D de 128³ custa 8 MB de VRAM por canal e precisaria ser gerada
 * na CPU no boot — para um jogo cujo argumento inteiro é "nada é armazenado".
 * O fBm no shader é mais caro por amostra, mas some do orçamento de memória e,
 * principalmente, é *seedável*: cada planeta tem o próprio céu sem custo algum.
 *
 * COMPOSIÇÃO
 * Front-to-back com alfa pré-multiplicado, exatamente pela mesma razão da
 * atmosfera (ver AtmosphereShader.js): `src.rgb + dst.rgb * (1 - src.a)` é
 * literalmente a equação de transporte de radiância, então a nuvem escurece o
 * que está atrás dela em vez de só somar brilho. Nuvem aditiva vira neblina
 * luminosa que nunca tapa o sol.
 *
 * ILUMINAÇÃO
 *   - Beer-Lambert: `exp(-densidade_até_o_sol)` dá a base escura da nuvem.
 *   - Termo "powder" (`1 - exp(-2τ)`): escurece as BORDAS voltadas para o sol.
 *     Sem ele a nuvem parece algodão chapado; é o detalhe que dá volume real e
 *     custa uma exponencial.
 *   - Henyey-Greenstein para frente: o halo prateado quando se olha na direção
 *     do sol através de nuvem fina.
 *
 * OCLUSÃO PELO TERRENO
 * Resolvida pelo depth buffer, como na atmosfera: a casca está acima do
 * relevo, então uma montanha à frente ganha o teste de profundidade. Nuvem
 * ENTRE a câmera e a montanha (voando dentro da camada) não é ocluída
 * corretamente — seria preciso ler o depth num pass de tela cheia. Na prática
 * não incomoda porque dentro da camada a visibilidade já é quase nula.
 */

import * as THREE from 'three';

const vertexShader = /* glsl */ `
  varying vec3 vWorldPosition;

  #include <common>
  #include <logdepthbuf_pars_vertex>

  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
    #include <logdepthbuf_vertex>
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;

  varying vec3 vWorldPosition;

  uniform vec3  uPlanetCenter;
  uniform float uInnerRadius;
  uniform float uOuterRadius;
  uniform vec3  uSunDirection;
  uniform vec3  uSunColor;
  uniform vec3  uSkyColor;      // luz ambiente que vem do céu (base da nuvem)
  uniform vec3  uCloudColor;    // albedo; quase branco, tingido pelo planeta
  uniform float uCoverage;      // 0 = céu limpo, 1 = encoberto
  uniform float uDensity;
  uniform float uFeatureScale;  // tamanho característico das massas, em unidades
  uniform float uTime;
  uniform vec3  uWind;
  uniform float uOpacity;       // fade global (usado ao sair da atmosfera)
  // --- LOD (ver world/Clouds.js) ---
  uniform int   uSteps;         // passos de marcha
  uniform int   uOctaves;       // oitavas de fBm nas amostras próximas
  uniform int   uLightSteps;    // passos da marcha em direção ao sol

  #include <common>
  #include <logdepthbuf_pars_fragment>

  const int MAX_STEPS = 48;
  const int LIGHT_STEPS = 3;

  vec2 raySphere(vec3 origin, vec3 dir, float radius) {
    float b = dot(origin, dir);
    float c = dot(origin, origin) - radius * radius;
    float disc = b * b - c;
    if (disc < 0.0) return vec2(1.0, -1.0);
    float s = sqrt(disc);
    return vec2(-b - s, -b + s);
  }

  /* Hash 3D -> [0,1). Sem textura de ruído: o campo inteiro é aritmética. */
  float hash(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  /* Ruído de valor com interpolação suave (quintic: derivada contínua). */
  float valueNoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);

    return mix(
      mix(mix(hash(i + vec3(0,0,0)), hash(i + vec3(1,0,0)), u.x),
          mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), u.x), u.y),
      mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), u.x),
          mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), u.x), u.y),
      u.z);
  }

  /**
   * fBm com número de oitavas VARIÁVEL — o coração do LOD.
   *
   * Cada oitava é uma avaliação de valueNoise, e cada valueNoise são oito
   * hash. Numa marcha de 32 passos com 3 passos de luz, cortar UMA oitava
   * economiza ~1000 operações de hash por pixel. É de longe a alavanca mais
   * forte do shader — mais que o número de passos, porque o custo por passo
   * cai junto.
   *
   * A quarta oitava nunca existiu: ela some sob o próprio passo da marcha.
   */
  float fbm(vec3 p, int octaves) {
    float sum = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 3; i++) {
      if (i >= octaves) break;
      sum += amp * valueNoise(p);
      p = p * 2.13 + vec3(11.3, 7.7, 3.1);
      amp *= 0.5;
    }
    // Renormaliza: com menos oitavas a soma máxima cai (0.875 -> 0.75 -> 0.5)
    // e, sem corrigir, o limiar de cobertura passaria a cortar tudo — a nuvem
    // literalmente SUMIRIA ao baixar a qualidade, em vez de ficar mais lisa.
    float norm = octaves >= 3 ? 0.875 : (octaves == 2 ? 0.75 : 0.5);
    return sum * (0.875 / norm);
  }

  /**
   * Densidade da nuvem num ponto (espaço local do planeta).
   *
   * O perfil vertical é o que separa "nuvem" de "névoa uniforme": densidade
   * zero nas duas bordas da casca e máxima um pouco abaixo do meio, que é onde
   * fica a barriga de um cúmulo real.
   *
   * @param octaves detalhe desta amostra (ver fbm)
   * @param erode   aplicar a oitava de erosão? Ela custa um fBm INTEIRO a mais
   *                e só se vê de perto — é a primeira coisa a cair no LOD.
   */
  float cloudDensity(vec3 p, int octaves, bool erode) {
    float thickness = uOuterRadius - uInnerRadius;
    float h = (length(p) - uInnerRadius) / thickness;
    if (h < 0.0 || h > 1.0) return 0.0;

    float profile = smoothstep(0.0, 0.22, h) * smoothstep(1.0, 0.55, h);

    vec3 q = p / uFeatureScale + uWind * uTime;
    float shape = fbm(q, octaves);
    // Erosão: uma segunda oitava rápida come as bordas e cria os frisos.
    if (erode) shape -= 0.18 * fbm(q * 4.7, 2);

    // ---------------------------------------------------------------------
    // O LIMIAR NÃO É "1 - cobertura".
    //
    // Parece a conta óbvia e produz céu limpo em quase toda a faixa útil: um
    // fBm de três oitavas com amplitudes 0.5/0.25/0.125 tem média ~0.45 e
    // quase nunca passa de 0.7, então um limiar de 0.66 (cobertura 0.34)
    // descarta praticamente tudo. Mapeamos a cobertura para a faixa em que o
    // ruído REALMENTE vive, e renormalizamos o que sobra para que a densidade
    // máxima não dependa do limiar escolhido.
    // ---------------------------------------------------------------------
    float threshold = mix(0.62, 0.18, uCoverage);
    float d = (shape - threshold) / max(1.0 - threshold, 0.1);
    return max(d, 0.0) * profile * uDensity;
  }

  void main() {
    #include <logdepthbuf_fragment>

    vec3 ro = cameraPosition - uPlanetCenter;
    vec3 rd = normalize(vWorldPosition - cameraPosition);
    float r = length(ro);

    vec2 outer = raySphere(ro, rd, uOuterRadius);
    vec2 inner = raySphere(ro, rd, uInnerRadius);

    float t0, t1;
    if (r > uOuterRadius) {
      // Vista do espaço: entra na casca e para na superfície de baixo (ou sai
      // pelo outro lado da casca, se o raio passar de raspão).
      if (outer.x > outer.y || outer.y < 0.0) discard;
      t0 = max(outer.x, 0.0);
      t1 = (inner.x <= inner.y && inner.x > 0.0) ? inner.x : outer.y;
    } else if (r > uInnerRadius) {
      // Voando DENTRO da camada.
      t0 = 0.0;
      t1 = (inner.x <= inner.y && inner.x > 0.0) ? inner.x : outer.y;
    } else {
      // No chão, olhando para cima: começa onde o raio fura a base da camada.
      if (inner.y < 0.0) discard;
      t0 = inner.y;
      t1 = outer.y;
    }
    if (t1 <= t0) discard;

    // Teto de comprimento: rasante ao horizonte o trecho dentro da casca chega
    // a dezenas de milhares de unidades, e distribuir os mesmos passos por ele
    // faz o ruído virar listras (aliasing de passo). Cortar e deixar a névoa
    // da cena assumir dali para frente é mais barato e mais bonito.
    float maxSpan = (uOuterRadius - uInnerRadius) * 26.0;
    t1 = min(t1, t0 + maxSpan);

    int steps = uSteps;
    float stepLen = (t1 - t0) / float(steps);

    // -------------------------------------------------------------------
    // DITHER ORDENADO (Bayer 4x4), NÃO RUÍDO BRANCO.
    //
    // O ponto de partida da marcha precisa variar entre pixels vizinhos: sem
    // isso as amostras se alinham em cascas concêntricas e aparecem anéis.
    //
    // A primeira versão usava um hash por pixel — ruído branco. Ele resolve os
    // anéis e cria um problema pior: cada pixel sorteia um deslocamento sem
    // relação com o vizinho, e a borda da nuvem vira sal-e-pimenta. É o
    // granulado que se via a olho nu.
    //
    // A matriz de Bayer cobre os 16 valores de [0,1) numa ordem espalhada e
    // REPETIDA a cada 4 pixels. O olho lê a repetição como textura fina e não
    // como chiado, e o resultado ainda é uma amostragem sem viés. Custa três
    // operações inteiras e nenhuma textura.
    // -------------------------------------------------------------------
    ivec2 pixel = ivec2(mod(gl_FragCoord.xy, 4.0));
    int bayerIndex = pixel.y * 4 + pixel.x;
    float bayer[16];
    bayer[0]=0.0;   bayer[1]=8.0;  bayer[2]=2.0;  bayer[3]=10.0;
    bayer[4]=12.0;  bayer[5]=4.0;  bayer[6]=14.0; bayer[7]=6.0;
    bayer[8]=3.0;   bayer[9]=11.0; bayer[10]=1.0; bayer[11]=9.0;
    bayer[12]=15.0; bayer[13]=7.0; bayer[14]=13.0; bayer[15]=5.0;
    float jitter = bayer[bayerIndex] / 16.0;
    float t = t0 + stepLen * jitter;

    float mu = dot(rd, uSunDirection);
    // Henyey-Greenstein anisotrópico para frente.
    float g = 0.55;
    float g2 = g * g;
    float phase = (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5));
    phase = mix(0.35, phase * 2.2, 0.65);

    vec3 scattered = vec3(0.0);
    float transmittance = 1.0;

    // Distância a partir da qual a amostra perde uma oitava. Proporcional ao
    // tamanho das massas: o que interessa é quantos "cúmulos" de distância a
    // amostra está, não quantas unidades — num planeta grande as nuvens são
    // maiores e continuam merecendo detalhe mais longe.
    float coarseAt = uFeatureScale * 5.0;

    for (int i = 0; i < MAX_STEPS; i++) {
      if (i >= steps || t > t1 || transmittance < 0.02) break;

      vec3 p = ro + rd * t;
      float travelled = t - t0;

      // -------------------------------------------------------------------
      // LOD POR AMOSTRA: detalhe cai com a distância percorrida no raio.
      //
      // O passo perto da câmera é curto e a amostra é cara; lá na frente o
      // passo já é longo e a amostra cobre uma região grande, então a oitava
      // fina só produz ruído que o próprio passo devolve como cintilação.
      // Cortar detalhe longe é gratuito visualmente e é onde está a maior
      // parte do custo, porque a maior parte do raio está longe.
      // -------------------------------------------------------------------
      bool near = travelled < coarseAt;
      int octaves = near ? uOctaves : max(uOctaves - 1, 1);
      bool erode = near && uOctaves >= 3;

      // Passo que CRESCE com a distância, pelo mesmo motivo.
      float lodStep = stepLen * (1.0 + travelled / coarseAt * 0.6);

      float density = cloudDensity(p, octaves, erode);

      // -------------------------------------------------------------------
      // SALTO DE ESPAÇO VAZIO.
      //
      // Numa cobertura típica (0,3–0,6) a maioria esmagadora das amostras cai
      // em céu limpo e paga o fBm para descobrir que ali não há nada. Dar um
      // passo 2,5x maior quando a amostra veio vazia percorre o mesmo trecho
      // com menos de metade das amostras. O salto é seguro porque o campo é
      // suave na escala de uFeatureScale, muito maior que o passo — uma
      // nuvem fina o bastante para caber inteira no salto não teria pixels.
      // -------------------------------------------------------------------
      if (density <= 0.001) {
        t += lodStep * 2.5;
        continue;
      }
      t += lodStep;

      // Marcha em direção ao sol: profundidade óptica até sair da casca.
      // Sempre na versão barata do campo (sem erosão, uma oitava a menos): o
      // resultado entra numa exponencial que borra qualquer detalhe fino.
      float sunDepth = 0.0;
      float sunStep = (uOuterRadius - uInnerRadius) / float(uLightSteps);
      for (int j = 0; j < LIGHT_STEPS; j++) {
        if (j >= uLightSteps) break;
        vec3 sp = p + uSunDirection * (float(j) + 0.5) * sunStep;
        sunDepth += cloudDensity(sp, max(uOctaves - 1, 1), false) * sunStep;
      }

      // O fator converte "densidade × unidades de mundo" em profundidade
      // óptica. Calibrado para que uma nuvem cheia atravessada de ponta a
      // ponta chegue a tau ~1: mais que isso e a base fica preta, menos e a
      // nuvem perde o volume e vira vapor.
      float tau = sunDepth * 0.025;
      // ---------------------------------------------------------------
      // BEER-LAMBERT SOZINHO DEIXA O MIOLO PRETO.
      //
      // A lei descreve a luz que atravessa a nuvem SEM ser espalhada, e num
      // cúmulo denso isso é praticamente zero. Só que a luz que sobra não
      // sumiu: ela ricocheteou entre gotículas e sai difusa — é por isso que
      // a barriga de uma nuvem real é cinza, não preta.
      //
      // Simular esses ricochetes é caro; a aproximação padrão (Guerrilla,
      // "Nubis") é somar um segundo termo com absorção bem menor. O max()
      // deixa o primeiro dominar nas bordas finas, onde a extinção é a
      // resposta certa, e o segundo assumir no miolo.
      // ---------------------------------------------------------------
      float beer = max(exp(-tau), exp(-tau * 0.25) * 0.7);
      // Powder: as bordas voltadas para o sol são MAIS escuras que o miolo,
      // porque ali há pouco material para espalhar de volta na sua direção.
      float powder = 1.0 - exp(-2.0 * density * lodStep * 0.4);

      vec3 sunLight = uSunColor * beer * powder * phase;
      // Sombra do planeta: o lado noturno não recebe sol nenhum.
      float dayLight = smoothstep(-0.12, 0.15, dot(normalize(p), uSunDirection));
      // O piso do ambiente é alto de propósito. Uma nuvem real não é iluminada
      // só pelo sol: ela recebe o céu inteiro por cima e o albedo do chão por
      // baixo, e é isso que a mantém CLARA mesmo na sombra própria. Com um
      // ambiente baixo, o cúmulo de meio-dia sai cinza-chumbo — parece
      // tempestade em todo planeta, o dia inteiro.
      vec3 ambient = uSkyColor * (0.45 + 0.75 * dayLight);

      vec3 luminance = uCloudColor * (sunLight * dayLight + ambient);

      // lodStep e não stepLen: a opacidade acumulada tem de ser
      // proporcional ao comprimento REAL do trecho representado pela amostra,
      // senão a nuvem fica mais rala longe do que perto só por causa do LOD.
      float alpha = 1.0 - exp(-density * lodStep * 0.5);
      scattered += transmittance * alpha * luminance;
      transmittance *= 1.0 - alpha;
    }

    float opacity = (1.0 - transmittance) * uOpacity;
    if (opacity < 0.002) discard;

    gl_FragColor = vec4(scattered * uOpacity, opacity);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/**
 * @param {object} config saída de `createPlanetConfig()`
 * @returns {{ mesh: THREE.Mesh, uniforms: object }}
 */
export function createClouds(config) {
  const { clouds } = config;
  const inner = config.radius + clouds.bottom;
  const outer = config.radius + clouds.top;

  const uniforms = {
    uPlanetCenter: { value: new THREE.Vector3() },
    uInnerRadius: { value: inner },
    uOuterRadius: { value: outer },
    uSunDirection: { value: new THREE.Vector3(1, 0, 0) },
    // 3.2 e nao 1.6: a fase de Henyey-Greenstein derruba o termo solar para
    // ~0.17 em iluminacao lateral, que e o caso da maior parte do ceu. Sem
    // compensar, so a nuvem apontada para o sol acende.
    uSunColor: { value: new THREE.Color().fromArray(config.sunColor).multiplyScalar(3.2) },
    uSkyColor: { value: new THREE.Color().fromArray(config.atmosphere.tint) },
    uCloudColor: { value: new THREE.Color().fromArray(clouds.color) },
    uCoverage: { value: clouds.coverage },
    uDensity: { value: clouds.density },
    uFeatureScale: { value: clouds.featureScale },
    uTime: { value: 0 },
    uWind: { value: new THREE.Vector3().fromArray(clouds.wind) },
    uOpacity: { value: 1 },
    uSteps: { value: 32 },
    uOctaves: { value: 3 },
    uLightSteps: { value: 3 },
  };

  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms,
    side: THREE.FrontSide, // trocado em tempo real, ver `Clouds.setSide()`
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    premultipliedAlpha: true,
  });

  // Uma casca ligeiramente MAIOR que `outer`: a geometria só precisa cobrir os
  // pixels em que pode haver nuvem, e se ela coincidisse exatamente com o raio
  // externo o ray marching começaria com `t0 = 0` e perderia a primeira
  // amostra por erro de precisão.
  const geometry = new THREE.SphereGeometry(outer * 1.001, 48, 32);
  const mesh = new THREE.Mesh(geometry, material);
  // Depois do terreno, ANTES da atmosfera: a atmosfera precisa espalhar por
  // cima das nuvens (é ela que tinge de laranja o topo dos cúmulos ao pôr do
  // sol), e o blending só faz isso se ela for desenhada por último.
  mesh.renderOrder = 5;
  mesh.frustumCulled = false;

  return { mesh, uniforms, inner, outer };
}
