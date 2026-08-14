/**
 * Projéteis de energia — o que o blaster (e, depois, os canhões da nave) atira.
 *
 * ===========================================================================
 * POR QUE PROJÉTIL E NÃO RAYCAST
 * ===========================================================================
 * Tiro instantâneo (*hitscan*) é mais simples e mais barato: um raio por
 * disparo, acerto resolvido no mesmo quadro. Foi descartado por dois motivos
 * que valem mais que a economia:
 *
 *   1. O jogo tem combate de naves na lista, e o *lead indicator* — mirar à
 *      frente do alvo para compensar o tempo de voo — só existe se houver tempo
 *      de voo. Com hitscan a mecânica inteira some.
 *   2. Um traçante que atravessa o vale é a única leitura que o jogador tem da
 *      distância e da direção do inimigo. Com hitscan não há nada na tela entre
 *      apertar o botão e o alvo piscar.
 *
 * ===========================================================================
 * UM SÓ `InstancedMesh`, E POSIÇÃO EM ESPAÇO DE CENA
 * ===========================================================================
 * Todos os tiros vivos são instâncias de uma malha só: uma chamada de desenho
 * para os 256, contra uma por tiro se cada um fosse um `Mesh`. O pool é fixo e
 * o disparo mais antigo é reciclado quando estoura — um tiro que some cedo
 * demais numa metralhadora ninguém percebe; um pico de alocação no meio do
 * combate, sim.
 *
 * A simulação roda em espaço de CENA (a mesma em que a câmera e os planetas
 * vivem), o que obriga a reagir ao rebase da origem flutuante — ver `deslocar`.
 * A alternativa, guardar posição absoluta e converter na hora de desenhar,
 * custaria uma subtração por tiro por quadro para evitar uma subtração por tiro
 * a cada poucos minutos.
 */

import * as THREE from 'three';

/** Teto de tiros vivos ao mesmo tempo. */
const MAXIMO = 256;

/**
 * Passo máximo de integração, em segundos.
 *
 * Um tiro a 180 u/s anda 3 unidades num quadro de 60 fps — menos que o raio de
 * qualquer alvo, então testar só a posição final basta. A 15 fps ele andaria 12,
 * e ATRAVESSARIA uma criatura inteira entre dois testes. Subdividir o passo é o
 * que impede que o jogo fique mais fácil de errar quanto pior a máquina.
 */
const PASSO_MAXIMO = 1 / 60;

const _pos = new THREE.Vector3();
const _prox = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _alvo = new THREE.Vector3();
const _mundo = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _escala = new THREE.Vector3();
const _matriz = new THREE.Matrix4();
const _eixo = new THREE.Vector3(0, 1, 0);
const _cor = new THREE.Color();

/** Guardado longe da cena: instância livre não pode aparecer na origem. */
const LONGE = new THREE.Vector3(0, -1e9, 0);

export class Projeteis {
  /**
   * @param {THREE.Scene} cena
   */
  constructor(cena) {
    // Cápsula alongada no eixo Y, girada para o eixo de voo em `_escrever`. Um
    // plano com textura (billboard) seria mais barato, e erraria: visto de lado
    // o traçante precisa ter comprimento, e é justamente de lado que se vê o
    // tiro dos outros.
    const geometria = new THREE.CapsuleGeometry(0.09, 0.85, 4, 6);

    const material = new THREE.MeshBasicMaterial({
      // -------------------------------------------------------------------
      // NADA DE `vertexColors` AQUI.
      //
      // Parece o que se quer — a cor vem por instância, afinal — e é o oposto.
      // `vertexColors` liga `USE_COLOR`, e o shader do three passa a multiplicar
      // por um atributo `color` POR VÉRTICE que esta geometria não tem. Atributo
      // ausente vale zero, a cor final vira preta, e preto em blending aditivo é
      // exatamente invisível.
      //
      // O sintoma foi cruel de diagnosticar porque tudo o mais estava certo: as
      // instâncias existiam, o contador subia, as posições projetavam no lugar
      // correto da tela e nenhum erro aparecia no console. Só comparando os
      // pixels do mesmo quadro com e sem tiros — idênticos — ficou claro que a
      // geometria estava sendo desenhada em preto.
      //
      // A cor por instância é lida de `instanceColor`, que o renderizador ativa
      // sozinho (`USE_INSTANCING_COLOR`) quando o atributo existe.
      // -------------------------------------------------------------------
      // Básico e aditivo: o tiro é uma fonte de luz, não uma superfície. Com
      // material iluminado ele ficaria escuro no lado noturno do planeta, que é
      // exatamente onde precisa aparecer mais.
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    });

    this.malha = new THREE.InstancedMesh(geometria, material, MAXIMO);
    this.malha.count = 0;
    this.malha.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.malha.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(MAXIMO * 3),
      3
    );
    // Os tiros cobrem a cena inteira ao redor do jogador e a esfera envolvente
    // seria recalculada a cada quadro para não descartar nada.
    this.malha.frustumCulled = false;
    this.malha.renderOrder = 6;
    cena.add(this.malha);

