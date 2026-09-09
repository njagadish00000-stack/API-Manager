declare module 'sql.js' {
  export type SqlValue = number | string | Uint8Array | null;
  export type BindParams = SqlValue[] | Record<string, SqlValue>;

  export interface QueryExecResult {
    columns: string[];
    values: SqlValue[][];
  }

  export interface Statement {
    bind(params?: BindParams): boolean;
    step(): boolean;
    get(): SqlValue[];
    getAsObject(): Record<string, SqlValue>;
    run(params?: BindParams): void;
    free(): boolean;
    getSQL(): string;
  }

  export class Database {
    constructor(data?: ArrayLike<number> | Buffer | null);
    run(sql: string, params?: BindParams): Database;
    exec(sql: string, params?: BindParams): QueryExecResult[];
    prepare(sql: string, params?: BindParams): Statement;
    export(): Uint8Array;
    close(): void;
    getRowsModified(): number;
    each(sql: string, params: BindParams, callback: (row: Record<string, SqlValue>) => void, done: () => void): void;
  }

  export interface SqlJsConfig {
    locateFile?: (file: string) => string;
  }

  export interface SqlJsStatic {
    Database: typeof Database;
    Statement: new () => Statement;
  }

  export default function initSqlJs(config?: SqlJsConfig): Promise<SqlJsStatic>;
}
