import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntegrationWorkspace } from '@/components/integrations/IntegrationWorkspace';
import { InstagramOfficialAPI } from '@/app/dashboard/(main)/integrations/instagram/components/InstagramOfficialAPI';
import { FacebookOfficialAPI } from '@/app/dashboard/(main)/integrations/facebook/components/FacebookOfficialAPI';
import { WhatsAppConnection } from '@/app/dashboard/(main)/integrations/whatsapp/components/WhatsAppConnection';

vi.mock('@/lib/api', () => ({ default: { get: vi.fn().mockResolvedValue({}), post: vi.fn() } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
afterEach(cleanup);

describe('one connection action per integration page', () => {
  it.each(['instagram', 'facebook', 'whatsapp'] as const)('%s keeps connection actions in the account header, including with developer details expanded', provider => {
    const account = { connected: true, username: 'Fixture business', tokenExpired: false, expiresAt: null };
    const connect = vi.fn();
    const details = provider === 'instagram'
      ? <InstagramOfficialAPI oauthStatus={{ officialApi: account }} refreshingToken={false} onOAuthConnect={connect} onRefreshToken={vi.fn()} showConnectionActions={false} />
      : provider === 'facebook'
        ? <FacebookOfficialAPI status={{ officialApi: account }} refreshing={false} onConnect={connect} onRefresh={vi.fn()} onDisconnect={vi.fn()} showConnectionActions={false} />
        : <WhatsAppConnection configured settings={{ connectionStatus: 'ready', phoneNumberId: 'fixture', businessAccountId: 'fixture' }} onTest={vi.fn()} testing={false} showConnectionActions={false} />;
    render(<IntegrationWorkspace provider={provider} state="connected" accountName="Fixture business" onConnect={connect} settings={details} />);
    expect(screen.getAllByRole('button', { name: /^Reconnect$/ })).toHaveLength(1);
    expect(screen.queryByTitle(new RegExp(`Reconnect ${provider}`, 'i'))).not.toBeInTheDocument();
    expect(screen.queryByTitle(new RegExp(`Disconnect ${provider}`, 'i'))).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Connect$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Switch.*(Page|profile)/i })).not.toBeInTheDocument();
  });

  it.each(['instagram', 'facebook', 'whatsapp'] as const)('%s keeps the disconnected main action when developer details have no connection controls', async provider => {
    const connect = vi.fn();
    const details = provider === 'instagram'
      ? <InstagramOfficialAPI oauthStatus={null} refreshingToken={false} onOAuthConnect={connect} onRefreshToken={vi.fn()} showConnectionActions={false} />
      : provider === 'facebook'
        ? <FacebookOfficialAPI status={null} refreshing={false} onConnect={connect} onRefresh={vi.fn()} onDisconnect={vi.fn()} showConnectionActions={false} />
        : <WhatsAppConnection configured={false} settings={null} onTest={vi.fn()} testing={false} showConnectionActions={false} />;
    render(<IntegrationWorkspace provider={provider} state="disconnected" onConnect={connect} settings={details} />);
    const buttons = screen.getAllByRole('button', { name: /^(Connect WhatsApp Business|Continue with Instagram|Continue with Facebook)$/ });
    expect(buttons).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /^Connect$/ })).not.toBeInTheDocument();
    await userEvent.click(buttons[0]);
    expect(connect).toHaveBeenCalledOnce();
  });
});
