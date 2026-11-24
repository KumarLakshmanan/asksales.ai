import { describe, expect, it } from 'vitest';
import { workflowApi } from '@/services/workflowApi';
import { useWorkflowApi } from '@/hooks/useWorkflowApi';

describe('useWorkflowApi', () => {
  it('returns the same API reference on every call', () => {
    const firstReference = useWorkflowApi();
    const secondReference = useWorkflowApi();

    expect(secondReference).toBe(firstReference);
    expect(secondReference).toBe(workflowApi);
  });
});
