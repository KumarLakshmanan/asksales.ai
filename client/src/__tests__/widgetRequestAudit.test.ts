import { describe, expect, it } from 'vitest';
import { assertOnlyIntentionalWidgetCleanup, classifyWidgetRequestFailures, widgetEffectSourceProof, type WidgetRequestAudit } from '../../e2e/helpers/widget-request-audit';

const url = 'http://127.0.0.1:3000/api/support-widget/token';
const sourceProof = { scriptUrl: 'http://127.0.0.1:3000/_next/static/chunks/hashed.js', scriptSha256: 'verified-loaded-script-hash', moduleId: '[project]/client/src/app/dashboard/(main)/support-ai/widget-settings/page.tsx [app-client] (ecmascript)', line: 123, column: 18, statement: 'const controller = new AbortController();' };
const widgetFrame = `at WidgetSettingsWorkspace.useEffect (${sourceProof.scriptUrl}:123:18)`;
const fetchFrame = `at WidgetSettingsWorkspace.useEffect (${sourceProof.scriptUrl}:126:18)`;
const abortFrame = `at WidgetSettingsWorkspace.useEffect (${sourceProof.scriptUrl}:156:18)`;
function cleanupAudit(): WidgetRequestAudit {
  return {
    requests: [{ networkRequestId: 'network-1', operationId: 'operation-1', method: 'GET', url }],
    failures: [{ networkRequestId: 'network-1', operationId: 'operation-1', method: 'GET', url, error: 'net::ERR_ABORTED', observedSequence: 4 }],
    events: [
      { stage: 'fetch-start', sequence: 1, observedSequence: 1, operationId: 'operation-1', controllerId: 'controller-1', signalId: 'signal-1', method: 'GET', url, createdStack: widgetFrame, fetchStack: fetchFrame, initiallyAborted: false, createdSource: sourceProof, fetchSource: { ...sourceProof, line: 126, statement: 'api.get("/api/support-widget/token", { signal: controller.signal });' } },
      { stage: 'signal-abort', sequence: 2, observedSequence: 2, operationId: 'operation-1', controllerId: 'controller-1', signalId: 'signal-1', method: 'GET', url, createdStack: widgetFrame, fetchStack: fetchFrame, initiallyAborted: false, fetchState: 'pending', abortStack: `${abortFrame}\ncommitHookEffectListUnmount`, abortSource: { ...sourceProof, line: 156, statement: 'controller.abort();' } },
      { stage: 'fetch-rejected', sequence: 3, observedSequence: 3, operationId: 'operation-1', controllerId: 'controller-1', signalId: 'signal-1', method: 'GET', url, createdStack: widgetFrame, fetchStack: fetchFrame, initiallyAborted: false, errorName: 'AbortError' },
    ],
  };
}

