/**
 * Catálogo de descobertas: planetas e espécies.
 *
 * É o que dá propósito a explorar um mundo procedural. A geração já produz
 * variedade infinita; sem um registro, essa variedade não vira nada — o
 * jogador não tem como perceber que aquele arbusto é diferente do anterior.
 *
 * Todos os nomes derivam do seed, então a mesma espécie no mesmo planeta tem
 * sempre o mesmo nome, em qualquer máquina e em qualquer sessão.
 */

import { mulberry32 } from '../shared/noise.js';
import { PROP_TYPE } from '../shared/props.js';

const GENUS = ['Aster', 'Bryo', 'Crypt', 'Dendro', 'Echin', 'Ferro', 'Gala', 'Helio', 'Ixo', 'Lith', 'Myco', 'Noct', 'Ophio', 'Pyro', 'Rhiz', 'Stell', 'Therm', 'Xantho'];
const GENUS_TAIL = ['phyta', 'derma', 'poda', 'morpha', 'spora', 'nema', 'cera', 'flora'];
const EPITHET = ['borealis', 'ferox', 'gracilis', 'immensa', 'lucida', 'nocturna', 'petrea', 'rubra', 'sagitta', 'tenuis', 'vitrea', 'zephyra'];

const CATEGORY = {
  [PROP_TYPE.BUSH]: 'Flora menor',
  [PROP_TYPE.TREE]: 'Flora maior',
  [PROP_TYPE.ROCK]: 'Formação mineral',
  [PROP_TYPE.DEPOSIT]: 'Depósito',
};

/** Recompensa em unidades por tipo de descoberta. */
const REWARD = {
  planeta: 3500,
  [PROP_TYPE.BUSH]: 320,
  [PROP_TYPE.TREE]: 480,
  [PROP_TYPE.ROCK]: 260,
  [PROP_TYPE.DEPOSIT]: 900,
  /**
   * Fauna paga mais que qualquer flora e perde só para o planeta.
   * A flora está espalhada por todo lado e é catalogada no primeiro pulso;
   * uma criatura precisa estar viva por perto no momento da varredura, o que
   * significa ter descido, andado e chegado perto o bastante. O prêmio
   * acompanha o esforço.
   */
  fauna: 1400,
};

function speciesName(seed) {
  const rand = mulberry32(seed);
  const pick = (arr) => arr[(rand() * arr.length) | 0];
  return `${pick(GENUS)}${pick(GENUS_TAIL)} ${pick(EPITHET)}`;
}

export class Discovery {
  constructor() {
    /** @type {Set<string>} chaves já descobertas */
    this.known = new Set();
    /** @type {Array<{titulo:string, subtitulo:string, unidades:number}>} */
    this.log = [];
  }

  /** Estado serializável (um `Set` também não sobrevive ao JSON). */
  toJSON() {
    return { conhecidas: [...this.known] };
  }

  restaurar(dados) {
    if (!dados) return;
    this.known = new Set(Array.isArray(dados.conhecidas) ? dados.conhecidas : []);
  }

  get count() {
    return this.known.size;
  }

  /**
   * Registra o planeta em si. Vale a maior recompensa: é a descoberta que
   * exige de fato ter viajado até lá.
   * @returns {{novo:boolean, nome:string, unidades:number}}
   */
  registerPlanet(planet) {
    const key = `planeta:${planet.config.seed}`;
    const nome = planet.name;
    if (this.known.has(key)) return { novo: false, nome, unidades: 0 };

    this.known.add(key);
    const unidades = REWARD.planeta;
    this.log.push({ titulo: nome, subtitulo: `Planeta ${planet.config.type}`, unidades });
    return { novo: true, nome, unidades };
  }

  /**
   * Registra uma espécie de um tipo de prop naquele planeta.
   * @returns {{novo:boolean, nome:string, categoria:string, unidades:number}}
   */
  registerSpecies(planet, propType) {
    const key = `especie:${planet.config.seed}:${propType}`;
    const nome = speciesName((planet.config.seed * 31 + propType * 7717) >>> 0);
    const categoria = CATEGORY[propType] ?? 'Desconhecido';

    if (this.known.has(key)) return { novo: false, nome, categoria, unidades: 0 };

    this.known.add(key);
    const unidades = REWARD[propType] ?? 200;
    this.log.push({ titulo: nome, subtitulo: `${categoria} · ${planet.name}`, unidades });
    return { novo: true, nome, categoria, unidades };
  }

  /**
   * Registra uma espécie de fauna daquele planeta.
   *
   * A chave usa o ÍNDICE da espécie dentro do planeta, e não o modelo: o mesmo
   * `animal-fox.glb` aparece em mundos diferentes com matiz, porte e nome
   * próprios, e catalogar um não pode catalogar os outros.
   *
   * @param {object} planet
   * @param {number} index posição em `planet.fauna.species`
   * @param {string} tipo rótulo da espécie ('predador', 'alado'…)
   * @returns {{novo:boolean, nome:string, categoria:string, unidades:number}}
   */
  registerFauna(planet, index, tipo) {
    const key = `fauna:${planet.config.seed}:${index}`;
    const nome = speciesName((planet.config.seed * 131 + index * 4409 + 0x9e37) >>> 0);
    const categoria = tipo ? `Fauna · ${tipo}` : 'Fauna';

    if (this.known.has(key)) return { novo: false, nome, categoria, unidades: 0 };

    this.known.add(key);
    const unidades = REWARD.fauna;
    this.log.push({ titulo: nome, subtitulo: `${categoria} · ${planet.name}`, unidades });
    return { novo: true, nome, categoria, unidades };
  }

  /** Já conhecemos este planeta? (para o HUD indicar "não catalogado") */
  hasPlanet(planet) {
    return this.known.has(`planeta:${planet.config.seed}`);
  }
}
