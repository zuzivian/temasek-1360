// A small RFC 6455 WebSocket server endpoint: the handshake, text messages, ping/pong and close.
// Written by hand so the repo keeps zero npm dependencies. Binary messages and extensions
// (permessage-deflate) are not supported; the game only sends JSON text.
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** A client that stops reading gets dropped once this much is queued for it. */
const MAX_BUFFERED = 4 * 1024 * 1024;

const header = (req: IncomingMessage, name: string): string => {
  const v = req.headers[name];
  return (Array.isArray(v) ? v[0] : v) ?? '';
};

/** The Sec-WebSocket-Accept value for a client key. */
export const acceptKey = (key: string): string => createHash('sha1').update(key + GUID).digest('base64');

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const hostname = (hostPort: string): string => hostPort.replace(/:\d+$/, '').toLowerCase();

/**
 * Browsers send an Origin; refuse pages from other sites so a random web page can't drive a
 * local game. Non-browser clients send none and are allowed.
 */
export function originAllowed(origin: string, host: string): boolean {
  if (!origin) return true;
  let o: string;
  try { o = new URL(origin).host; } catch { return false; }
  const oh = hostname(o);
  return oh === hostname(host) || LOCAL_HOSTS.has(oh);
}

export class WsConn {
  onMessage: (text: string) => void = () => {};
  onClose: () => void = () => {};
  private buf: Uint8Array = new Uint8Array(0);
  private parts: Uint8Array[] = [];
  private partBytes = 0;
  private closed = false;
  private readonly socket: Socket;
  private readonly maxMessage: number;
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });

  constructor(socket: Socket, maxMessage: number) {
    this.socket = socket;
    this.maxMessage = maxMessage;
    socket.setNoDelay(true);
    socket.on('data', chunk => this.feed(chunk));
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
  }

  get open(): boolean { return !this.closed; }

  send(text: string): void {
    if (this.closed) return;
    if (this.socket.writableLength > MAX_BUFFERED) { this.socket.destroy(); this.finish(); return; }
    this.socket.write(frame(0x1, new TextEncoder().encode(text)));
  }

  close(code = 1000): void {
    if (this.closed) return;
    const body = new Uint8Array([code >> 8, code & 0xff]);
    this.socket.write(frame(0x8, body));
    this.socket.end();
    this.finish();
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
  }

  /** Bytes from the client (also the bytes that arrived with the upgrade request). */
  feed(chunk: Uint8Array): void {
    if (this.closed) return;
    const next = new Uint8Array(this.buf.length + chunk.length);
    next.set(this.buf); next.set(chunk, this.buf.length);
    this.buf = next;
    while (!this.closed) {
      const f = parseFrame(this.buf, this.maxMessage);
      if (f === null) return; // need more bytes
      if ('error' in f) { this.close(f.error); return; }
      this.buf = this.buf.subarray(f.size);
      this.handle(f.fin, f.opcode, f.payload);
    }
  }

  private handle(fin: boolean, opcode: number, payload: Uint8Array): void {
    switch (opcode) {
      case 0x8: this.close(1000); return;
      case 0x9: this.socket.write(frame(0xa, payload)); return; // ping → pong
      case 0xa: return;
      case 0x2: this.close(1003); return; // binary: not part of the protocol
      case 0x1: case 0x0: {
        const continuing = this.parts.length > 0;
        if (opcode === 0x1 ? continuing : !continuing) { this.close(1002); return; } // fragments out of order
        this.partBytes += payload.length;
        if (this.partBytes > this.maxMessage) { this.close(1009); return; }
        this.parts.push(payload);
        if (!fin) return;
        const all = new Uint8Array(this.partBytes);
        let at = 0;
        for (const p of this.parts) { all.set(p, at); at += p.length; }
        this.parts = []; this.partBytes = 0;
        let text: string;
        try { text = this.decoder.decode(all); } catch { this.close(1007); return; }
        this.onMessage(text);
        return;
      }
      default: this.close(1002);
    }
  }
}

type Frame = { fin: boolean; opcode: number; payload: Uint8Array; size: number };

/** Parse one client frame from the front of buf: null if incomplete, or a close code on a protocol error. */
export function parseFrame(buf: Uint8Array, maxPayload: number): Frame | { error: number } | null {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0, opcode = buf[0] & 0x0f;
  if (buf[0] & 0x70) return { error: 1002 }; // no extensions were negotiated
  if (!(buf[1] & 0x80)) return { error: 1002 }; // clients must mask
  let len = buf[1] & 0x7f, at = 2;
  if (opcode >= 0x8 && (!fin || len > 125)) return { error: 1002 };
  if (len === 126) {
    if (buf.length < 4) return null;
    len = (buf[2] << 8) | buf[3]; at = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    if (buf[2] | buf[3] | buf[4] | buf[5]) return { error: 1009 };
    len = ((buf[6] << 24) >>> 0) + (buf[7] << 16) + (buf[8] << 8) + buf[9]; at = 10;
  }
  if (len > maxPayload) return { error: 1009 };
  if (buf.length < at + 4 + len) return null;
  const mask = buf.subarray(at, at + 4);
  const payload = new Uint8Array(len);
  for (let i = 0; i < len; i++) payload[i] = buf[at + 4 + i] ^ mask[i & 3];
  return { fin, opcode, payload, size: at + 4 + len };
}

/** An unmasked server frame. */
export function frame(opcode: number, payload: Uint8Array): Uint8Array {
  const n = payload.length;
  const head = n < 126 ? 2 : n < 65536 ? 4 : 10;
  const out = new Uint8Array(head + n);
  out[0] = 0x80 | opcode;
  if (n < 126) out[1] = n;
  else if (n < 65536) { out[1] = 126; out[2] = n >> 8; out[3] = n & 0xff; }
  else { out[1] = 127; for (let i = 0; i < 4; i++) out[6 + i] = (n >>> (24 - 8 * i)) & 0xff; }
  out.set(payload, head);
  return out;
}

/** Complete the handshake for an upgrade request, or refuse it. */
export function accept(req: IncomingMessage, socket: Socket, head: Uint8Array, maxMessage: number): WsConn | null {
  const key = header(req, 'sec-websocket-key');
  const ok = req.method === 'GET' && header(req, 'upgrade').toLowerCase() === 'websocket' && header(req, 'sec-websocket-version') === '13' && key.length > 0;
  if (!ok || !originAllowed(header(req, 'origin'), header(req, 'host'))) {
    socket.write(`HTTP/1.1 ${ok ? '403 Forbidden' : '400 Bad Request'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
    return null;
  }
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
  const conn = new WsConn(socket, maxMessage);
  if (head.length) conn.feed(head);
  return conn;
}
