// Demo/test-only preload (never shipped): installs a simulated inRide trainer and heart-rate strap as a fake
// navigator.bluetooth in the page, so the real connection, decoding and recording code runs without hardware.
require('electron').contextBridge.executeInMainWorld({ func: function () {
// Injected into the app window before its scripts: a fake navigator.bluetooth with an inRide sensor and a
// heart-rate strap, so the real connection code can be driven without hardware or OS permission prompts.
(() => {
  const full = (u) => {
    if (typeof u === 'number') return `0000${u.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;
    return String(u).toLowerCase();
  };
  const dv = (bytes) => new DataView(new Uint8Array(bytes).buffer);

  class FakeChar extends EventTarget {
    constructor(service, uuid, props, value) {
      super();
      this.service = service;
      this.uuid = full(uuid);
      this.properties = { read: false, write: false, writeWithoutResponse: false, notify: false, indicate: false, ...props };
      this.value = value ? dv(value) : null;
      this.notifying = false;
      this.writes = [];
    }
    check() {
      if (!this.service.device.gatt.connected) return Promise.reject(new DOMException('GATT Server is disconnected.', 'NetworkError'));
      return null;
    }
    async readValue() { const e = this.check(); if (e) return e; return this.value; }
    async writeValueWithResponse(v) { const e = this.check(); if (e) return e; this.writes.push(Array.from(v)); window.__fake.log.push(['write', this.uuid, Array.from(v)]); }
    async writeValueWithoutResponse(v) { return this.writeValueWithResponse(v); }
    async startNotifications() { const e = this.check(); if (e) return e; this.notifying = true; return this; }
    async stopNotifications() { this.notifying = false; return this; }
    emit(bytes) {
      if (!this.notifying || !this.service.device.gatt.connected) return false;
      this.value = dv(bytes);
      this.dispatchEvent(new Event('characteristicvaluechanged'));
      return true;
    }
  }

  class FakeService {
    constructor(device, uuid) { this.device = device; this.uuid = full(uuid); this.chars = []; }
    add(uuid, props, value) { const c = new FakeChar(this, uuid, props, value); this.chars.push(c); return c; }
    async getCharacteristics() { return this.chars; }
    async getCharacteristic(u) { const c = this.chars.find((x) => x.uuid === full(u)); if (!c) throw new DOMException('No Characteristics matching UUID', 'NotFoundError'); return c; }
  }

  class FakeDevice extends EventTarget {
    constructor(chooserId, name) {
      super();
      this.id = 'web-' + chooserId;
      this.chooserId = chooserId;
      this.name = name;
      this.asleep = false;
      this.services = [];
      const device = this;
      this.gatt = {
        device,
        connected: false,
        async connect() {
          window.__fake.log.push(['connect', device.name, device.asleep]);
          await new Promise((r) => setTimeout(r, 200));
          if (device.asleep) throw new DOMException('Connection attempt failed.', 'NetworkError');
          this.connected = true;
          return this;
        },
        disconnect() {
          if (!this.connected) return;
          this.connected = false;
          for (const s of device.services) for (const c of s.chars) c.notifying = false;
          setTimeout(() => device.dispatchEvent(new Event('gattserverdisconnected')), 10);
        },
        async getPrimaryServices() { if (!this.connected) throw new DOMException('GATT Server is disconnected.', 'NetworkError'); return device.services; },
        async getPrimaryService(u) { const s = device.services.find((x) => x.uuid === full(u)); if (!s) throw new DOMException('No Services matching UUID', 'NotFoundError'); return s; },
      };
    }
    service(uuid) { const s = new FakeService(this, uuid); this.services.push(s); return s; }
    sleep() { this.asleep = true; this.gatt.disconnect(); }
    wake() { this.asleep = false; }
  }

  const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0));
  const POWER = 'e9410100-b434-446b-b5cc-36592fc4c724';
  const inride = new FakeDevice('AA:BB:CC:DD:EE:01', 'inRide 4F2A');
  const ps = inride.service(POWER);
  const powerChar = ps.add('e9410101-b434-446b-b5cc-36592fc4c724', { notify: true });
  ps.add('e9410102-b434-446b-b5cc-36592fc4c724', { write: true });
  ps.add('e9410104-b434-446b-b5cc-36592fc4c724', { read: true, notify: true },
    [0x5a, 0x02, 0x8f, 0x02, 0xb6, 0x03, 0x47, 0x01, 0x00, 0xe0, 0x00, 0x00, 0x20, 0x00, 0x08, 0x00, 0, 0, 0, 0]);
  const dis = inride.service(0x180a);
  dis.add(0x2a23, { read: true }, [0x10, 0x21, 0x32, 0x43, 0x54, 0x65]);
  dis.add(0x2a24, { read: true }, ascii('inRide'));
  dis.add(0x2a25, { read: true }, ascii('SECRET'));
  dis.add(0x2a26, { read: true }, ascii('1.2'));
  dis.add(0x2a29, { read: true }, ascii('Kinetic'));
  inride.service(0x180f).add(0x2a19, { read: true }, [77]);

  const strap = new FakeDevice('AA:BB:CC:DD:EE:02', 'Polar H9 1A2B3C4D');
  const hrChar = strap.service(0x180d).add(0x2a37, { notify: true });
  strap.service(0x180f).add(0x2a19, { read: true }, [91]);
  strap.service(0x180a).add(0x2a29, { read: true }, ascii('Polar Electro Oy'));

  const devices = [inride, strap];
  window.__fake = {
    inride, strap, powerChar, hrChar, log: [], pending: null,
    // A requestDevice the harness has not answered yet: {filters, acceptAllDevices}.
    take() { const p = this.pending; return p ? { options: p.options, id: p.id } : null; },
    resolve(id, chooserId) {
      const p = this.pending;
      if (!p || p.id !== id) return false;
      this.pending = null;
      if (!chooserId) p.reject(new DOMException('User cancelled the requestDevice() chooser.', 'NotFoundError'));
      else p.resolve(devices.find((d) => d.chooserId === chooserId));
      return true;
    },
  };
  let seq = 0;
  Object.defineProperty(navigator, 'bluetooth', {
    configurable: true,
    value: Object.assign(new EventTarget(), {
      async getAvailability() { return true; },
      requestDevice(options) {
        if (window.__fake.pending) window.__fake.pending.reject(new DOMException('User cancelled the requestDevice() chooser.', 'NotFoundError'));
        return new Promise((resolve, reject) => {
          window.__fake.pending = { id: ++seq, options: JSON.parse(JSON.stringify(options)), resolve, reject };
          window.__fake.log.push(['requestDevice', seq, JSON.stringify(options).slice(0, 120)]);
        });
      },
    }),
  });
})();
} });
