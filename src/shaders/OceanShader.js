/**
 * Oceano planetário.
 *
 * ===========================================================================
 * O QUE ESTAVA AQUI ANTES, E POR QUE NÃO BASTAVA
 * ===========================================================================
 * O oceano era uma esfera com `MeshStandardMaterial` translúcido. Da órbita
 * funcionava; ao nível dos olhos era uma superfície de plástico azul, sem
 * movimento, sem horizonte e — o pior — com a mesma cor em cima de um banco de
 * areia e sobre uma fossa de mil unidades. Água que não muda de cor com a
 * profundidade não lê como água: lê como um plano pintado atravessando a
 * paisagem, e a linha da praia vira um corte reto.
 *
 * ===========================================================================
 * PROFUNDIDADE VEM DA GEOMETRIA, NÃO DO DEPTH BUFFER
 * ===========================================================================
 * O caminho usual para água é ler o depth buffer da cena e comparar com a
 * superfície. Aqui isso seria caro e frágil: o terreno é desenhado num alvo
 * separado quando a perspectiva aérea está ligada (ver `Engine.render`), e o
 * oceano teria de conhecer esse arranjo.
 *
 * Em compensação, este projeto tem uma vantagem que jogo nenhum com terreno
 * autorado tem: a profundidade é uma FUNÇÃO, conhecida na CPU antes de o
 * primeiro frame existir. Amostrar o relevo uma vez por vértice da esfera e
 * gravar isso num atributo dá o gradiente de praia, a espuma na arrebentação e
 * a cor por profundidade de graça, sem nenhum passe extra e sem depender de
 * como o resto da cena é renderizado.
 *
 * ===========================================================================
 * ONDAS
 * ===========================================================================
 * Três camadas de ruído de gradiente rolando em direções diferentes,
 * perturbando a NORMAL (não a posição). Deslocar vértices numa esfera de 128×96
 * daria ondas de centenas de unidades de crista — visíveis da órbita como uma
 * bola amassada. O que se quer ver do convés é o brilho quebrando, e isso é
 * função da normal.
 */

import * as THREE from 'three';

/**
 * @param {object} cfg configuração do planeta
 * @param {(x:number,y:number,z:number)=>number} heightAt amostrador de relevo
 */
