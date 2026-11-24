/**
 * WebSocketContext Tests
 * Tests: retryConnection, maxRetriesReached, retryCount tracking
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderHook, act } from '@testing-library/react';

const { mockConnect, mockDisconnect, mockGetState, mockSubscribe } = vi.hoisted(() => {
  return {
    mockConnect: vi.fn().mockRejectedValue(new Error('mocked')),
    mockDisconnect: vi.fn(),
    mockGetState: vi.fn().mockReturnValue('DISCONNECTED'),
    mockSubscribe: vi.fn().mockReturnValue(vi.fn()),
  };
});

vi.mock('@/services/WebSocketService', () => ({
  default: {
    connect: mockConnect,
    disconnect: mockDisconnect,
    getState: mockGetState,
    subscribe: mockSubscribe,
    send: vi.fn(),
  },
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: vi.fn().mockReturnValue({
    user: { id: 1, email: 'test@test.com' },
  }),
}));

import { WebSocketProvider, useWebSocket } from '@/contexts/WebSocketContext';
import { selectBusinessProfile } from '@/lib/business-profile';

describe('WebSocketContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetState.mockReturnValue('DISCONNECTED');
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('user', JSON.stringify({ id: 1 }));
    sessionStorage.setItem('active-business-profile:1', '11');
    localStorage.setItem('token', 'test-token');
  });

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <WebSocketProvider>{children}</WebSocketProvider>
  );

  it('waits for a selected business and reconnects after the selection changes', async () => {
    sessionStorage.clear();
    await act(async () => { renderHook(() => useWebSocket(), { wrapper }); });
    expect(mockConnect).not.toHaveBeenCalled();
    await act(async () => selectBusinessProfile(11));
    expect(mockConnect).toHaveBeenCalledTimes(1);
    await act(async () => selectBusinessProfile(22));
    expect(mockConnect).toHaveBeenCalledTimes(2);
  });

  describe('initial state', () => {
    it('should start with isConnected as false', async () => {
      const { result } = await act(async () => {
        return renderHook(() => useWebSocket(), { wrapper });
      });
      expect(result.current.isConnected).toBe(false);
    });

    it('should start with isConnecting as false', async () => {
      const { result } = await act(async () => {
        return renderHook(() => useWebSocket(), { wrapper });
      });
      expect(result.current.isConnecting).toBe(false);
    });

    it('should start with retryCount as 0', async () => {
      const { result } = await act(async () => {
        return renderHook(() => useWebSocket(), { wrapper });
      });
      expect(result.current.retryCount).toBe(0);
    });

    it('should start with maxRetriesReached as false', async () => {
      const { result } = await act(async () => {
        return renderHook(() => useWebSocket(), { wrapper });
      });
      expect(result.current.maxRetriesReached).toBe(false);
    });
  });

  describe('retryConnection', () => {
    it('should provide retryConnection function', () => {
      const { result } = renderHook(() => useWebSocket(), { wrapper });
      expect(typeof result.current.retryConnection).toBe('function');
    });

    it('should reset maxRetriesReached when retryConnection is called', () => {
      const { result } = renderHook(() => useWebSocket(), { wrapper });

      act(() => {
        result.current.retryConnection();
      });

      expect(result.current.maxRetriesReached).toBe(false);
    });

    it('should reset retryCount when retryConnection is called', () => {
      const { result } = renderHook(() => useWebSocket(), { wrapper });

      act(() => {
        result.current.retryConnection();
      });

      expect(result.current.retryCount).toBe(0);
    });
  });

  describe('subscribe', () => {
    it('should provide subscribe function', () => {
      const { result } = renderHook(() => useWebSocket(), { wrapper });
      expect(typeof result.current.subscribe).toBe('function');
    });

    it('should call WebSocketService.subscribe', () => {
      const { result } = renderHook(() => useWebSocket(), { wrapper });
      const handler = vi.fn();
      result.current.subscribe('test_event', handler);
      expect(mockSubscribe).toHaveBeenCalledWith('test_event', handler);
    });

    it('should return unsubscribe function', () => {
      const mockUnsub = vi.fn();
      mockSubscribe.mockReturnValue(mockUnsub);

      const { result } = renderHook(() => useWebSocket(), { wrapper });
      const unsub = result.current.subscribe('test_event', vi.fn());
      unsub();
      expect(mockUnsub).toHaveBeenCalled();
    });
  });

  describe('event subscriptions', () => {
    it('should subscribe to websocket_connected event', () => {
      renderHook(() => useWebSocket(), { wrapper });
      expect(mockSubscribe).toHaveBeenCalledWith('websocket_connected', expect.any(Function));
    });

    it('should subscribe to websocket_disconnected event', () => {
      renderHook(() => useWebSocket(), { wrapper });
      expect(mockSubscribe).toHaveBeenCalledWith('websocket_disconnected', expect.any(Function));
    });

    it('should subscribe to websocket_error event', () => {
      renderHook(() => useWebSocket(), { wrapper });
      expect(mockSubscribe).toHaveBeenCalledWith('websocket_error', expect.any(Function));
    });

    it('should subscribe to websocket_max_retries event', () => {
      renderHook(() => useWebSocket(), { wrapper });
      expect(mockSubscribe).toHaveBeenCalledWith('websocket_max_retries', expect.any(Function));
    });

    it('should subscribe to websocket_retrying event', () => {
      renderHook(() => useWebSocket(), { wrapper });
      expect(mockSubscribe).toHaveBeenCalledWith('websocket_retrying', expect.any(Function));
    });
  });

  describe('useWebSocket hook', () => {
    it('should throw error when used outside provider', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => {
        renderHook(() => useWebSocket());
      }).toThrow('useWebSocket must be used within WebSocketProvider');

      spy.mockRestore();
    });
  });
});
