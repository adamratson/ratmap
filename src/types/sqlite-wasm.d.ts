// Minimal ambient types for @sqlite.org/sqlite-wasm, which ships no .d.ts of its own.
// Deliberately narrow: only the surface src/search.ts actually uses, so this stays easy
// to check against the real library rather than becoming a fictional API.

declare module '@sqlite.org/sqlite-wasm' {
  export interface ExecOptions {
    sql: string;
    bind?: Record<string, string | number | null>;
    rowMode?: 'array' | 'object' | 'stmt' | number | string;
    returnValue?: 'this' | 'resultRows' | 'saveSql';
  }

  export interface Database {
    /** WASM heap pointer to the underlying sqlite3* handle. */
    readonly pointer?: number;
    exec(options: ExecOptions): unknown;
    exec(sql: string): unknown;
    close(): void;
  }

  export interface Sqlite3Static {
    version: { libVersion: string };
    oo1: {
      DB: new (filename?: string, flags?: string) => Database;
    };
    wasm: {
      /** Copies `data` into the WASM heap and returns a pointer to it. */
      allocFromTypedArray(data: Uint8Array): number;
    };
    capi: {
      SQLITE_DESERIALIZE_FREEONCLOSE: number;
      SQLITE_DESERIALIZE_RESIZEABLE: number;
      SQLITE_DESERIALIZE_READONLY: number;
      /** Returns an sqlite result code; 0 is SQLITE_OK. */
      sqlite3_deserialize(
        db: number,
        schema: string,
        data: number,
        dbSize: number,
        bufferSize: number,
        flags: number,
      ): number;
    };
  }

  export interface InitOptions {
    print?: (message: string) => void;
    printErr?: (message: string) => void;
    locateFile?: (path: string, prefix: string) => string;
  }

  export default function sqlite3InitModule(options?: InitOptions): Promise<Sqlite3Static>;
}
