/**
 * Deformações permanentes do terreno.
 *
 * ===========================================================================
 * O CONFLITO CENTRAL
 * ===========================================================================
 * O planeta inteiro é uma FUNÇÃO PURA do seed — é isso que permite dois
 * jogadores em máquinas diferentes verem a mesma montanha sem trocar um byte de
 * terreno. Cavar um buraco quebra essa pureza por definição: passa a existir
 * estado que não deriva do seed.
 *
 * A saída é não misturar as duas coisas. O ruído continua puro e intocado; as
 * escavações vivem numa CAMADA SEPARADA que se soma por cima:
 *
 *     altura final = ruído(direção)  +  edições(direção)
 *
 * Assim o que trafega pela rede e vai para o banco é só a lista de edições — a
 * mesma ideia que faz os props colhidos caberem numa tabela de quatro colunas.
 * E a camada é compartilhada entre a main thread (colisão, altitude) e o worker
 * (malha), pelo mesmo motivo de sempre: se as duas discordarem, o jogador cai
 * dentro do chão que está vendo.
 *
 * ===========================================================================
 * POR QUE NÃO É UM VOXEL GRID
 * ===========================================================================
 * Escavação de verdade (túneis, cavernas, saliências) exige campo de densidade
 * em 3D e poligonização por marching cubes. Aqui o terreno é um HEIGHTMAP sobre
 * a esfera, e a deformação é do mesmo tipo: um deslocamento radial. Dá para
 * abrir crateras e aplainar platôs, não para cavar por baixo. É a limitação
 * honesta desta representação, e trocá-la seria reescrever o worker inteiro.
 */

/** Tipos de edição. Viajam como inteiro para o pacote ficar pequeno. */
export const EDICAO = {
  /** Soma `f` no pico e decai suavemente até a borda. Cavar e levantar. */
  SOMAR: 0,
  /** Puxa a elevação para `f` num platô. É o que assenta uma base no terreno. */
  NIVELAR: 1,
};

/**
 * Peso de uma edição a uma distância do centro.
 *
 * As duas curvas são diferentes de propósito:
 *
 *   SOMAR usa um domo `(1-q²)²` — derivada zero no centro E na borda, então a
 *   cratera não tem bico no meio nem degrau na beirada.
 *
 *   NIVELAR usa um platô — peso 1 até 55% do raio e só então cai. Um domo aqui
 *   deixaria o centro plano e as bordas em rampa, e a base assentaria numa
 *   tigela em vez de num terraço.
 */
function peso(q, tipo) {
  if (q >= 1) return 0;
  if (tipo === EDICAO.NIVELAR) {
    if (q <= 0.55) return 1;
    const t = (q - 0.55) / 0.45;
    return 1 - t * t * (3 - 2 * t);
  }
  const s = 1 - q * q;
  return s * s;
}

export class CampoDeEdicoes {
  /** @param {number} raioDoPlaneta usado para converter ângulo em distância */
  constructor(raioDoPlaneta) {
    this.raioDoPlaneta = raioDoPlaneta;
    /**
     * Edições por id.
     *
     * `Map` e não array porque uma edição pode ser ATUALIZADA: o platô de uma
     * base cresce conforme o jogador constrói, e reemitir uma edição nova a
     * cada peça encheria o banco de discos concêntricos.
     * @type {Map<string, {x:number,y:number,z:number,r:number,f:number,t:number}>}
     */
    this.porId = new Map();
    /** Mesma coisa em array, para iterar sem alocar iterador por vértice. */
    this.lista = [];
    /** Sobe a cada mudança — quem cacheia terreno compara contra isto. */
    this.versao = 0;
  }

  get tamanho() {
    return this.lista.length;
  }

  /** Substitui tudo (usado ao restaurar do banco). */
  definir(edicoes) {
    this.porId.clear();
    for (const e of edicoes) this.porId.set(e.id, e);
    this._reindexar();
  }

  /** Insere ou atualiza. @returns {boolean} houve mudança de fato */
  aplicar(edicao) {
    const antiga = this.porId.get(edicao.id);
    if (
      antiga &&
      antiga.x === edicao.x && antiga.y === edicao.y && antiga.z === edicao.z &&
      antiga.r === edicao.r && antiga.f === edicao.f && antiga.t === edicao.t
    ) {
      return false;
    }
    this.porId.set(edicao.id, edicao);
    this._reindexar();
    return true;
  }

  remover(id) {
    if (!this.porId.delete(id)) return false;
    this._reindexar();
    return true;
  }

  _reindexar() {
    // -----------------------------------------------------------------------
    // NIVELAR SEMPRE ANTES DE SOMAR.
    //
    // A ordem não é detalhe: `NIVELAR` com peso 1 ATRIBUI a altura, e portanto
    // apaga tudo que foi somado antes dela. Em ordem de inserção, cavar um
    // buraco dentro do platô de uma base funcionava até a base crescer — aí o
    // platô era reemitido, passava a vir depois na lista e o buraco sumia sem
    // que nada tivesse acontecido com ele. Foi assim que o defeito apareceu:
    // uma escavação de 8,6 unidades medida como zero.
    //
    // Com a separação, a leitura fica a que se espera de um terreno: primeiro
    // se terraplena, depois se cava — e cavar sobre o piso de uma base faz o
    // que qualquer pessoa acha que vai fazer.
    //
    // `sort` é estável desde o ES2019, então a ordem de inserção sobrevive
    // dentro de cada grupo — o que mantém o resultado igual em todas as
    // máquinas, que é o requisito real aqui.
    // -----------------------------------------------------------------------
    // `NIVELAR` é 1 e `SOMAR` é 0, daí a subtração invertida.
    this.lista = [...this.porId.values()].sort((a, b) => b.t - a.t);
    // Pré-calcula o cosseno do raio angular de cada edição. É o que transforma
    // o teste "esta edição alcança este ponto?" em um produto escalar, sem
    // raiz quadrada nem trigonometria dentro do laço de vértices.
    for (const e of this.lista) {
      const anguloR = e.r / this.raioDoPlaneta;
      e._cos = Math.cos(Math.min(Math.PI, anguloR));
      e._invR = 1 / e.r;
    }
    this.versao++;
  }

