declare module "node:crypto" {
  interface Hash {
    update(data: string): Hash;
    digest(): Uint8Array;
    digest(encoding: "hex"): string;
  }
  export function createHash(algorithm: string): Hash;
  export interface Hmac { update(data: string): Hmac; digest(encoding: "hex"): string; }
  export function createHmac(algorithm: string, key: string): Hmac;
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
  export function randomUUID(): string;
  export interface KeyObject {}
  export function createPublicKey(options: { key: unknown; format: "jwk" }): KeyObject;
  export function verify(algorithm: string, data: Uint8Array, key: KeyObject, signature: Uint8Array): boolean;
  export function generateKeyPairSync(type: "rsa", options: {
    modulusLength: number;
    publicKeyEncoding: { format: "jwk" };
    privateKeyEncoding: { format: "pem"; type: "pkcs8" };
  }): { publicKey: Record<string, unknown>; privateKey: string };
  export function sign(algorithm: string, data: Uint8Array, key: string): Buffer;
}

declare module "node:fs/promises" {
  export function readFile(path: URL | string, encoding: "utf8"): Promise<string>;
  export function readdir(path: URL | string): Promise<string[]>;
  export function readdir(path: URL | string, options: { recursive: true }): Promise<string[]>;
  export function access(path: URL | string): Promise<void>;
}

declare module "node:http" {
  export interface IncomingHttpHeaders { [key: string]: string | string[] | undefined; }
  export interface IncomingMessage extends AsyncIterable<Uint8Array> {
    method?: string;
    url?: string;
    headers: IncomingHttpHeaders;
    on(event: "aborted", listener: () => void): void;
  }
  export interface ServerResponse {
    writeHead(statusCode: number, headers?: Record<string, string>): void;
    end(data?: string): void;
  }
  export interface Server { listen(port: number, callback?: () => void): void; close(callback?: () => void): void; }
  export function createServer(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): Server;
}

declare module "node:assert/strict" {
  const assert: {
    equal(actual: unknown, expected: unknown): void;
    ok(value: unknown): void;
    rejects(fn: () => Promise<unknown>, expected?: RegExp): Promise<void>;
    throws(fn: () => unknown, expected?: RegExp): void;
  };
  export default assert;
}

declare module "node:test" {
  export default function test(name: string, fn: () => void | Promise<void>): void;
}

declare class Buffer extends Uint8Array {
  static from(data: Uint8Array | string, encoding?: string): Buffer;
  static concat(chunks: readonly Uint8Array[]): Buffer;
  toString(encoding?: string): string;
}

declare const process: {
  env: Record<string, string | undefined>;
  on(event: "SIGTERM" | "SIGINT", listener: () => void): void;
  exit(code?: number): never;
  exitCode?: number;
};

declare module "node:fs" {
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string, encoding: "utf8"): void;
  export function renameSync(oldPath: string, newPath: string): void;
  export function unlinkSync(path: string): void;
}

declare module "node:path" {
  export function dirname(path: string): string;
}

declare module "node:perf_hooks" {
  export const performance: { now(): number };
}


declare module "node:sqlite" {
  export interface RunResult { changes: number; lastInsertRowid: number | bigint; }
  export class StatementSync {
    run(...params: unknown[]): RunResult;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }
  export class DatabaseSync {
    constructor(location: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}

declare module "pg" {
  export interface QueryResult<Row = Record<string, unknown>> { rows: Row[]; rowCount: number | null; }
  export interface PoolClient {
    query<Row = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<QueryResult<Row>>;
    release(): void;
  }
  export class Pool {
    constructor(config?: Record<string, unknown>);
    query<Row = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<QueryResult<Row>>;
    connect(): Promise<PoolClient>;
    end(): Promise<void>;
  }
}
