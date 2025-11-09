export type RowLike = {
  code?: string | null;
  name?: string | null;
  price_value?: number | null;
};

export type DedupeResult<T extends RowLike> = {
  rows: T[];
  duplicates: number;
};

export declare function dedupeRows<T extends RowLike>(rows: T[]): DedupeResult<T>;
