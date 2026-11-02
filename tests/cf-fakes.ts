/** Minimal in-memory stand-ins for the Durable Object runtime APIs used by RoomDurableObject. */
export class FakeStorage {
  map = new Map<string, unknown>();
  alarm: number | null = null;
  async get<T>(k: string): Promise<T | undefined> {
    const v = this.map.get(k);
    return v === undefined ? undefined : (structuredClone(v) as T);
  }
  async put(k: string, v: unknown) {
    this.map.set(k, structuredClone(v));
  }
  async deleteAll() {
    this.map.clear();
  }
  async setAlarm(at: number) {
    this.alarm = at;
  }
  async deleteAlarm() {
    this.alarm = null;
  }
  async getAlarm() {
    return this.alarm;
  }
}

export class FakeSocket {
  sent: string[] = [];
  closed = false;
  private attachment: unknown = null;
  send(t: string) {
    if (this.closed) throw new Error('closed');
    this.sent.push(t);
  }
  close() {
    this.closed = true;
  }
  serializeAttachment(v: unknown) {
    this.attachment = structuredClone(v);
  }
  deserializeAttachment() {
    return structuredClone(this.attachment);
  }
  messages() {
    return this.sent.map((s) => JSON.parse(s));
  }
  last(t: string) {
    return this.messages().filter((m) => m.t === t).at(-1);
  }
}

export class FakeCtx {
  storage = new FakeStorage();
  sockets: FakeSocket[] = [];
  acceptWebSocket(ws: FakeSocket) {
    this.sockets.push(ws);
  }
  getWebSockets() {
    return this.sockets.filter((s) => !s.closed);
  }
  setWebSocketAutoResponse() {}
}

export function installCfGlobals() {
  const g = globalThis as Record<string, unknown>;
  g.WebSocketRequestResponsePair ??= class {
    constructor(
      public request: string,
      public response: string,
    ) {}
  };
}
