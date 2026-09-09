export interface MatchHighlightSegment {
  text: string;
  isMatch: boolean;
}

export interface SpeedSearchMatch<T> {
  item: T;
  key: string;
  score: number;
}
