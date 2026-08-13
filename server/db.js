/**
 * Persistência em MySQL/MariaDB.
 *
 * ---------------------------------------------------------------------------
 * O JOGO CONTINUA SEM BANCO
 * ---------------------------------------------------------------------------
 * Toda função aqui degrada em silêncio quando não há conexão: `disponivel` vira
 * `false` e a sala volta a ser exatamente o que era antes — memória volátil,
 * sem contas. Isso não é preciosismo defensivo; é o que permite abrir o projeto
 * numa máquina sem MySQL e ainda assim jogar em rede, que é como a maioria das
 * pessoas vai encostar nele pela primeira vez.
 *
 * ---------------------------------------------------------------------------
 * SENHAS
 * ---------------------------------------------------------------------------
 * `scrypt`, do próprio Node. É deliberadamente lento e usa memória de propósito
 * — um ataque de força bruta paga o mesmo custo por tentativa. Guardar hash
 * rápido (MD5, SHA) seria pior que guardar em texto puro, porque dá uma falsa
 * sensação de proteção.
 *
 * A comparação usa `timingSafeEqual`: comparar com `===` vaza, pelo TEMPO da
 * resposta, quantos caracteres iniciais estavam certos.
 */

import mysql from 'mysql2/promise';
import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

/** Comprimento do hash em bytes. 64 é o padrão recomendado para scrypt. */
const TAMANHO_HASH = 64;

export class Banco {
  constructor(config = {}) {
    this.config = {
      host: config.host ?? process.env.DB_HOST ?? 'localhost',
      port: Number(config.port ?? process.env.DB_PORT ?? 3306),
      user: config.user ?? process.env.DB_USER ?? 'odyssey',
      password: config.password ?? process.env.DB_PASSWORD ?? 'odyssey',
      database: config.database ?? process.env.DB_NAME ?? 'odyssey',
    };
    this.pool = null;
    this.disponivel = false;
  }

  async conectar() {
    try {
      this.pool = mysql.createPool({
        ...this.config,
        waitForConnections: true,
        connectionLimit: 8,
        // O servidor de sala é o único cliente e faz consultas curtas; uma fila
        // sem limite só esconderia um problema de carga atrás de latência.
        queueLimit: 32,
      });
      await this.pool.query('SELECT 1');
      this.disponivel = true;
      console.log(`[db] conectado em ${this.config.user}@${this.config.host}:${this.config.port}/${this.config.database}`);
    } catch (erro) {
      this.disponivel = false;
      console.warn(`[db] sem persistência (${erro.code ?? erro.message}) — a sala roda em memória`);
    }
    return this.disponivel;
  }

  /* ===================================================================== */
  /* Contas                                                                */
  /* ===================================================================== */

  async _hash(senha) {
    const sal = randomBytes(16);
    const derivado = await scryptAsync(senha, sal, TAMANHO_HASH);
    return `${sal.toString('hex')}:${derivado.toString('hex')}`;
  }

  async _confere(senha, guardado) {
    const [salHex, hashHex] = String(guardado).split(':');
    if (!salHex || !hashHex) return false;
    const derivado = await scryptAsync(senha, Buffer.from(salHex, 'hex'), TAMANHO_HASH);
    const esperado = Buffer.from(hashHex, 'hex');
    if (esperado.length !== derivado.length) return false;
    return timingSafeEqual(esperado, derivado);
  }

