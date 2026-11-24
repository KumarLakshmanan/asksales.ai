import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/components/ChatInterface.tsx'), 'utf8');
const parsed = ts.createSourceFile('ChatInterface.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let handler: ts.Expression | undefined;
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === 'handleSend') handler = node.initializer;
  ts.forEachChild(node, visit);
}
visit(parsed);
if (!handler) throw new Error('Expected actual ChatInterface send handler');
const handlerSource = ts.transpileModule(`const handleSend = ${handler.getText(parsed)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function harness() {
  const attachment = { localId: 'local-1', fileId: 7, filename: 'review.csv' };
  const ui = { input: '  Keep this draft.  ', attachments: [attachment] };
  const composerRevisionRef = { current: 0 };
  const composerThreadRef = { current: 184 };
  const setInput = vi.fn((value: string) => { composerRevisionRef.current++; ui.input = value; });
  const setPendingAttachments = vi.fn((value: typeof ui.attachments) => { composerRevisionRef.current++; ui.attachments = value; });
  let resolveSend!: (value?: unknown) => void;
  let rejectSend!: (reason: unknown) => void;
  const onSendMessage = vi.fn(() => new Promise((resolve, reject) => { resolveSend = resolve; rejectSend = reject; }));
  const toast = vi.fn();
  const context = { input: ui.input, pendingAttachments: ui.attachments, currentThreadId: 184,
    isProcessing: false, isUploadingAttachments: false, composerRevisionRef, composerThreadRef,
    setInput, setPendingAttachments, onSendMessage, toast };
  const send = new Function(...Object.keys(context), `${handlerSource}\nreturn handleSend;`)(...Object.values(context)) as () => Promise<void>;
  return { ui, context, send, attachment, resolve: (value?: unknown) => resolveSend(value), reject: (reason: unknown) => rejectSend(reason) };
}

describe('failed composer submission recovery', () => {
  it('restores unchanged text and uploaded attachments without resending', async () => {
    const test = harness();
    const sending = test.send();
    expect(test.ui).toEqual({ input: '', attachments: [] });
    expect(test.context.onSendMessage).toHaveBeenCalledWith('Keep this draft.', false, [{ fileId: 7, filename: 'review.csv' }]);
    test.resolve({ delivery: 'unconfirmed' });
    await sending;
    expect(test.ui).toEqual({ input: '  Keep this draft.  ', attachments: [test.attachment] });
    expect(test.context.onSendMessage).toHaveBeenCalledTimes(1);
    expect(test.context.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Delivery not confirmed' }));
  });

  it.each(['new text', 'typed then cleared', 'new attachment'])('does not overwrite subsequent composer edits: %s', async edit => {
    const test = harness();
    const sending = test.send();
    if (edit === 'new attachment') test.context.setPendingAttachments([{ localId: 'new-2', fileId: 8, filename: 'new.csv' }]);
    else {
      test.context.setInput('Newer draft');
      if (edit === 'typed then cleared') test.context.setInput('');
    }
    const edited = structuredClone(test.ui);
    test.resolve({ delivery: 'unconfirmed' });
    await sending;
    expect(test.ui).toEqual(edited);
    expect(test.context.onSendMessage).toHaveBeenCalledTimes(1);
  });

  it('does not restore an old draft into a different campaign', async () => {
    const test = harness();
    const sending = test.send();
    test.context.composerThreadRef.current = 185;
    test.resolve({ delivery: 'unconfirmed' });
    await sending;
    expect(test.ui).toEqual({ input: '', attachments: [] });
  });

  it('keeps the composer clear after a confirmed submission', async () => {
    const test = harness();
    const sending = test.send();
    test.resolve();
    await sending;
    expect(test.ui).toEqual({ input: '', attachments: [] });
    expect(test.context.toast).not.toHaveBeenCalled();
  });

  it('also recovers when a caller rejects instead of returning a typed outcome', async () => {
    const test = harness();
    const sending = test.send();
    test.reject(new TypeError('Failed to fetch'));
    await sending;
    expect(test.ui.input).toBe('  Keep this draft.  ');
    expect(test.ui.attachments).toEqual([test.attachment]);
  });
});
