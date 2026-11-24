import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AgentChooseTab from '@/components/tabs/AgentChooseTab';
import { AGENT_HIRE_TAB_MAP, getTabLabel } from '@/lib/tabConfig';

vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/contexts/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe: () => () => {} }) }));
vi.mock('@/contexts/AgentContext', () => ({ useAgent: () => ({ selectedAgent: null, setSelectedAgent: vi.fn() }) }));
afterEach(cleanup);

// Execute the page's actual JSX callback with a rendered chooser. The complete
// conversation page/server action pipeline is not mounted in this client test.
const source = readFileSync(resolve(process.cwd(), 'src/app/dashboard/(main)/conversations/[[...threadId]]/page.tsx'), 'utf8');
const parsed = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let hire: ts.Expression | undefined;
let typeMap: ts.Expression | undefined;
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === 'AGENT_HIRE_TYPE_MAP') typeMap = node.initializer;
  if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(parsed) === 'AgentChooseTab') {
    const attribute = node.attributes.properties.find(item => ts.isJsxAttribute(item) && item.name.getText(parsed) === 'onHireAgent');
    if (attribute && ts.isJsxAttribute(attribute) && attribute.initializer && ts.isJsxExpression(attribute.initializer)) hire = attribute.initializer.expression;
  }
  ts.forEachChild(node, visit);
}
visit(parsed);
if (!hire || !typeMap) throw new Error('Missing actual agent-hire callback/map');
const javascript = ts.transpileModule(`const AGENT_HIRE_TYPE_MAP = ${typeMap.getText(parsed)}; const callback = ${hire.getText(parsed)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
function fixture() {
  const context = {
    api: { post: vi.fn().mockResolvedValue({ success: true }) },
    ensureCampaignThread: vi.fn().mockResolvedValue(42), agents: [{ id: 'content-studio', name: 'Alex Chen' }],
    AGENT_HIRE_TAB_MAP, getTabLabel, addTab: vi.fn(), toast: vi.fn(),
  };
  const callback = new Function(...Object.keys(context), `${javascript}\nreturn callback;`)(...Object.values(context));
  render(<AgentChooseTab onHireAgent={callback} />);
  return context;
}

describe('Content chooser actual call connectivity', () => {
  it('executes the real parent callback through Start Alex and uses HIRE_AGENT, not the legacy plan metadata', async () => {
    const context = fixture();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Start Alex' })); });
    expect(context.ensureCampaignThread).toHaveBeenCalledTimes(1);
    expect(context.api.post).toHaveBeenCalledExactlyOnceWith('/api/chat/langgraph/action', { threadId: 42, action: 'HIRE_AGENT', data: { agentType: 'content_studio' } });
    expect(context.addTab).toHaveBeenCalledWith(AGENT_HIRE_TAB_MAP['content-studio'].tabType, expect.any(String), true, true);
  });
  it('selecting the Content card does not execute its endpoint metadata', () => {
    const context = fixture();
    fireEvent.click(screen.getByText('Alex Chen'));
    expect(context.api.post).not.toHaveBeenCalled();
    expect(context.ensureCampaignThread).not.toHaveBeenCalled();
  });
});
