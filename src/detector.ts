import { detectSourceByAdapters } from './sources';
export type { DetectResult, DetectedKind } from './sources';

export async function detectSource(rawUrl: string) {
  return detectSourceByAdapters(rawUrl);
}
