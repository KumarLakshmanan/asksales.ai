import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WidgetDocumentCard, parseWidgetDocuments } from '@/app/support-widget/[token]/WidgetDocumentCard';

const props = { document:{id:8,title:'Day outing brochure'},apiBase:'http://localhost:8188',token:'widget-token',
  sessionId:21,sessionToken:'private-session-token',messageId:42 };
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('displays the approved PDF with an accessible download action and no public file URL', () => {
  render(<WidgetDocumentCard {...props} />);
  expect(screen.getByText('Day outing brochure')).toBeInTheDocument();
  expect(screen.getByRole('button',{name:'Download Day outing brochure (PDF)'})).toBeEnabled();
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
});

it('passes credentials in the POST body, saves PDF bytes and restores the download button', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(new Blob(['%PDF-1.7 example'],{type:'application/pdf'}),
    {status:200,headers:{'content-type':'application/pdf'}}));
  vi.stubGlobal('fetch',fetch);
  const createObjectURL = vi.fn().mockReturnValue('blob:local-pdf');
  vi.stubGlobal('URL',Object.assign(URL,{createObjectURL,revokeObjectURL:vi.fn()}));
  const click = vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(() => {});
  render(<WidgetDocumentCard {...props} />);
  fireEvent.click(screen.getByRole('button'));
  await waitFor(() => expect(click).toHaveBeenCalledOnce());
  expect(fetch).toHaveBeenCalledWith('http://localhost:8188/api/support-widget/session/21/messages/42/documents/8',
    expect.objectContaining({method:'POST',cache:'no-store',body:JSON.stringify({token:props.token,sessionToken:props.sessionToken})}));
  expect(createObjectURL).toHaveBeenCalledOnce();
  expect(screen.getByRole('button')).toBeEnabled();
});

it.each([404,401,503])('shows a recoverable error on %s without removing the card', async status => {
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('{}',{status})));
  render(<WidgetDocumentCard {...props} />);
  fireEvent.click(screen.getByRole('button'));
  await screen.findByRole('alert');
  expect(screen.getByRole('button')).toBeEnabled();
  expect(screen.getByText('Day outing brochure')).toBeInTheDocument();
});

it('rejects a successful non-PDF response and ignores malformed history attachments', async () => {
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('<html/>',{status:200,headers:{'content-type':'text/html'}})));
  render(<WidgetDocumentCard {...props} />);
  fireEvent.click(screen.getByRole('button'));
  await screen.findByRole('alert');
  expect(parseWidgetDocuments({documents:[null,{id:-1,title:'Bad'},{id:'8',title:'Bad'},props.document]})).toEqual([props.document]);
});
