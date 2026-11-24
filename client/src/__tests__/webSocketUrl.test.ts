import { afterEach, describe, expect, it, vi } from 'vitest';
import { webSocketService } from '@/services/WebSocketService';

const urlFor = () =>
  (webSocketService as unknown as { getWebSocketUrl: () => string }).getWebSocketUrl();

describe('realtime WebSocket URL', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('follows the API URL when no separate WebSocket host is configured', () => {
    vi.stubEnv('NEXT_PUBLIC_WS_URL', '');
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'http://localhost:8082');
    expect(urlFor()).toBe('ws://localhost:8082/api/agents/progress');
  });

  it('prefers an explicitly configured WebSocket host', () => {
    vi.stubEnv('NEXT_PUBLIC_WS_URL', 'wss://realtime.example.test');
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.test');
    expect(urlFor()).toBe('wss://realtime.example.test/api/agents/progress');
  });

  it('uses the page origin when neither is configured', () => {
    vi.stubEnv('NEXT_PUBLIC_WS_URL', '');
    vi.stubEnv('NEXT_PUBLIC_API_URL', '');
    expect(urlFor()).toBe(`ws://${window.location.host}/api/agents/progress`);
  });
});