  /**
   * Altura corrigida num ponto da esfera.
   *
   * @param {number} x direção UNITÁRIA
   * @param {number} altura elevação vinda do ruído
   */
  alturaEm(x, y, z, altura) {
    const lista = this.lista;
    for (let i = 0; i < lista.length; i++) {
      const e = lista[i];

      // Rejeição barata primeiro: se o ponto está fora do cone da edição, nada
      // a fazer. É o teste que roda milhões de vezes por chunk.
      const cos = x * e.x + y * e.y + z * e.z;
      if (cos <= e._cos) continue;

      // Distância de corda × raio ≈ arco, e o erro em ângulos pequenos (que é
      // o caso de qualquer edição feita à mão) fica abaixo de 0,1%.
      const dx = x - e.x, dy = y - e.y, dz = z - e.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) * this.raioDoPlaneta;

      const w = peso(dist * e._invR, e.t);
      if (w <= 0) continue;

      if (e.t === EDICAO.NIVELAR) altura += (e.f - altura) * w;
      else altura += e.f * w;
    }
    return altura;
  }

  /**
   * Quanto este ponto foi MEXIDO por mão humana, em [0,1].
   *
   * Serve à cor do terreno, não à altura. A regra "encosta íngreme mostra rocha
   * exposta" é boa para relevo natural e péssima para uma vala: o declive de um
   * buraco recém-cavado satura o medidor, e o interior inteiro era pintado com
   * a paleta de rocha — num mundo glacial, isso significa passar de areia quase
   * branca (228,239,255) para quase preto (7,5,4) em dois metros, com borda
   * dura. Era exatamente o "glitch de textura" relatado.
   *
   * Terra remexida é o MESMO material de antes, solto; não é leito rochoso
   * aflorando. Com esta intensidade, `colorAt` amolece o declive que usa para
   * escolher a cor — e só para isso, nunca para a geometria.
   */
  intensidadeEm(x, y, z) {
    let maior = 0;
    const lista = this.lista;
    for (let i = 0; i < lista.length; i++) {
      const e = lista[i];
      const cos = x * e.x + y * e.y + z * e.z;
      if (cos <= e._cos) continue;
      const dx = x - e.x, dy = y - e.y, dz = z - e.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) * this.raioDoPlaneta;

      // -------------------------------------------------------------------
      // MÁSCARA DE "FOI MEXIDO", NÃO O PESO DO DESLOCAMENTO.
      //
      // Usar o peso da própria edição parece natural e falha no lugar exato
      // onde importa: no domo do `SOMAR`, o peso é MÍNIMO na borda — e a borda
      // é justamente onde a parede do buraco fica mais íngreme. O resultado
      // media 7,5,5 (preto) no anel do meio da cratera enquanto o fundo já
      // estava certo.
      //
      // A curva de platô responde a outra pergunta — "esta terra foi
      // revolvida?" — e responde 'sim' em quase todo o raio. É a pergunta
      // certa para escolher cor.
      //
      // O fator 1,3 estende a máscara além do raio da edição: a escavação
      // levanta o declive um pouco depois de onde ela para de mexer na altura,
      // e sem a folga sobrava um anel escuro contornando o buraco.
      // -------------------------------------------------------------------
      const w = peso(dist * e._invR * (1 / 1.3), EDICAO.NIVELAR);
      if (w > maior) maior = w;
      if (maior >= 1) return 1;
    }
    return maior;
  }

  /**
   * Sublista das edições que podem tocar uma calota.
   *
   * Chamado UMA vez por chunk, no worker, e o resultado alimenta o laço de
   * milhares de vértices. Sem este filtro, cada vértice pagaria um produto
   * escalar por edição do planeta inteiro — o custo cresceria com o quanto o
   * mundo já foi escavado, que é exatamente a direção errada.
   *
   * @param {number[]} dirCentro direção unitária do centro da calota
   * @param {number} raioAngular abertura da calota, em radianos
   */
  paraRegiao(dirCentro, raioAngular) {
    const recorte = new CampoDeEdicoes(this.raioDoPlaneta);
    const cosLimite = Math.cos(Math.min(Math.PI, raioAngular));

    for (const e of this.lista) {
      const cos = dirCentro[0] * e.x + dirCentro[1] * e.y + dirCentro[2] * e.z;
      // Soma dos raios angulares: cos(a+b) = cos a cos b − sin a sin b. Como só
      // precisamos de um limite conservador, usar o produto dos cossenos menos
      // o produto dos senos é exato e não custa mais que uma raiz.
      const senoA = Math.sqrt(Math.max(0, 1 - cosLimite * cosLimite));
      const senoB = Math.sqrt(Math.max(0, 1 - e._cos * e._cos));
      if (cos <= cosLimite * e._cos - senoA * senoB) continue;
      recorte.porId.set(e.id, e);
    }

    recorte._reindexar();
    return recorte;
  }

  /** Serializável, para a rede e para o banco. */
  paraLista() {
    return this.lista.map((e) => ({ id: e.id, x: e.x, y: e.y, z: e.z, r: e.r, f: e.f, t: e.t }));
  }
}

/** Um campo vazio compartilhado — evita alocar um por planeta sem edições. */
export const CAMPO_VAZIO = new CampoDeEdicoes(1);