describe('widget cleanup request identity audit', () => {
  it('accepts the exact request, native signal/controller identity and observed React cleanup', () => {
    const audit = cleanupAudit();
    expect(assertOnlyIntentionalWidgetCleanup(audit)).toEqual({ expected: audit.failures, unexpected: [] });
  });

  it('keeps an unrelated later failure at the identical URL fatal', () => {
    const audit = cleanupAudit();
    const unrelated = { networkRequestId: 'network-2', operationId: 'operation-2', method: 'GET', url, error: 'net::ERR_ABORTED', observedSequence: 5 };
    audit.requests.push(unrelated); audit.failures.push(unrelated);
    expect(classifyWidgetRequestFailures(audit)).toEqual({ expected: [audit.failures[0]], unexpected: [unrelated] });
    expect(() => assertOnlyIntentionalWidgetCleanup(audit)).toThrow('network-2');
  });

  it('rejects an unrelated AbortController even when its URL and error match', () => {
    const audit = cleanupAudit();
    audit.events[0].createdStack = 'at unrelatedProbe (page.evaluate:1:1)';
    audit.events[1].abortStack = 'at unrelatedProbe (page.evaluate:2:1)';
    expect(() => assertOnlyIntentionalWidgetCleanup(audit)).toThrow('network-1');
  });

  it.each(['signalId', 'controllerId'] as const)('rejects mismatched %s rather than borrowing another operation cleanup', key => {
    const audit = cleanupAudit(); audit.events[1][key] = 'other-identity';
    expect(() => assertOnlyIntentionalWidgetCleanup(audit)).toThrow('network-1');
  });

  it('rejects duplicate network requests reusing a single operation identity', () => {
    const audit = cleanupAudit(); audit.requests.push({ ...audit.requests[0], networkRequestId: 'network-2' });
    expect(() => assertOnlyIntentionalWidgetCleanup(audit)).toThrow('network-1');
  });

  it('cannot borrow a widget-owned controller to suppress a fetch from another module', () => {
    const audit = cleanupAudit();
    audit.events[0].fetchSource = { ...sourceProof, moduleId: '[project]/unrelated.ts [app-client]', statement: 'api.get("/api/support-widget/token", { signal: sharedSignal });' };
    expect(() => assertOnlyIntentionalWidgetCleanup(audit)).toThrow('network-1');
  });

  it('keeps a genuine widget transport rejection fatal after its later owned cleanup', () => {
    const audit = cleanupAudit();
    audit.events[2].sequence = 2;
    audit.events[2].observedSequence = 2;
    audit.events[2].errorName = 'TypeError';
    audit.failures[0].observedSequence = 3;
    audit.events[1].sequence = 3;
    audit.events[1].observedSequence = 4;
    audit.events[1].fetchState = 'rejected';
    expect(classifyWidgetRequestFailures(audit)).toEqual({ expected: [], unexpected: audit.failures });
    expect(() => assertOnlyIntentionalWidgetCleanup(audit)).toThrow('network-1');
  });

  it.each(['rejection-before-abort', 'failure-before-abort', 'fulfilled-before-abort', 'missing-settlement', 'duplicate-settlement', 'other-error', 'other-settlement-signal', 'other-settlement-controller', 'missing-pending-state'] as const)('rejects %s even with owned request and cleanup identities', change => {
    const audit = cleanupAudit();
    if (change === 'rejection-before-abort') audit.events[2].sequence = 1;
    if (change === 'failure-before-abort') audit.failures[0].observedSequence = 1;
    if (change === 'fulfilled-before-abort') { audit.events[1].fetchState = 'fulfilled'; audit.events[2].stage = 'fetch-fulfilled'; }
    if (change === 'missing-settlement') audit.events.pop();
    if (change === 'duplicate-settlement') audit.events.push({ ...audit.events[2], sequence: 4, observedSequence: 5 });
    if (change === 'other-error') audit.events[2].errorName = 'TypeError';
    if (change === 'other-settlement-signal') audit.events[2].signalId = 'other-signal';
    if (change === 'other-settlement-controller') audit.events[2].controllerId = 'other-controller';
    if (change === 'missing-pending-state') delete audit.events[1].fetchState;
    expect(() => assertOnlyIntentionalWidgetCleanup(audit)).toThrow('network-1');
  });

  it('rejects missing cleanup provenance and non-abort network errors', () => {
    for (const change of ['missing-react-cleanup', 'missing-abort', 'network-error', 'pre-aborted', 'missing-source', 'wrong-module', 'changed-script'] as const) {
      const audit = cleanupAudit();
      if (change === 'missing-react-cleanup') audit.events[1].abortStack = widgetFrame;
      if (change === 'missing-abort') audit.events.splice(1, 1);
      if (change === 'network-error') audit.failures[0].error = 'net::ERR_CONNECTION_RESET';
      if (change === 'pre-aborted') audit.events[0].initiallyAborted = true;
      if (change === 'missing-source') audit.events[0].createdSource = null;
      if (change === 'wrong-module') audit.events[1].abortSource = { ...sourceProof, moduleId: 'unrelated-page', statement: 'controller.abort();' };
      if (change === 'changed-script') audit.events[1].abortSource = { ...sourceProof, scriptSha256: 'other-script', statement: 'controller.abort();' };
      expect(() => assertOnlyIntentionalWidgetCleanup(audit)).toThrow('network-1');
    }
  });

  it('resolves hashed loaded-script frames to the owning module and exact statement', () => {
    const scriptUrl = sourceProof.scriptUrl;
    const source = [
      '"[project]/unrelated.tsx [app-client] (ecmascript)", ((__turbopack_context__) => {',
      'const unrelated = new AbortController();',
      `"${sourceProof.moduleId}", ((__turbopack_context__) => {`,
      'const controller = new AbortController();',
      'controller.abort();',
    ].join('\n');
    const frame = `at WidgetSettingsWorkspace.useEffect (${scriptUrl}:4:20)`;
    expect(widgetEffectSourceProof(frame, scriptUrl, source)).toEqual(expect.objectContaining({ moduleId: sourceProof.moduleId, line: 4, column: 20, statement: 'const controller = new AbortController();' }));
    expect(widgetEffectSourceProof(frame, 'http://127.0.0.1:3000/other.js', source)).toBeNull();
    expect(widgetEffectSourceProof(`at unrelated (${scriptUrl}:2:20)`, scriptUrl, source)).toBeNull();
  });
});
