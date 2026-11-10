// Minimal Node typings for the game server, so the repo still needs no npm install (see
// tests/node-shim.d.ts for the same idea). Only what server/ actually uses is declared.
declare module 'node:net' {
  export interface Socket {
    write(data: Uint8Array | string): boolean;
    end(): void;
    destroy(): void;
    setNoDelay(noDelay?: boolean): void;
    readonly writableLength: number;
    readonly destroyed: boolean;
    on(ev: 'data', fn: (chunk: Uint8Array) => void): Socket;
    on(ev: 'close' | 'end', fn: () => void): Socket;
    on(ev: 'error', fn: (err: Error) => void): Socket;
  }
}
declare module 'node:http' {
  import type { Socket } from 'node:net';
  export interface IncomingMessage {
    method?: string;
    url?: string;
    headers: Record<string, string | string[] | undefined>;
  }
  export interface ServerResponse {
    writeHead(code: number, headers?: Record<string, string>): ServerResponse;
    end(body?: string | Uint8Array): void;
  }
  export interface Server {
    listen(port: number, host: string, cb: () => void): Server;
    close(cb?: (err?: Error) => void): void;
    closeAllConnections(): void;
    address(): { port: number } | string | null;
    on(ev: 'upgrade', fn: (req: IncomingMessage, socket: Socket, head: Uint8Array) => void): Server;
    on(ev: 'error', fn: (err: Error) => void): Server;
  }
  export function createServer(fn: (req: IncomingMessage, res: ServerResponse) => void): Server;
}
declare module 'node:crypto' {
  export function createHash(alg: 'sha1'): { update(s: string): { digest(enc: 'base64'): string } };
}
declare module 'node:fs/promises' {
  export function readFile(path: string): Promise<Uint8Array>;
}
declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function normalize(path: string): string;
  export function resolve(...parts: string[]): string;
  export function extname(path: string): string;
  export const sep: string;
}
