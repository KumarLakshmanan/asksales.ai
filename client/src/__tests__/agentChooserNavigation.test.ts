import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// Exercise the page's real callback without mocking the entire campaign page.
const source = readFileSync(resolve(process.cwd(), 'src/app/dashboard/(main)/conversations/[[...threadId]]/page.tsx'), 'utf8');
const parsed = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let handler: ts.Expression | undefined;
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === 'openAgentChooseTab') handler = node.initializer;
  ts.forEachChild(node, visit);
}
visit(parsed);
if (!handler) throw new Error('Missing chooser callback');
const javascript = ts.transpileModule(`const open = ${handler.getText(parsed)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

describe('agent chooser visibility', () => {
  it.each([false, true])('reveals the result pane with an existing tab=%s', existing => {
    const context = {
      tabs: existing ? [{ id: 'agents-1', type: 'agentchoose' }] : [], activeTab: 'agents-1',
      setChatViewMode: vi.fn(), setResultPanelOpen: vi.fn(), setMobilePane: vi.fn(),
      triggerTabHighlight: vi.fn(), switchTab: vi.fn(), addTab: vi.fn(),
    };
    const open = new Function(...Object.keys(context), `${javascript}\nreturn open;`)(...Object.values(context));
    open();
    expect(context.setChatViewMode).toHaveBeenCalledWith('overview');
    expect(context.setResultPanelOpen).toHaveBeenCalledWith(true);
    expect(context.setMobilePane).toHaveBeenCalledWith('results');
    if (existing) {
      expect(context.switchTab).toHaveBeenCalledWith('agents-1');
      expect(context.addTab).not.toHaveBeenCalled();
    } else expect(context.addTab).toHaveBeenCalledWith('agentchoose', 'Choose Agent', true);
  });
});
