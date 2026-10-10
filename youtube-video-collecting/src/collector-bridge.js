const net = require('node:net');
const crypto = require('node:crypto');
const { parseYouTubeUrl } = require('./collector-link');

const MAX_MESSAGE = 65536;

function encodeMessage(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.length > MAX_MESSAGE) throw new Error('Message is too large');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

function createDecoder(onMessage, onError) {
  let buffer = Buffer.alloc(0);
  let failed = false;
  return (chunk) => {
    if (failed) return;
    try {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (!length || length > MAX_MESSAGE) throw new Error('Invalid message length');
        if (buffer.length < 4 + length) break;
        const message = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'));
        buffer = buffer.subarray(4 + length);
        onMessage(message);
      }
      if (buffer.length > MAX_MESSAGE + 4) throw new Error('Message is too large');
    } catch (error) {
      failed = true;
      onError(error);
    }
  };
}

function validToken(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

class CollectorBridge {
  constructor({ pipeName, token, onOpen, timeoutMs = 20000 }) {
    this.pipeName = pipeName;
    this.token = token;
    this.onOpen = onOpen;
    this.timeoutMs = timeoutMs;
    this.requests = new Map();
    this.sockets = new Set();
    this.readyWaiters = new Set();
    this.ready = false;
    this.closed = false;
    this.server = net.createServer((socket) => this.connect(socket));
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.pipeName, () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
  }

  setReady(ready) {
    this.ready = ready;
    if (ready) for (const resolve of this.readyWaiters) resolve();
  }

  async waitForReady(signal) {
    if (signal.aborted || this.closed) throw new Error('Collector is stopping');
    if (this.ready) return;
    await new Promise((resolve, reject) => {
      const finish = () => { cleanup(); resolve(); };
      const abort = () => { cleanup(); reject(new Error('Collector startup timed out')); };
      const cleanup = () => { this.readyWaiters.delete(finish); signal.removeEventListener('abort', abort); };
      this.readyWaiters.add(finish);
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  async handle(message) {
    const requestId = message && message.requestId;
    const error = (code, detail) => ({ version: 1, requestId, status: 'error', code, message: detail });
    if (!message || !validToken(message.token, this.token)) return error('unauthorized', 'Invalid bridge credentials');
    if (message.version !== 1 || typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(requestId)) {
      return error('invalid_request', 'Invalid request');
    }
    if (message.type === 'ping') return { version: 1, requestId, status: 'connected', ready: this.ready };
    if (message.type !== 'open-video') return error('invalid_request', 'Unsupported request type');
    let video;
    try { video = parseYouTubeUrl(message.url); } catch (e) { return error('invalid_url', e.message); }
    const cached = this.requests.get(requestId);
    if (cached) return cached.url === video.url ? cached.promise : error('invalid_request', 'Request ID was reused');
    for (const [id, entry] of this.requests) {
      if (entry.finished && (this.requests.size >= 128 || Date.now() - entry.finished > 60000)) this.requests.delete(id);
    }
    if (this.requests.size >= 128) return error('busy', 'Too many pending requests');
    const controller = new AbortController();
    const expiresAt = Date.now() + this.timeoutMs;
    const entry = { url: video.url, finished: 0, controller };
    entry.promise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        controller.abort();
        resolve(error('startup_timeout', 'Collector did not accept the link in time'));
      }, this.timeoutMs);
      (async () => {
        await this.waitForReady(controller.signal);
        await this.onOpen({ ...video, requestId, expiresAt }, controller.signal);
        if (controller.signal.aborted) throw new Error('Request expired');
        return { version: 1, requestId, status: 'accepted' };
      })().then(resolve, (e) => resolve(error('delivery_failed', e.message))).finally(() => clearTimeout(timer));
    }).then((response) => { entry.finished = Date.now(); return response; });
    this.requests.set(requestId, entry);
    return entry.promise;
  }

  connect(socket) {
    this.sockets.add(socket);
    socket.setTimeout(this.timeoutMs + 5000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('close', () => this.sockets.delete(socket));
    let received = false;
    socket.on('data', createDecoder((message) => {
      if (received) { socket.destroy(); return; }
      received = true;
      this.handle(message).then((response) => {
        if (!socket.destroyed) socket.end(encodeMessage(response));
      }, () => socket.destroy());
    }, () => socket.destroy()));
  }

  close() {
    this.closed = true;
    for (const entry of this.requests.values()) entry.controller.abort();
    for (const socket of this.sockets) socket.destroy();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

module.exports = { CollectorBridge, encodeMessage, createDecoder, MAX_MESSAGE };
