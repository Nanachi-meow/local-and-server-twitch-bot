/** Кольцевые логи в памяти: панель забирает дельты по id. */
export class RingLog {
  constructor(cap = 300) {
    this.cap = cap;
    this.items = [];
    this.counter = 0;
  }

  push(entry) {
    this.counter += 1;
    const item = { id: this.counter, ts: Date.now(), ...entry };
    this.items.push(item);
    if (this.items.length > this.cap) {
      this.items.splice(0, this.items.length - this.cap);
    }
    return item;
  }

  since(id = 0) {
    return this.items.filter((i) => i.id > id);
  }
}

export const logs = {
  chat: new RingLog(400),
  events: new RingLog(250),
  system: new RingLog(300),
};
