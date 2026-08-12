/**
 * Inventário por slots com empilhamento, no modelo do gênero.
 *
 * O limite não é o total de recursos e sim o número de SLOTS: cada recurso
 * ocupa um slot que comporta até `stackSize`. É o que transforma coletar em
 * uma decisão ("vale a pena pegar mais ferrite ou guardar espaço?") em vez de
 * um contador que só cresce.
 */

import { RESOURCES } from '../shared/props.js';

const BY_ID = new Map(RESOURCES.map((r) => [r.id, r]));

export class Inventory {
  /**
   * @param {number} slots
   * @param {number} stackSize
   */
  constructor(slots = 8, stackSize = 250) {
    this.slots = slots;
    this.stackSize = stackSize;
    /** @type {Map<string, number>} recurso -> quantidade total */
    this.items = new Map();
    this.units = 0;
  }

  /** Slots ocupados (um recurso pode ocupar mais de um). */
  get slotsUsed() {
    let used = 0;
    for (const amount of this.items.values()) used += Math.ceil(amount / this.stackSize);
    return used;
  }

  get isFull() {
    return this.slotsUsed >= this.slots;
  }

  count(resourceId) {
    return this.items.get(resourceId) ?? 0;
  }

  /**
   * @returns {number} quanto foi realmente adicionado (pode ser menos que o
   *   pedido, ou zero, se não houver espaço)
   */
  add(resourceId, amount) {
    if (amount <= 0) return 0;

    const current = this.count(resourceId);
    const usedByOthers = this.slotsUsed - Math.ceil(current / this.stackSize);
    const freeSlots = this.slots - usedByOthers;
    if (freeSlots <= 0) return 0;

    const capacity = freeSlots * this.stackSize;
    const added = Math.min(amount, capacity - current);
    if (added <= 0) return 0;

    this.items.set(resourceId, current + added);
    return added;
  }

  remove(resourceId, amount) {
    const current = this.count(resourceId);
    const removed = Math.min(current, amount);
    if (removed <= 0) return 0;
    if (current - removed === 0) this.items.delete(resourceId);
    else this.items.set(resourceId, current - removed);
    return removed;
  }

  /** Vende tudo de um recurso pelo valor de mercado. */
  sell(resourceId) {
    const amount = this.count(resourceId);
    if (amount <= 0) return 0;
    const resource = BY_ID.get(resourceId);
    const earned = Math.round(amount * (resource?.valor ?? 1));
    this.remove(resourceId, amount);
    this.units += earned;
    return earned;
  }

  /** Lista pronta para o HUD, ordenada por quantidade. */
  entries() {
    const out = [];
    for (const [id, amount] of this.items) {
      const resource = BY_ID.get(id);
      out.push({
        id,
        nome: resource?.nome ?? id,
        cor: resource?.cor ?? 0xffffff,
        amount,
        stacks: Math.ceil(amount / this.stackSize),
      });
    }
    return out.sort((a, b) => b.amount - a.amount);
  }
}
