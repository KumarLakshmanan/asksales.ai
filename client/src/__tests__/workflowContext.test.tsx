/**
 * WorkflowContext Tests
 * Tests: workflow state management, stage transitions, actions
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react';
import { WorkflowProvider, useWorkflow } from '@/contexts/WorkflowContext';

// Mock the workflow API
vi.mock('@/hooks/useWorkflowApi', () => ({
  useWorkflowApi: vi.fn().mockReturnValue({
    getScrapingProgress: vi.fn().mockResolvedValue({ channels: [], totalLeads: 0, status: 'pending' }),
    getOutreachProgress: vi.fn().mockResolvedValue({ channels: [], totalOutreached: 0, status: 'pending' }),
    getAdProgress: vi.fn().mockResolvedValue({ campaigns: [], totalBudget: 0, status: 'pending' }),
    startOutreach: vi.fn().mockResolvedValue({ campaign_id: 42, status: 'needs_review' }),
    getAdSets: vi.fn().mockResolvedValue({ adSets: [] }),
    analyzeGoal: vi.fn().mockResolvedValue({ icp: {} }),
    startScraping: vi.fn().mockResolvedValue({}),
  }),
}));

describe('WorkflowContext', () => {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <WorkflowProvider>{children}</WorkflowProvider>
  );

  describe('initial state', () => {
    it('should start with idle stage', () => {
      const { result } = renderHook(() => useWorkflow(), { wrapper });
      expect(result.current.state.stage).toBe('idle');
    });

    it('should start with 0 progress', () => {
      const { result } = renderHook(() => useWorkflow(), { wrapper });
      expect(result.current.state.progress).toBe(0);
    });
  });

  describe('dispatch actions', () => {
    it('should handle USER_PROMPT action', () => {
      const { result } = renderHook(() => useWorkflow(), { wrapper });

      act(() => {
        result.current.dispatch({ type: 'USER_PROMPT', payload: 'Build an ICP for SaaS companies' });
      });

      expect(result.current.state.userPrompt).toBe('Build an ICP for SaaS companies');
      expect(result.current.state.stage).toBe('icp_building');
    });

    it('should handle USER_APPROVED action', () => {
      const { result } = renderHook(() => useWorkflow(), { wrapper });

      act(() => {
        result.current.dispatch({ type: 'USER_PROMPT', payload: 'test' });
      });
      act(() => {
        result.current.dispatch({ type: 'USER_APPROVED' });
      });

      expect(result.current.state.stage).toBe('executing');
    });

    it('should handle USER_REJECTED action', () => {
      const { result } = renderHook(() => useWorkflow(), { wrapper });

      act(() => {
        result.current.dispatch({ type: 'USER_PROMPT', payload: 'test' });
      });
      act(() => {
        result.current.dispatch({ type: 'USER_REJECTED' });
      });

      expect(result.current.state.stage).toBe('idle');
    });

    it('should handle PROGRESS_TICK action', () => {
      const { result } = renderHook(() => useWorkflow(), { wrapper });

      act(() => {
        result.current.dispatch({ type: 'PROGRESS_TICK' });
      });

      expect(result.current.state.progress).toBeGreaterThan(0);
    });

    it('should handle SET_CAMPAIGN_ID action', () => {
      const { result } = renderHook(() => useWorkflow(), { wrapper });

      act(() => {
        result.current.dispatch({ type: 'SET_CAMPAIGN_ID', payload: 'campaign-123' });
      });

      expect(result.current.state.campaignId).toBe('campaign-123');
    });

    it('stops active outreach when the start API returns a draft needing review', async () => {
      const { result } = renderHook(() => useWorkflow(), { wrapper });
      act(() => {
        result.current.dispatch({ type: 'SET_WORKFLOW_ID', payload: 'workflow-42' });
        result.current.dispatch({ type: 'DECLINE_CONTENT_STUDIO' });
      });
      await waitFor(() => expect(result.current.state.outreachNeedsReview).toBe(true));
      expect(result.current.state.campaignId).toBe('42');
      expect(result.current.state.stage).toBe('outreach_recommendation');
      expect(result.current.state.currentTask).toMatch(/before scheduling/);
    });
  });

  describe('context availability', () => {
    it('should provide state and dispatch', () => {
      const { result } = renderHook(() => useWorkflow(), { wrapper });
      expect(result.current.state).toBeDefined();
      expect(typeof result.current.dispatch).toBe('function');
    });

    it('should throw error when used outside provider', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => {
        renderHook(() => useWorkflow());
      }).toThrow();

      spy.mockRestore();
    });
  });
});
