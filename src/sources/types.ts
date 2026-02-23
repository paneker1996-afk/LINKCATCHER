export type DetectedKind = 'file' | 'hls' | 'youtube' | 'instagram' | 'rutube' | 'ok' | 'vk' | 'unsupported';

export interface DetectResult {
  type: DetectedKind;
  finalUrl: string;
  reason?: string;
  contentType?: string | null;
  adapter: 'youtube' | 'instagram' | 'rutube' | 'ok' | 'vk' | 'platform-block' | 'direct';
}
