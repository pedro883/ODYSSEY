/**
 * Clima de superfície: chuva, neve e ventania de areia.
 *
 * ===========================================================================
 * O CLIMA É DEDUZIDO, NÃO SORTEADO
 * ===========================================================================
 * Não há estado de clima guardado em lugar nenhum, nem simulação de frentes
 * frias. O tempo num ponto é uma FUNÇÃO da posição e do relógio: umidade e
 * temperatura do terreno dizem o que PODE cair ali (chuva num bosque, neve num
 * planalto gelado, areia num deserto) e um campo lento no tempo diz se está
 * caindo agora.
 *
 * É a mesma escolha que rege o resto do projeto — o mundo é uma função, não um
 * banco de dados — e ela dá de graça duas coisas difíceis de outro jeito: dois
 * jogadores na mesma sala veem a MESMA chuva sem trocar um byte, e sair voando
 * e voltar meia hora depois encontra o tempo que a hora pede, não o que ficou
 * salvo numa variável.
 *
 * ===========================================================================
 * AS PARTÍCULAS ACOMPANHAM A CÂMERA
 * ===========================================================================
 * O grupo inteiro é reposicionado na câmera a cada frame e as partículas vivem
 * em coordenadas LOCAIS a ele. Isso resolve, sem nenhum código extra, o
 * problema que mais atrapalharia aqui: a origem flutuante desloca a cena
 * inteira quando o jogador anda, e partículas em coordenadas de mundo saltariam
 * junto a cada recentragem. Também limita o número de partículas ao volume que
 * de fato se vê — chover no planeta inteiro seria desenhar milhões de gotas
 * para mostrar algumas centenas.
 */

import * as THREE from 'three';

/** Quantas partículas o volume ao redor da câmera comporta. */
const MAX_PARTICULAS = 2600;

/** Meia-aresta do volume de precipitação ao redor da câmera. */
const RAIO_VOLUME = 26;

/** Abaixo desta densidade de ar não há clima: já é atmosfera rarefeita. */
const ATMOSFERA_MINIMA = 0.5;

export const CLIMAS = {
  LIMPO: 'Limpo',
  CHUVA: 'Chuva',
  TEMPESTADE: 'Tempestade',
  NEVE: 'Neve',
  AREIA: 'Ventania de areia',
  NEBLINA: 'Neblina',
};

const _up = new THREE.Vector3();
const _lado = new THREE.Vector3();
const _frente = new THREE.Vector3();
const _queda = new THREE.Vector3();