    /**
     * Pool pré-alocado. Os objetos nunca são criados nem descartados durante o
     * jogo — só marcados vivos ou mortos. Combate é o pior momento possível
     * para o coletor de lixo acordar.
     */
    this.tiros = [];
    for (let i = 0; i < MAXIMO; i++) {
      this.tiros.push({
        vivo: false,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        cor: new THREE.Color(),
        dano: 0,
        raio: 0.6,
        vida: 0,
        dono: null,
        tipo: 'bolt',
        /** Carga útil da granada: raio de explosão, cratera. */
        explosao: null,
      });
    }
    this._proximo = 0;

    /** @type {((impacto: object) => void) | null} */
    this.aoImpactar = null;
  }

  get vivos() {
    let n = 0;
    for (const t of this.tiros) if (t.vivo) n++;
    return n;
  }

  /**
   * Coloca um tiro no mundo.
   *
   * @param {object} o
   * @param {THREE.Vector3} o.origem em espaço de cena
   * @param {THREE.Vector3} o.direcao normalizada
   * @param {number} o.velocidade unidades por segundo
   * @param {number} o.dano pontos
   * @param {number} [o.alcance] unidades antes de expirar
   * @param {number|THREE.Color} [o.cor]
   * @param {any} [o.dono] quem atirou (não leva o próprio tiro)
   * @param {string} [o.tipo]
   * @param {object} [o.explosao] `{ raio, dano, cratera }` para a granada
   * @param {THREE.Vector3} [o.velocidadeBase] velocidade da plataforma que atirou
   */
  disparar({
    origem,
    direcao,
    velocidade = 190,
    dano = 12,
    alcance = 420,
    cor = 0x8ef0ff,
    dono = null,
    tipo = 'bolt',
    explosao = null,
    velocidadeBase = null,
  }) {
    const t = this._livre();

    t.pos.copy(origem);
    t.vel.copy(direcao).multiplyScalar(velocidade);
    // ---------------------------------------------------------------------
    // A VELOCIDADE DA PLATAFORMA ENTRA NA DO TIRO.
    //
    // Sem isto, atirar voando a 200 u/s produz um tiro que anda para trás em
    // relação à nave — o jogador vê o próprio disparo ficando para trás e o
    // atravessando. É o mesmo motivo pelo qual uma bala disparada de um avião
    // não fica parada no ar.
    // ---------------------------------------------------------------------
    if (velocidadeBase) t.vel.add(velocidadeBase);

    t.cor.set(cor);
    t.dano = dano;
    t.dono = dono;
    t.tipo = tipo;
    t.explosao = explosao;
    // O alcance vira TEMPO aqui, uma divisão só, em vez de guardar o ponto de
    // partida e medir distância a cada quadro.
    t.vida = alcance / Math.max(1, t.vel.length());
    t.vivo = true;
    return t;
  }

  /** Próximo espaço livre, reciclando o mais antigo se o pool estourar. */
  _livre() {
    for (let i = 0; i < MAXIMO; i++) {
      const idx = (this._proximo + i) % MAXIMO;
      if (!this.tiros[idx].vivo) {
        this._proximo = (idx + 1) % MAXIMO;
        return this.tiros[idx];
      }
    }
    const idx = this._proximo;
    this._proximo = (idx + 1) % MAXIMO;
    return this.tiros[idx];
  }

  /**
   * Integra, testa colisão e desenha.
   *
   * @param {number} dt
   * @param {import('../world/Planet.js').Planet} planeta
   * @param {Array<{posicao: THREE.Vector3, raio: number, vitais: object, dono?: any}>} alvos
   *   alvos em espaço de CENA, montados por quem chama
   */
  atualizar(dt, planeta, alvos = []) {
    // Subdivide passos grandes: ver `PASSO_MAXIMO`.
    let restante = Math.min(dt, 0.25);
    while (restante > 0) {
      const passo = Math.min(restante, PASSO_MAXIMO);
      this._integrar(passo, planeta, alvos);
      restante -= passo;
    }
    this._escrever();
  }

  _integrar(dt, planeta, alvos) {
    for (const t of this.tiros) {
      if (!t.vivo) continue;

      t.vida -= dt;
      if (t.vida <= 0) {
        // Expirar não é impacto: a granada que acaba o alcance no ar explode,
        // o traçante simplesmente some. Sem esta distinção, uma granada
        // disparada para o céu abriria uma cratera no nada.
        if (t.tipo === 'granada') this._impacto(t, t.pos, null, planeta);
        else t.vivo = false;
        continue;
      }

      _prox.copy(t.pos).addScaledVector(t.vel, dt);

      // --- Alvos ---------------------------------------------------------
      // Teste de segmento contra esfera, e não de ponto: mesmo com o passo
      // subdividido, um tiro rápido contra um alvo pequeno passa entre dois
      // pontos amostrados. O custo é o mesmo de um produto escalar.
      let atingido = null;
      for (const alvo of alvos) {
        if (alvo.dono === t.dono) continue;
        if (!alvo.vitais?.vivo) continue;
        if (this._cruzaEsfera(t.pos, _prox, alvo.posicao, alvo.raio + 0.25)) {
          atingido = alvo;
          break;
        }
      }
      if (atingido) {
        this._impacto(t, _prox, atingido, planeta);
        continue;
      }

      // --- Terreno -------------------------------------------------------
      // Pelo amostrador analítico, não pela malha: ele responde igual onde o
      // chunk ainda não chegou, e é o mesmo critério que a colisão do jogador
      // usa. Testar contra a malha faria o tiro atravessar terreno que o
      // jogador vê, nos poucos quadros após um salto.
      _mundo.copy(_prox);
      if (planeta && planeta.sampleAt(_mundo).altitude <= 0) {
        this._impacto(t, _prox, null, planeta);
        continue;
      }

      t.pos.copy(_prox);
    }
  }

  /** O segmento a→b chega a menos de `raio` do centro `c`? */
  _cruzaEsfera(a, b, c, raio) {
    _dir.copy(b).sub(a);
    const comprimento2 = _dir.lengthSq();
    _alvo.copy(c).sub(a);
    // Projeção do centro no segmento, presa às pontas: sem o clamp, um alvo
    // atrás do atirador daria acerto.
    const t = comprimento2 > 1e-9
      ? THREE.MathUtils.clamp(_alvo.dot(_dir) / comprimento2, 0, 1)
      : 0;
    _dir.multiplyScalar(t).add(a);
    return _dir.distanceToSquared(c) <= raio * raio;
  }

  _impacto(t, ponto, alvo, planeta) {
    t.vivo = false;

    const info = {
      ponto: _pos.copy(ponto).clone(),
      tipo: t.tipo,
      cor: t.cor.getHex(),
      dono: t.dono,
      alvo,
      dano: 0,
      explodiu: false,
    };

    if (t.explosao) {
      info.explodiu = true;
      info.explosao = t.explosao;
    } else if (alvo) {
      // O detalhe do golpe é repassado inteiro: quem desenha o efeito precisa
      // saber se bateu no escudo ou na blindagem para escolher entre faísca
      // azul e fagulha — e essa informação só existe dentro de `Vitais`.
      const golpe = alvo.vitais.aplicarDano(t.dano, t.dono);
      info.dano = golpe.escudo + golpe.vida;
      info.noEscudo = golpe.escudo > 0 && golpe.vida === 0;
      info.morreu = golpe.letal;
    }

    this.aoImpactar?.(info);
  }

  /** Reescreve as matrizes das instâncias vivas. */
  _escrever() {
    let n = 0;
    for (const t of this.tiros) {
      if (!t.vivo) continue;

      // A cápsula nasce no eixo Y; girá-la para o vetor velocidade é o que faz
      // o traçante apontar para onde vai em vez de ficar deitado.
      _dir.copy(t.vel).normalize();
      _quat.setFromUnitVectors(_eixo, _dir);
      // Esticada na direção do voo: um risco curto lido a 190 u/s some entre
      // dois quadros. Alongar é o *motion blur* do pobre, e é o que dá a
      // sensação de velocidade.
      _escala.set(1, t.tipo === 'granada' ? 1.4 : 2.6, 1);
      _matriz.compose(t.pos, _quat, _escala);
      this.malha.setMatrixAt(n, _matriz);
      this.malha.setColorAt(n, _cor.copy(t.cor));
      n++;
    }

    // As instâncias além de `count` não são desenhadas, mas o three ainda lê a
    // matriz da última escrita — deixar lixo ali produz um risco parado no
    // horizonte quando o contador sobe de novo.
    if (n < this.malha.count) {
      _matriz.compose(LONGE, _quat, _escala.set(0, 0, 0));
      for (let i = n; i < this.malha.count; i++) this.malha.setMatrixAt(i, _matriz);
    }

    this.malha.count = n;
    this.malha.instanceMatrix.needsUpdate = true;
    if (this.malha.instanceColor) this.malha.instanceColor.needsUpdate = true;
  }

  /**
   * Reage ao rebase da origem flutuante.
   *
   * Sem isto, cada recentragem lançaria todos os tiros vivos a milhares de
   * unidades — e como o rebase acontece justamente ao voar rápido, seria no
   * combate de naves que apareceria.
   *
   * @param {THREE.Vector3} delta
   */
  deslocar(delta) {
    for (const t of this.tiros) if (t.vivo) t.pos.sub(delta);
  }

  /** Apaga tudo (salto interestelar, morte, troca de sistema). */
  limpar() {
    for (const t of this.tiros) t.vivo = false;
    this._escrever();
  }

  dispose() {
    this.malha.geometry.dispose();
    this.malha.material.dispose();
    this.malha.removeFromParent();
  }
}
