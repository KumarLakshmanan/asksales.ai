/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * AgentContext Tests
 * Tests: error state, pipeline stage, progress, approval state
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { AgentProvider, useAgent } from '@/contexts/AgentContext';

describe('AgentContext', () => {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <AgentProvider>{children}</AgentProvider>
  );

  describe('error state', () => {
    it('should start with error as null', () => {
      const { result } = renderHook(() => useAgent(), { wrapper });
      expect(result.current.error).toBeNull();
    });

    it('should update error via setError', () => {
      const { result } = renderHook(() => useAgent(), { wrapper });

      act(() => {
        result.current.setError('Something went wrong');
      });

      expect(result.current.error).toBe('Something went wrong');
    });

    it('should clear error via setError(null)', () => {
      const { result } = renderHook(() => useAgent(), { wrapper });

      act(() => {
        result.current.setError('Error');
      });
      act(() => {
        result.current.setError(null);
      });

      expect(result.current.error).toBeNull();
    });
  });

  describe('pipeline stage', () => {
    it('should start with idle stage', () => {
      const { result } = renderHook(() => useAgent(), { wrapper });
      expect(result.current.pipelineStage).toBe('idle');
    });

    it('should update pipeline stage', () => {
      const { result } = renderHook(() => useAgent(), { wrapper });

      act(() => {
        result.current.setPipelineStage('processing');
      });

      expect(result.current.pipelineStage).toBe('processing');
    });

    it('should support all pipeline stages', () => {
      const { result } = renderHook(() => useAgent(), { wrapper });
      const stages = [
        'idle',
        'processing',
        'awaiting_approval',
        'executing_tool',
        'streaming',
        'completed',
        'error',
      ];

      stages.forEach((stage) => {
        act(() => {
          result.current.setPipelineStage(stage as any);
        });
        expect(result.current.pipelineStage).toBe(stage);
      });
    });
  });

  describe('progress tracking', () => {
    it('should start with progress at 0', () => {
      const { result } = renderHook(() => useAgent(), { wrapper });
      expect(result.current.progress).toBe(0);
    });

    it('should update progress', () => {
      const { result } = renderHook(() => useAgent(), { wrapper });

      act(() => {
        result.current.updateProgress(50, 'Halfway done');
      });

      expect(result.current.progress).toBe(50);
      expect(result.current.progressMessage).toBe('Halfway done');
    });

    it('should clamp progress to 0-100', () => {
      const { result } = renderHook(() => useAgent(), { wrapper });

      act(() => {
        result.current.updateProgress(150);
      });
      expect(result.current.progress).toBe(100);

      act(() => {
        result.current.updateProgress(-10);
      });
      expect(result.current.progress).toBe(0);
    });

    it('should reset progress', () => {
      const { result } = renderHook(() => useAgent(), { wrapper });

      act(() => {
        result.current.updateProgress(75, 'Working...');
      });
      act(() => {
        result.current.resetProgress();
      });

      expect(result.current.progress).toBe(0);
      expect(result.current.progressMessage).toBe('');
      expect(result.current.pipelineStage).toBe('idle');
    });
  });

  describe('approval state', () => {
    it('should start with no pending approval', () => {
      const { result } = renderHook(() => useAgent(), { wrapper });
      expect(result.current.pendingApproval).toBeNull();
    });

    it('should request approval', () => {
      const { result } = renderHook(() => useAgent(), { wrapper });

      const approval = {
        toolName: 'generate_image',
        description: 'Generate an image',
        agentType: 'content',
        parameters: { prompt: 'test' },
        timestamp: new Date().toISOString(),
      };

      act(() => {
        result.current.requestApproval(approval);
      });

      expect(result.current.pendingApproval).toEqual(approval);
      expect(result.current.pipelineStage).toBe('awaiting_approval');
    });

    it('should clear approval', () => {
      const { result } = renderHook(() => useAgent(), { wrapper });

      act(() => {
        result.current.requestApproval({
          toolName: 'test',
          timestamp: new Date().toISOString(),
        });
      });
      act(() => {
        result.current.clearApproval();
      });

      expect(result.current.pendingApproval).toBeNull();
    });
  });

  describe('agent selection', () => {
    it('should start with no selected agent', () => {
      const { result } = renderHook(() => useAgent(), { wrapper });
      expect(result.current.selectedAgent).toBeNull();
    });

    it('should set selected agent', () => {
      const { result } = renderHook(() => useAgent(), { wrapper });

      act(() => {
        result.current.setSelectedAgent({
          id: 'content',
          name: 'Content Agent',
          role: 'content_studio',
          specialty: 'Content creation',
          avatar: '/avatars/content.png',
        });
      });

      expect(result.current.selectedAgent?.id).toBe('content');
    });

    it('should clear selected agent', () => {
      const { result } = renderHook(() => useAgent(), { wrapper });

      act(() => {
        result.current.setSelectedAgent({
          id: 'content',
          name: 'Content Agent',
          role: 'content_studio',
          specialty: 'Content creation',
          avatar: '/avatars/content.png',
        });
      });
      act(() => {
        result.current.setSelectedAgent(null);
      });

      expect(result.current.selectedAgent).toBeNull();
    });
  });

  describe('current agent type', () => {
    it('should default to orchestrator', () => {
      const { result } = renderHook(() => useAgent(), { wrapper });
      expect(result.current.currentAgentType).toBe('orchestrator');
    });

    it('should update current agent type', () => {
      const { result } = renderHook(() => useAgent(), { wrapper });

      act(() => {
        result.current.setCurrentAgentType('content');
      });

      expect(result.current.currentAgentType).toBe('content');
    });
  });

  describe('useAgent hook', () => {
    it('should throw error when used outside provider', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => {
        renderHook(() => useAgent());
      }).toThrow('useAgent must be used within AgentProvider');

      spy.mockRestore();
    });
  });
});