export class Weather {
  /**
   * @param {THREE.Scene} scene
   * @param {import('../core/GameState.js').GameState} gameState
   */
  constructor(scene, gameState) {
    this.gameState = gameState;
    this.clima = CLIMAS.LIMPO;
    /** 0..1 — quanto o clima atual está "ligado". Sobe e desce devagar. */
    this.intensidade = 0;
    this._alvo = 0;
    this._tempo = 0;
    /** Névoa extra pedida pelo tempo, somada à da atmosfera. */
    this.nevoaExtra = 0;

    this.grupo = new THREE.Group();
    scene.add(this.grupo);

    const geometria = new THREE.BufferGeometry();
    const posicoes = new Float32Array(MAX_PARTICULAS * 3);
    const semente = new Float32Array(MAX_PARTICULAS);
    for (let i = 0; i < MAX_PARTICULAS; i++) {
      semente[i] = Math.random();
      posicoes[i * 3] = (Math.random() * 2 - 1) * RAIO_VOLUME;
      posicoes[i * 3 + 1] = (Math.random() * 2 - 1) * RAIO_VOLUME;
      posicoes[i * 3 + 2] = (Math.random() * 2 - 1) * RAIO_VOLUME;
    }

    geometria.setAttribute(
      'position',
      new THREE.BufferAttribute(posicoes, 3).setUsage(THREE.DynamicDrawUsage)
    );
    geometria.setAttribute('semente', new THREE.BufferAttribute(semente, 1));
    geometria.setDrawRange(0, 0);

    this._posicoes = posicoes;
    this._geometria = geometria;

    this.uniforms = {
      uCor: { value: new THREE.Color(0xaecbe0) },
      uTamanho: { value: 0.09 },
      uAlongamento: { value: 1.0 },
      uOpacidade: { value: 0.6 },
      uEscalaPonto: { value: 700 },
    };

    this._material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      // Sem escrever profundidade: uma gota a meio metro do olho recortaria em
      // retângulo tudo o que estivesse atrás dela.
      depthWrite: false,
      vertexShader: /* glsl */ `
        attribute float semente;
        uniform float uTamanho;
        uniform float uEscalaPonto;
        varying float vSemente;
        void main() {
          vSemente = semente;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = clamp(uTamanho * uEscalaPonto / max(-mv.z, 0.001), 1.0, 26.0);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        precision mediump float;
        uniform vec3 uCor;
        uniform float uOpacidade;
        uniform float uAlongamento;
        varying float vSemente;
        void main() {
          // O alongamento no espaço do ponto transforma o MESMO sistema em
          // risco de chuva (esticado) ou floco de neve (redondo), sem trocar de
          // malha nem de material.
          vec2 d = gl_PointCoord - 0.5;
          d.y /= uAlongamento;
          float r = length(d) * 2.0;
          if (r > 1.0) discard;
          float a = (1.0 - r) * uOpacidade * (0.55 + vSemente * 0.7);
          gl_FragColor = vec4(uCor, a);
        }
      `,
    });

    this.pontos = new THREE.Points(geometria, this._material);
    this.pontos.frustumCulled = false;
    this.pontos.visible = false;
    this.grupo.add(this.pontos);
  }

  /**
   * Decide o tempo num ponto do planeta.
   *
   * Função pura (a menos do relógio): é ela que o HUD consulta, e é ela que
   * outro cliente recalcularia idêntica sem receber nada pela rede.
   */
  climaEm(planeta, posicao) {
    const cfg = planeta.config;
    const amostra = planeta.sampleAt(posicao);
    const d = amostra.direction;
    const elev = amostra.elevation;

    if (cfg.hasWater && elev < 0) return { clima: CLIMAS.LIMPO, forca: 0 };

    const umidade = planeta.sampler.moistureAt(d.x, d.y, d.z);
    const temperatura = planeta.sampler.temperatureAt(d.x, d.y, d.z, elev);

    // Campo lento no TEMPO, ancorado no ponto do espaço: é o que faz o tempo
    // virar ao longo de minutos, e virar em lugares diferentes em horas
    // diferentes, em vez de o planeta inteiro ligar a chuva junto.
    const fase =
      Math.sin(this._tempo * 0.018 + d.x * 6.1) * 0.5 +
      Math.sin(this._tempo * 0.0113 + d.z * 4.7 + 2.1) * 0.5;

    const carga = umidade * 0.8 + fase * 0.42;

    if (temperatura < 0.3) {
      // Neve precisa de umidade: um planalto gelado e seco é só frio.
      if (carga > 0.5) return { clima: CLIMAS.NEVE, forca: Math.min(1, (carga - 0.5) * 3.2) };
      return { clima: CLIMAS.LIMPO, forca: 0 };
    }

    if (umidade < 0.34) {
      // No deserto o que sobe é areia, e ela depende do VENTO (a parte
      // oscilante), não da umidade — daí o limiar olhar só para a fase.
      if (fase > 0.3) return { clima: CLIMAS.AREIA, forca: Math.min(1, (fase - 0.3) * 2.4) };
      return { clima: CLIMAS.LIMPO, forca: 0 };
    }

    if (carga > 0.88) return { clima: CLIMAS.TEMPESTADE, forca: 1 };
    if (carga > 0.62) return { clima: CLIMAS.CHUVA, forca: Math.min(1, (carga - 0.62) * 3.4) };
    if (carga > 0.52) return { clima: CLIMAS.NEBLINA, forca: Math.min(1, (carga - 0.52) * 8) };
    return { clima: CLIMAS.LIMPO, forca: 0 };
  }

  /**
   * @param {number} dt
   * @param {import('./Planet.js').Planet} planeta
   * @param {THREE.Vector3} posicao jogador, em espaço de mundo
   * @param {THREE.Vector3} cameraPos câmera, em espaço de mundo (cena)
   */
  update(dt, planeta, posicao, cameraPos) {
    this._tempo += dt;

    // Fora da atmosfera não chove — e gota no vácuo é o tipo de detalhe que
    // denuncia um sistema que não sabe onde está.
    const dentro = this.gameState.atmosphere > ATMOSFERA_MINIMA;
    const leitura = dentro ? this.climaEm(planeta, posicao) : { clima: CLIMAS.LIMPO, forca: 0 };

    this.clima = leitura.clima;
    this._alvo = leitura.forca;

    // Transição lenta nos dois sentidos: chuva que começa e para em meio
    // segundo lê como falha de renderização, não como o tempo mudando.
    this.intensidade += (this._alvo - this.intensidade) * (1 - Math.exp(-0.3 * dt));

    // Ar carregado fecha o horizonte. É metade do efeito: a chuva convence
    // muito mais pela distância que ela ESCONDE do que pelas gotas em si.
    const fatorNevoa =
      this.clima === CLIMAS.TEMPESTADE ? 2.6 :
      this.clima === CLIMAS.AREIA ? 3.2 :
      this.clima === CLIMAS.NEBLINA ? 2.2 :
      this.clima === CLIMAS.NEVE ? 1.6 :
      this.clima === CLIMAS.CHUVA ? 1.4 : 0;
    this.nevoaExtra = fatorNevoa * this.intensidade;

    const semPartículas =
      this.intensidade < 0.02 || this.clima === CLIMAS.LIMPO || this.clima === CLIMAS.NEBLINA;
    if (semPartículas) {
      this.pontos.visible = false;
      this._geometria.setDrawRange(0, 0);
      return;
    }

    this.grupo.position.copy(cameraPos);
    this._configurarAparencia();
    this._mover(dt, planeta, posicao);
    this.pontos.visible = true;
  }

  /** Cor, tamanho e forma de cada tipo de tempo. */
  _configurarAparencia() {
    const u = this.uniforms;
    const i = this.intensidade;

    switch (this.clima) {
      case CLIMAS.NEVE:
        u.uCor.value.setHex(0xf2f8ff);
        u.uTamanho.value = 0.07;
        u.uAlongamento.value = 1;      // floco: redondo
        u.uOpacidade.value = 0.9 * i;
        break;
      case CLIMAS.AREIA:
        u.uCor.value.setHex(0xd9b07a);
        u.uTamanho.value = 0.05;
        u.uAlongamento.value = 0.45;   // grão puxado na horizontal
        u.uOpacidade.value = 0.55 * i;
        break;
      case CLIMAS.TEMPESTADE:
        u.uCor.value.setHex(0x9fb8cc);
        u.uTamanho.value = 0.12;
        u.uAlongamento.value = 5.5;    // risco longo
        u.uOpacidade.value = 0.6 * i;
        break;
      default: // chuva
        u.uCor.value.setHex(0xaecbe0);
        u.uTamanho.value = 0.09;
        u.uAlongamento.value = 3.6;
        u.uOpacidade.value = 0.45 * i;
        break;
    }

    u.uEscalaPonto.value =
      window.innerHeight / (2 * Math.tan(THREE.MathUtils.degToRad(60) / 2));
  }

  /**
   * Integra as partículas e recicla as que saíram do volume.
   *
   * O reaproveitamento é por ENVOLVIMENTO (a partícula que sai por baixo volta
   * por cima), e não por sorteio de uma posição nova: sorteando, o volume
   * inteiro se reembaralha e a chuva parece piscar. Envolvendo, cada gota
   * continua a sua trajetória e a cortina fica contínua.
   */
  _mover(dt, planeta, posicao) {
    const ativas = Math.floor(MAX_PARTICULAS * Math.min(1, this.intensidade * 1.2));
    const pos = this._posicoes;

    // "Para baixo" é o radial do planeta, não o -Y do mundo: a cem quilômetros
    // dali a vertical é outra, e a chuva cairia inclinada.
    _up.copy(planeta.sampleAt(posicao).direction);
    _lado.set(-_up.y, _up.x, 0);
    if (_lado.lengthSq() < 1e-6) _lado.set(1, 0, 0);
    _lado.normalize();
    _frente.crossVectors(_up, _lado);

    const velocidade =
      this.clima === CLIMAS.NEVE ? 3.5 :
      this.clima === CLIMAS.AREIA ? 2.0 :
      this.clima === CLIMAS.TEMPESTADE ? 42 : 26;

    // Vento: constante para areia (ventania), oscilante para o resto.
    const vento =
      this.clima === CLIMAS.AREIA
        ? 26
        : Math.sin(this._tempo * 0.37) * (this.clima === CLIMAS.TEMPESTADE ? 12 : 4);

    _queda.copy(_up).multiplyScalar(-velocidade).addScaledVector(_lado, vento);

    const dx = _queda.x * dt;
    const dy = _queda.y * dt;
    const dz = _queda.z * dt;
    const limite = RAIO_VOLUME;
    const envolver = (v) => (v > limite ? v - 2 * limite : v < -limite ? v + 2 * limite : v);

    for (let i = 0; i < ativas; i++) {
      const o = i * 3;
      pos[o] = envolver(pos[o] + dx);
      pos[o + 1] = envolver(pos[o + 1] + dy);
      pos[o + 2] = envolver(pos[o + 2] + dz);
    }

    this._geometria.setDrawRange(0, ativas);
    this._geometria.attributes.position.needsUpdate = true;
  }

  dispose() {
    this._geometria.dispose();
    this._material.dispose();
    this.grupo.removeFromParent();
  }
}
