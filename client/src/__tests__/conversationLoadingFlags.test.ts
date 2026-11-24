import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

// Runs the page's actual handlers (extracted from source) against mocked
// state setters, like conversationThreadLoadRecovery.test.ts.
const source = readFileSync(resolve(process.cwd(), 'src/app/dashboard/(main)/conversations/[[...threadId]]/page.tsx'), 'utf8');
const parsed = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function extract(name: string): string {
  let found: ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  if (!found) throw new Error(`Expected the page's ${name}`);
  return ts.transpileModule(found.getText(parsed), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
}

// Unknown identifiers resolve to recorded state setters / no-op mocks; real
// globals (Date, Set, Promise…) and explicitly provided values win.
function load<T>(name: string, provided: Record<string, unknown>) {
  const calls: Record<string, unknown[]> = {};
  const scope = new Proxy(provided, {
    has: (target, key) => typeof key === 'string' && (key in target || !(key in globalThis)),
    get: (target, key) => {
      if (typeof key !== 'string') return undefined;
      if (key in target) return target[key];
      if (key.endsWith('Ref')) return (target[key] = { current: null });
      return (target[key] = vi.fn((value: unknown) => { (calls[key] ??= []).push(value); }));
    },
  });
  // eslint-disable-next-line no-new-func
  const fn = new Function('scope', `with (scope) { ${extract(name)}\nreturn ${name}; }`)(scope) as T;
  return { fn, calls, scope: provided };
}

it('starting a new chat clears the message loading state left by an aborted thread load', () => {
  const abort = vi.fn();
  const { fn, calls } = load<() => void>('handleNewThread', {
    threadLoadAbortRef: { current: { abort } },
    olderMessagesAbortRef: { current: { abort: vi.fn() } },
    threadLoadGenerationRef: { current: 3 },
    router: { push: vi.fn() },
  });
  fn();
  expect(abort).toHaveBeenCalled();
  expect(calls.setIsLoadingMessages).toEqual([false]);
  expect(calls.setIsLoadingOlderMessages).toEqual([false]);
});

it('a thread switch that aborts an older-messages read does not leave that read marked as loading', async () => {
  let rejectRead!: (error: unknown) => void;
  const olderMessagesAbortRef = { current: null as AbortController | null };
  const currentThreadIdRef = { current: 7 as number | null };
  const { fn, calls } = load<() => Promise<void>>('handleLoadOlderMessages', {
    currentThreadId: 7, olderMessageCursor: 40, isLoadingOlderMessages: false,
    olderMessagesAbortRef, currentThreadIdRef,
    api: { get: vi.fn(() => new Promise((_, reject) => { rejectRead = reject; })) },
  });
  const reading = fn();
  // The user opens another conversation: handleThreadSelect aborts the read.
  currentThreadIdRef.current = 8;
  olderMessagesAbortRef.current?.abort();
  rejectRead(new DOMException('Request cancelled', 'AbortError'));
  await reading;
  expect(calls.setIsLoadingOlderMessages).toEqual([true, false]);
  expect(olderMessagesAbortRef.current).toBeNull();
});