export function criarOceano(cfg, heightAt) {
  // ---------------------------------------------------------------------------
  // A RESOLUÇÃO É DITADA PELA COSTA, NÃO PELA SILHUETA.
  //
  // Com 160×112 num planeta de 4 600 de raio, cada quadrilátero tem ~180
  // unidades de lado — quase dois campos de futebol. A silhueta do horizonte
  // ficava lisa (era o critério antigo, e estava errado), mas a PROFUNDIDADE,
  // que é amostrada por vértice, virava um mapa grosseiro demais para saber
  // onde está a linha da praia: quadrantes inteiros de mar raso eram
  // classificados como terra e recortados, e o oceano aparecia como um
  // xadrez de manchas em vez de uma superfície.
  //
  // 320×224 (72 mil vértices) põe o quadrilátero em ~90 unidades e custa uma
  // única passada de ~70 ms no nascimento do planeta — pago uma vez, e só em
  // mundos que têm água.
  // ---------------------------------------------------------------------------
  const geometria = new THREE.SphereGeometry(cfg.radius, 320, 224);

  // -------------------------------------------------------------------------
  // Profundidade por vértice, em unidades de mundo.
  //
  // Positiva = há água ali (o fundo está abaixo do nível do mar). Negativa =
  // o "fundo" está acima da linha d'água, ou seja, é terra seca — e o shader
  // usa isso para sumir com a casca em vez de deixá-la cortando o continente.
  // -------------------------------------------------------------------------
  const posicoes = geometria.attributes.position;
  const profundidade = new Float32Array(posicoes.count);
  const inv = 1 / cfg.radius;

  for (let i = 0; i < posicoes.count; i++) {
    const x = posicoes.getX(i) * inv;
    const y = posicoes.getY(i) * inv;
    const z = posicoes.getZ(i) * inv;
    profundidade[i] = -heightAt(x, y, z);
  }
  geometria.setAttribute('profundidade', new THREE.BufferAttribute(profundidade, 1));

  // ---------------------------------------------------------------------------
  // AS CORES SÃO DE ÁGUA, NÃO DA PALETA DO PLANETA.
  //
  // A primeira versão misturava as cores do fundo do mar com o `waterColor` do
  // planeta em partes quase iguais. Num mundo de paleta quente o resultado era
  // um caldo amarelo-esverdeado que não lê como água — e "não parece água" é o
  // pior defeito possível numa superfície que ocupa metade do planeta.
  //
  // Agora a base é sempre água (ciano raso, azul-petróleo fundo) e o tom do
  // planeta entra como TEMPERO (25% no raso, 15% no fundo): o suficiente para
  // dois mundos terem mares distinguíveis, longe do bastante para nenhum deles
  // deixar de ser mar.
  // ---------------------------------------------------------------------------
  const tom = new THREE.Color().fromArray(cfg.waterColor);
  const raso = new THREE.Color(0x3fc2c9).lerp(tom, 0.2);
  const fundo = new THREE.Color(0x06263f).lerp(tom, 0.15);

  const uniforms = {
    uTempo: { value: 0 },
    uSol: { value: new THREE.Vector3(0, 1, 0) },
    uCamera: { value: new THREE.Vector3() },
    uRaso: { value: raso },
    uFundo: { value: fundo },
    uEspuma: { value: new THREE.Color(0xeaf6ff) },
    uCeu: { value: new THREE.Color().fromArray(cfg.atmosphere.tint) },
    // Escala das ondas, em ciclos por unidade de mundo. 0.06 põe a ondulação
    // maior em ~16 unidades e a menor em ~2 — ondas de mar, na escala de uma
    // nave de 4 unidades. Fixa em unidades de MUNDO e não em fração do raio: a
    // água de uma lua e a de um gigante têm o mesmo tamanho de onda, porque o
    // que dá a escala é o observador, não o corpo celeste.
    uEscalaOnda: { value: 0.06 },
    // 1 quando a câmera está submersa. Muda a face desenhada e a cor.
    uSubmerso: { value: 0 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    // DUAS FACES: com `FrontSide`, mergulhar fazia a água simplesmente sumir —
    // o nadador via o céu por dentro do mar. A face de dentro é o teto de água
    // sobre a cabeça de quem está submerso.
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      attribute float profundidade;
      varying float vProf;
      varying vec3 vLocal;
      varying vec3 vNormal;

      void main() {
        vProf = profundidade;
        vLocal = position;
        vNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;

      uniform float uTempo;
      uniform vec3 uSol;
      uniform vec3 uCamera;
      uniform vec3 uRaso;
      uniform vec3 uFundo;
      uniform vec3 uEspuma;
      uniform vec3 uCeu;
      uniform float uEscalaOnda;
      uniform float uSubmerso;

      varying float vProf;
      varying vec3 vLocal;
      varying vec3 vNormal;

      // Ruído de gradiente 3D. Barato e sem textura — o oceano precisa
      // funcionar num planeta gerado em tempo de execução, onde não há atlas
      // de normal map para carregar.
      vec3 hash3(vec3 p) {
        p = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
                 dot(p, vec3(269.5, 183.3, 246.1)),
                 dot(p, vec3(113.5, 271.9, 124.6)));
        return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
      }

      float ruido(vec3 p) {
        vec3 i = floor(p);
        vec3 f = fract(p);
        vec3 u = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(mix(dot(hash3(i + vec3(0,0,0)), f - vec3(0,0,0)),
                  dot(hash3(i + vec3(1,0,0)), f - vec3(1,0,0)), u.x),
              mix(dot(hash3(i + vec3(0,1,0)), f - vec3(0,1,0)),
                  dot(hash3(i + vec3(1,1,0)), f - vec3(1,1,0)), u.x), u.y),
          mix(mix(dot(hash3(i + vec3(0,0,1)), f - vec3(0,0,1)),
                  dot(hash3(i + vec3(1,0,1)), f - vec3(1,0,1)), u.x),
              mix(dot(hash3(i + vec3(0,1,1)), f - vec3(0,1,1)),
                  dot(hash3(i + vec3(1,1,1)), f - vec3(1,1,1)), u.x), u.y),
          u.z);
      }

      void main() {
        // ---------------------------------------------------------------
        // QUEM ESCONDE A ÁGUA SOB O CONTINENTE É O TESTE DE PROFUNDIDADE.
        //
        // O recorte por vértice (descartar onde a profundidade fosse
        // negativa) parecia a solução óbvia e era a
        // fonte do xadrez descrito acima: a profundidade interpolada entre
        // vértices a 90 unidades não sabe onde a praia começa. O terreno já é
        // desenhado ANTES e opaco, então todo pixel de água atrás de terra
        // alta é descartado pelo z-buffer — de graça e com precisão de pixel.
        //
        // O corte aqui sobra só para o interior do continente, onde a casca
        // do nível do mar corre dezenas de unidades abaixo do chão e não tem
        // como ser vista: pular esses fragmentos economiza mistura à toa.
        // ---------------------------------------------------------------
        if (vProf < -40.0) discard;

        vec3 radial = normalize(vLocal);
        vec3 paraCamera = normalize(uCamera - vLocal);

        // -------------------------------------------------------------------
        // ONDAS
        //
        // Quatro escalas de ruído rolando em direções e velocidades
        // diferentes. O que mudou em relação à primeira versão não foi a
        // quantidade de camadas e sim a AMPLITUDE: o gradiente entrava na
        // normal multiplicado por ~3, o que girava a normal quase 90° entre
        // pixels vizinhos e produzia um mosaico de manchas claras e escuras —
        // a água ficava com aspecto de camuflagem, não de água.
        //
        // Onda de mar mexe pouco com a normal e muito com o BRILHO: a leitura
        // de "superfície líquida em movimento" vem do especular deslizando
        // sobre a ondulação, não de a superfície mudar de cor.
        // -------------------------------------------------------------------
        vec3 p = vLocal * uEscalaOnda;
        float t = uTempo;
        float e = 0.6;

        vec3 d1 = vec3(t * 0.09, t * 0.05, 0.0);
        vec3 d2 = vec3(-t * 0.13, 0.0, t * 0.11);
        vec3 d3 = vec3(t * 0.21, -t * 0.17, t * 0.05);
        vec3 d4 = vec3(-t * 0.31, t * 0.23, 0.0);

        float a0 = ruido(p * 0.35 + d1);
        float ax = ruido((p + vec3(e, 0, 0)) * 0.35 + d1);
        float az = ruido((p + vec3(0, 0, e)) * 0.35 + d1);

        float b0 = ruido(p * 1.0 + d2);
        float bx = ruido((p + vec3(e, 0, 0)) * 1.0 + d2);
        float bz = ruido((p + vec3(0, 0, e)) * 1.0 + d2);

        float c0 = ruido(p * 2.7 + d3);
        float cx = ruido((p + vec3(e, 0, 0)) * 2.7 + d3);
        float cz = ruido((p + vec3(0, 0, e)) * 2.7 + d3);

        float f0 = ruido(p * 6.5 + d4);
        float fx = ruido((p + vec3(e, 0, 0)) * 6.5 + d4);
        float fz = ruido((p + vec3(0, 0, e)) * 6.5 + d4);

        // A ondulação grande morre no raso — perto da praia a água é agitada
        // por dentro, não ondulada.
        float aguaAberta = smoothstep(1.0, 25.0, vProf);
        float gx = (ax - a0) * 0.5 * aguaAberta + (bx - b0) * 0.32 + (cx - c0) * 0.22 + (fx - f0) * 0.16;
        float gz = (az - a0) * 0.5 * aguaAberta + (bz - b0) * 0.32 + (cz - c0) * 0.22 + (fz - f0) * 0.16;

        vec3 tangente = normalize(cross(radial, vec3(0.0, 1.0, 0.0)) + vec3(1e-5));
        vec3 bitangente = cross(radial, tangente);
        // 0.55 no lugar dos ~3 de antes: inclinação de onda de verdade.
        vec3 normal = normalize(radial + (tangente * gx + bitangente * gz) * 0.95);
        float crista = (b0 + c0) * 0.5;

        // --- Cor por profundidade -------------------------------------------
        float mistura = smoothstep(0.5, 45.0, vProf);
        vec3 cor = mix(uRaso, uFundo, mistura);

        // --- Espuma ----------------------------------------------------------
        // Duas fontes: a arrebentação (onde o fundo sobe) e as cristas das
        // ondas em mar aberto. Sem a segunda, o mar longe da costa fica liso
        // demais e denuncia que a "onda" é só iluminação.
        float borda = 1.0 - smoothstep(0.0, 4.5, vProf);
        float renda = ruido(vLocal * uEscalaOnda * 7.0 + vec3(uTempo * 0.5)) * 0.5 + 0.5;
        float espuma = smoothstep(0.4, 0.95, borda * (0.5 + renda));
        espuma = max(espuma, smoothstep(0.30, 0.42, crista) * aguaAberta * 0.5);
        cor = mix(cor, uEspuma, espuma);

        // --- Luz --------------------------------------------------------------
        // O piso de luz ambiente é ALTO (0.55) por um motivo específico: a
        // água quase nunca encara o sol de frente — a normal dela aponta para
        // cima e o sol passa rasante boa parte do dia. Com piso baixo, o mar
        // fica preto ao entardecer e o que sobra na tela é o fundo aparecendo
        // por transparência, o que lê como poça de lama, não como mar.
        float difusa = max(dot(normal, uSol), 0.0);
        cor *= 0.55 + 0.6 * difusa;

        // Especular largo (o brilho do céu na ondulação) + estreito (o sol).
        vec3 meio = normalize(uSol + paraCamera);
        float ndoth = max(dot(normal, meio), 0.0);
        // Expoente 140 e não 420: com o brilho concentrado demais, o reflexo do
        // sol vira um ponto único do tamanho de um pixel e a ondulação some.
        // Mais aberto, ele se espalha pelas cristas e desenha o caminho de luz
        // sobre o mar — que é o que faz a água parecer em movimento.
        cor += uCeu * pow(ndoth, 18.0) * 0.4;
        cor += vec3(1.0, 0.96, 0.88) * pow(ndoth, 140.0) * 2.6;

        // --- Fresnel ----------------------------------------------------------
        // De cima a água deixa ver o fundo; de raspão vira espelho do céu. É a
        // pista que separa "olhar para o mar" de "olhar para dentro dele".
        // 0.35 e não 0.6: com 0.6, olhar o mar de pé (ângulo quase rasante,
        // fresnel ~1) trocava dois terços da cor da água pela do céu e o
        // oceano virava uma chapa cinza-clara até o horizonte.
        float fresnel = pow(1.0 - max(dot(normal, paraCamera), 0.0), 4.0);
        cor = mix(cor, uCeu * 0.85, fresnel * 0.35);

        // --- Submerso ---------------------------------------------------------
        // Visto de baixo, o que se vê é a massa de água entre o olho e o céu:
        // azul profundo, praticamente opaco, com a luz vindo de cima.
        cor = mix(cor, uFundo * (0.5 + 0.5 * difusa), uSubmerso);

        // A transparência é generosa só na beirada. Antes ela ia de 0.55 a
        // 0.96 ao longo de dez unidades, e como quase todo litoral tem menos
        // que isso, o mar inteiro aparecia meio transparente: o que se via era
        // o FUNDO ARENOSO por baixo de um véu azul, ou seja, um caldo esverdeado.
        // Agora só a franja da praia deixa ver o fundo.
        float alfa = mix(0.86, 0.99, smoothstep(0.0, 5.0, vProf));
        alfa = max(alfa, espuma);
        alfa = clamp(alfa + fresnel * 0.4, 0.0, 1.0);
        alfa = mix(alfa, 0.94, uSubmerso);

        gl_FragColor = vec4(cor, alfa);
      }
    `,
  });

  const mesh = new THREE.Mesh(geometria, material);
  // Depois do terreno (0) e antes das nuvens (5) e da atmosfera (10).
  mesh.renderOrder = 1;

  return {
    mesh,
    uniforms,
    /**
     * @param {THREE.Vector3} cameraLocal câmera no espaço do planeta
     * @param {THREE.Vector3} sunDirection direção até o sol, em mundo
     * @param {number} elapsed segundos desde o boot
     */
    atualizar(cameraLocal, sunDirection, elapsed) {
      uniforms.uTempo.value = elapsed;
      uniforms.uCamera.value.copy(cameraLocal);
      uniforms.uSol.value.copy(sunDirection);
      // Submerso quando a câmera está dentro da esfera do nível do mar.
      uniforms.uSubmerso.value = cameraLocal.length() < cfg.radius ? 1 : 0;
    },
    dispose() {
      geometria.dispose();
      material.dispose();
    },
  };
}
