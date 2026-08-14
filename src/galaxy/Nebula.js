/**
 * Nebulosa de fundo do mapa galáctico.
 *
 * É o LOD mais distante do mapa: o que preenche o espaço entre as estrelas e
 * dá à galáxia um volume em vez de um enxame de pontos no vazio.
 *
 * ===========================================================================
 * MARCHA CURTA NUMA CASCA, NÃO VOLUME COMPLETO
 * ===========================================================================
 * Ray marching volumétrico de verdade custa dezenas de amostras por pixel — o
 * projeto já paga isso nas nuvens dos planetas (`shaders/CloudShader.js`), e ali
 * vale porque o jogador voa dentro delas. No mapa a nebulosa é cenário: fica
 * sempre atrás de tudo e nunca é atravessada.
 *
 * Então a casca é desenhada pelo lado de dentro com poucas amostras ao longo do
 * raio, o suficiente para o ruído ganhar profundidade. O ganho é grande e a
 * diferença é quase invisível quando a coisa está a dezenas de unidades e serve
 * de pano de fundo.
 *
 * O ruído acompanha a origem local do mapa (a mesma recentragem das estrelas),
 * senão a nebulosa deslizaria por trás das estrelas a cada vez que o foco
 * mudasse de voxel — e nada denuncia mais um fundo falso do que ele se mover
 * junto com a câmera.
 */

import * as THREE from 'three';

const vertexShader = `
  varying vec3 vDir;

  void main() {
    // Direção do olho até o vértice, em espaço de mundo: é o raio que o
    // fragment shader vai marchar.
    vec4 mundo = modelMatrix * vec4(position, 1.0);
    vDir = mundo.xyz - cameraPosition;
    gl_Position = projectionMatrix * viewMatrix * mundo;
  }
`;

const fragmentShader = `
  precision highp float;

  uniform vec3 uCor;
  uniform vec3 uOrigem;
  uniform float uTempo;

  varying vec3 vDir;

  // Ruído por gradiente. Barato e suficiente: a nebulosa não precisa de
  // simplex, precisa de manchas suaves que não repitam de forma óbvia.
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
              dot(hash3(i + vec3(1,1,1)), f - vec3(1,1,1)), u.x), u.y), u.z);
  }

  float fbm(vec3 p) {
    float soma = 0.0;
    float amp = 0.5;
    // Quatro oitavas. Com três a nebulosa fica lisa demais e lê como neblina;
    // com cinco, o custo dobra para acrescentar detalhe menor que um pixel.
    for (int i = 0; i < 4; i++) {
      soma += ruido(p) * amp;
      p = p * 2.07 + vec3(11.3, 7.7, 5.1);
      amp *= 0.5;
    }
    return soma;
  }

  void main() {
    vec3 dir = normalize(vDir);
    vec3 base = uOrigem * 0.06 + vec3(0.0, uTempo * 0.004, 0.0);

    float densidade = 0.0;
    float peso = 0.0;
    // Quatro amostras ao longo do raio. Ver o cabeçalho: é cenário, não volume
    // atravessável.
    for (int i = 0; i < 4; i++) {
      float t = 0.35 + float(i) * 0.22;
      float w = 1.0 - float(i) * 0.18;
      densidade += fbm(base + dir * t * 2.6) * w;
      peso += w;
    }

    // -----------------------------------------------------------------------
    // NORMALIZAR ANTES DE REALÇAR.
    //
    // O fBm devolve algo em torno de [-0,5; 0,5]. A primeira versão elevava a
    // soma crua a 2,3 — e como a base era quase sempre menor que 1, a potência
    // ESMAGAVA o valor: a nebulosa saía com alfa na casa de 0,02 e o fundo do
    // mapa era preto puro.
    //
    // Levar para [0,1] primeiro e só então cortar com smoothstep dá o
    // filamento pretendido, com contraste onde ele existe de verdade.
    //
    // NOTA: nada de crase neste bloco. Ele está dentro de um template literal
    // de JavaScript, e uma crase de citação fecha a string no meio do shader —
    // o erro sai como "Unexpected identifier" na linha seguinte, sem nenhuma
    // pista de que a causa foi um comentário.
    // -----------------------------------------------------------------------
    densidade = clamp(densidade / peso * 1.5 + 0.5, 0.0, 1.0);
    float filamento = smoothstep(0.42, 0.92, densidade);

    // Duas cores: a da galáxia nos veios densos e um roxo frio no resto. Uma
    // cor só deixaria o fundo chapado, e é justamente o gradiente entre elas
    // que dá a impressão de profundidade.
    vec3 cor = mix(vec3(0.05, 0.04, 0.13), uCor, filamento);

    // Alfa contido de propósito: o fundo dá profundidade e não pode competir
    // com as estrelas, que são a informação do mapa.
    float alfa = clamp(0.06 + filamento * 0.45, 0.0, 0.55);
    gl_FragColor = vec4(cor * (0.35 + filamento * 1.1), alfa);
  }
`;

export function criarNebulosa() {
  const uniforms = {
    uCor: { value: new THREE.Color(0x8fd4ff) },
    uOrigem: { value: new THREE.Vector3() },
    uTempo: { value: 0 },
  };

  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(900, 32, 24),
    new THREE.ShaderMaterial({
      uniforms,
      vertexShader,
      fragmentShader,
      // Vista por dentro, sem escrever profundidade e desenhada primeiro: é
      // pano de fundo, e qualquer estrela precisa vencê-la sem disputa.
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    })
  );
  mesh.renderOrder = -10;
  mesh.frustumCulled = false;

  return {
    mesh,
    atualizar(camera, tempo, cor, origem) {
      // Acompanha a câmera: a casca é cenário no infinito, não um objeto.
      mesh.position.copy(camera.position);
      uniforms.uTempo.value = tempo;
      uniforms.uCor.value.setHex(cor);
      uniforms.uOrigem.value.set(origem.x, origem.y, origem.z);
    },
    dispose() {
      mesh.geometry.dispose();
      mesh.material.dispose();
    },
  };
}