  /**
   * Entra ou cria a conta.
   *
   * Registro implícito: se o login não existe, ele nasce. Numa PoC, uma tela a
   * mais para escolher entre "entrar" e "criar conta" é atrito puro — e o erro
   * que ela evita (typo no login virando conta nova) é reversível.
   *
   * @returns {{ok:true, id:number, novo:boolean} | {ok:false, erro:string}}
   */
  async autenticar(login, senha) {
    if (!this.disponivel) return { ok: false, erro: 'sem banco' };

    const [linhas] = await this.pool.query('SELECT id, senha FROM conta WHERE login = ?', [login]);

    if (linhas.length === 0) {
      const hash = await this._hash(senha);
      try {
        const [r] = await this.pool.query('INSERT INTO conta (login, senha) VALUES (?, ?)', [login, hash]);
        return { ok: true, id: r.insertId, novo: true };
      } catch (erro) {
        // Corrida: duas abas criando o mesmo login ao mesmo tempo. A segunda
        // cai aqui e simplesmente tenta entrar, que é o resultado esperado.
        if (erro.code === 'ER_DUP_ENTRY') return this.autenticar(login, senha);
        throw erro;
      }
    }

    const conta = linhas[0];
    if (!(await this._confere(senha, conta.senha))) return { ok: false, erro: 'senha incorreta' };

    await this.pool.query('UPDATE conta SET ultimo_acesso = NOW() WHERE id = ?', [conta.id]);
    return { ok: true, id: conta.id, novo: false };
  }

  /* ===================================================================== */
  /* Progresso                                                             */
  /* ===================================================================== */

  async carregarProgresso(contaId, seed) {
    if (!this.disponivel) return null;
    const [linhas] = await this.pool.query(
      'SELECT unidades, inventario, descobertas, posicao FROM progresso WHERE conta_id = ? AND seed = ?',
      [contaId, seed]
    );
    if (linhas.length === 0) return null;

    const linha = linhas[0];
    // O driver devolve JSON já convertido em algumas versões e string em
    // outras — normalizar aqui evita um `JSON.parse` de objeto lá na frente.
    const comoObjeto = (valor) =>
      valor == null ? null : typeof valor === 'string' ? JSON.parse(valor) : valor;

    return {
      unidades: linha.unidades,
      inventario: comoObjeto(linha.inventario),
      descobertas: comoObjeto(linha.descobertas),
      posicao: comoObjeto(linha.posicao),
    };
  }

  async salvarProgresso(contaId, seed, progresso) {
    if (!this.disponivel) return;
    await this.pool.query(
      `INSERT INTO progresso (conta_id, seed, unidades, inventario, descobertas, posicao)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         unidades = VALUES(unidades),
         inventario = VALUES(inventario),
         descobertas = VALUES(descobertas),
         -- COALESCE e não VALUES(): um cliente que salve sem posição (a foto
         -- falha se o planeta ativo ainda não existe no boot) não pode apagar
         -- o ponto onde a pessoa parou na sessão anterior.
         posicao = COALESCE(VALUES(posicao), posicao)`,
      [
        contaId,
        seed,
        progresso.unidades ?? 0,
        JSON.stringify(progresso.inventario ?? []),
        JSON.stringify(progresso.descobertas ?? {}),
        progresso.posicao ? JSON.stringify(progresso.posicao) : null,
      ]
    );
  }

  /* ===================================================================== */
  /* Props colhidos                                                        */
  /* ===================================================================== */

  /** Tudo o que já foi colhido neste universo, no formato da sala. */
  async carregarColhidos(seed) {
    if (!this.disponivel) return new Map();
    const [linhas] = await this.pool.query(
      'SELECT planeta, chunk, indice FROM colhido WHERE seed = ?',
      [seed]
    );

    const mapa = new Map();
    for (const linha of linhas) {
      const chave = `${linha.planeta}:${linha.chunk}`;
      let indices = mapa.get(chave);
      if (!indices) mapa.set(chave, (indices = new Set()));
      indices.add(linha.indice);
    }
    return mapa;
  }

  /**
   * Grava uma colheita.
   *
   * `INSERT IGNORE` porque a chave primária já garante unicidade: dois
   * jogadores mirando o mesmo arbusto no mesmo instante geram duas gravações, e
   * a segunda simplesmente não faz nada. Verificar antes seria uma consulta a
   * mais para chegar na mesma garantia que o banco já dá.
   */
  async registrarColheita(seed, planeta, chunk, indice) {
    if (!this.disponivel) return;
    await this.pool.query(
      'INSERT IGNORE INTO colhido (seed, planeta, chunk, indice) VALUES (?, ?, ?, ?)',
      [seed, planeta, chunk, indice]
    );
  }

