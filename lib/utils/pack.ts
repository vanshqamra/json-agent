export type PackResult = {
  pack: string | null;
  pack_raw: string | null;
};

export declare function extractPack(text: string | null | undefined): PackResult;
