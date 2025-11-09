export type PreSegmentFragment = {
  id: string;
  text: string;
};

export type PreSegmentBlock = {
  id?: string;
  text?: string;
};

export declare function preSegmentText(text: string): string[];
export declare function preSegmentBlock(block: PreSegmentBlock): PreSegmentFragment[];