  /* ===================================================================== */
  /* Bases construídas                                                     */
  /* ===================================================================== */

  /** Todas as peças de um universo, já no formato de evento que o cliente usa. */
  async carregarConstrucoes(seed) {
    if (!this.disponivel) return [];
    const [linhas] = await this.pool.query(
      'SELECT base, cx, cy, cz, face, planeta, peca, giro, frame FROM construcao WHERE seed = ?',
      [seed]
    );

    return linhas.map((l) => ({
      tipo: 'construir',
      planeta: l.planeta,
      base: l.base,
      frame: typeof l.frame === 'string' ? JSON.parse(l.frame) : l.frame,
      cel: [l.cx, l.cy, l.cz],
      face: l.face,
      peca: l.peca,
      giro: l.giro,
    }));
  }

  async gravarConstrucao(seed, evento, frame) {
    if (!this.disponivel) return;
    await this.pool.query(
      `INSERT INTO construcao (seed, base, cx, cy, cz, face, planeta, peca, giro, frame)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE peca = VALUES(peca), giro = VALUES(giro)`,
      [
        seed,
        evento.base,
        evento.cel[0],
        evento.cel[1],
        evento.cel[2],
        evento.face,
        evento.planeta,
        evento.peca,
        evento.giro ?? 0,
        JSON.stringify(frame ?? evento.frame ?? null),
      ]
    );
  }

  async removerConstrucao(seed, base, cel, face) {
    if (!this.disponivel) return;
    await this.pool.query(
      'DELETE FROM construcao WHERE seed = ? AND base = ? AND cx = ? AND cy = ? AND cz = ? AND face = ?',
      [seed, base, cel[0], cel[1], cel[2], face]
    );
  }

  /* ===================================================================== */
  /* Terreno escavado                                                      */
  /* ===================================================================== */

  async carregarTerreno(seed) {
    if (!this.disponivel) return [];
    const [linhas] = await this.pool.query(
      'SELECT planeta, id, x, y, z, r, f, t FROM terreno WHERE seed = ? ORDER BY planeta, id',
      [seed]
    );
    return linhas.map((l) => ({
      planeta: l.planeta,
      id: l.id,
      // Os números voltam como string em colunas DECIMAL de algumas versões do
      // driver; `Number` normaliza sem custo perceptível numa carga de boot.
      dados: { id: l.id, x: Number(l.x), y: Number(l.y), z: Number(l.z), r: Number(l.r), f: Number(l.f), t: l.t },
    }));
  }

  /**
   * Grava (ou aprofunda) uma escavação.
   *
   * `ON DUPLICATE KEY UPDATE` é o ponto todo: enquanto o jogador segura o
   * botão, a MESMA edição chega dezenas de vezes com `f` crescendo. Inserir
   * cada uma criaria uma pilha de crateras concêntricas no lugar de um buraco.
   */
  async gravarTerreno(seed, planeta, e) {
    if (!this.disponivel) return;
    await this.pool.query(
      `INSERT INTO terreno (seed, planeta, id, x, y, z, r, f, t)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         x = VALUES(x), y = VALUES(y), z = VALUES(z),
         r = VALUES(r), f = VALUES(f), t = VALUES(t)`,
      [seed, planeta, e.id, e.x, e.y, e.z, e.r, e.f, e.t]
    );
  }

  /** Descarta escavações que estouraram o orçamento do planeta. */
  async removerTerreno(seed, planeta, ids) {
    if (!this.disponivel || ids.length === 0) return;
    const marcadores = ids.map(() => '?').join(',');
    await this.pool.query(
      `DELETE FROM terreno WHERE seed = ? AND planeta = ? AND id IN (${marcadores})`,
      [seed, planeta, ...ids]
    );
  }

  async encerrar() {
    await this.pool?.end();
    this.disponivel = false;
  }
}
