import { describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fetchIncrementalMessages } from '../controllers/gmailWebhookController.js';

describe('Gmail inbound reply synchronization', () => {
  const message = (id: string) => ({ data: { id, threadId: `thread-${id}`, internalDate: '1723982400000',
    labelIds: ['INBOX'], payload: { mimeType: 'text/plain',
      headers: [{ name: 'From', value: 'recipient@example.com' }, { name: 'Subject', value: 'New enquiry' }],
      body: { data: Buffer.from('Interested in a stay').toString('base64') } } } });

  it.each([404, 410])('skips a removed history message (%s) and processes later additions without scanning the inbox', async code => {
    const list = jest.fn<() => Promise<any>>();
    const get = jest.fn<() => Promise<any>>()
      .mockRejectedValueOnce({ response: { status: code } })
      .mockResolvedValueOnce(message('new-enquiry'));
    const gmail = { users: {
      history: { list: jest.fn<() => Promise<any>>().mockResolvedValue({ data: { history: [
        { messagesAdded: [{ message: { id: 'deleted-draft' } }, { message: { id: 'new-enquiry' } }] },
      ] } }) }, messages: { get, list },
    } };
    expect((await fetchIncrementalMessages(7, gmail as never, '100')).map(m => m.id)).toEqual(['new-enquiry']);
    expect(list).not.toHaveBeenCalled();
  });

  it.each([401, 403, 429, 500])('preserves a message-fetch failure (%s) instead of advancing or falling back', async code => {
    const failure = { code };
    const list = jest.fn<() => Promise<any>>();
    const gmail = { users: {
      history: { list: jest.fn<() => Promise<any>>().mockResolvedValue({ data: { history: [
        { messagesAdded: [{ message: { id: 'new-enquiry' } }] },
      ] } }) }, messages: { get: jest.fn<() => Promise<any>>().mockRejectedValue(failure), list },
    } };
    await expect(fetchIncrementalMessages(7, gmail as never, '100')).rejects.toBe(failure);
    expect(list).not.toHaveBeenCalled();
  });

  it('falls back for an expired history cursor and tolerates a deletion during that scan', async () => {
    const list = jest.fn<() => Promise<any>>().mockResolvedValue({ data: { messages: [
      { id: 'removed-during-scan' }, { id: 'new-enquiry' },
    ] } });
    const gmail = { users: {
      history: { list: jest.fn<() => Promise<any>>().mockRejectedValue({ code: 404 }) },
      messages: { list, get: jest.fn<() => Promise<any>>()
        .mockRejectedValueOnce({ code: 404 }).mockResolvedValueOnce(message('new-enquiry')) },
    } };
    expect((await fetchIncrementalMessages(7, gmail as never, '100')).map(m => m.id)).toEqual(['new-enquiry']);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('collects message additions from every Gmail history page', async () => {
    const historyList = jest
      .fn<(args: { pageToken?: string }) => Promise<{ data: {
        history: Array<{ messagesAdded: Array<{ message: { id: string } }> }>;
        nextPageToken?: string;
      } }>>()
      .mockResolvedValueOnce({
        data: {
          history: [{ messagesAdded: [{ message: { id: 'message-1' } }] }],
          nextPageToken: 'page-2',
        },
      })
      .mockResolvedValueOnce({
        data: {
          history: [{ messagesAdded: [{ message: { id: 'message-2' } }] }],
        },
      });
    const messageGet = jest.fn(async ({ id }: { id: string }) => ({
      data: {
        id,
        threadId: `thread-${id}`,
        internalDate: '1723982400000',
        labelIds: ['INBOX'],
        payload: {
          headers: [
            { name: 'From', value: 'Recipient <recipient@example.com>' },
            { name: 'To', value: 'owner@example.com' },
            { name: 'Subject', value: 'Re: Hello' },
          ],
          mimeType: 'text/plain',
          body: { data: Buffer.from(`body-${id}`).toString('base64') },
        },
      },
    }));
    const gmail = {
      users: {
        history: { list: historyList },
        messages: { get: messageGet },
      },
    };

    const messages = await fetchIncrementalMessages(7, gmail as never, '100');

    expect(historyList).toHaveBeenNthCalledWith(1, expect.objectContaining({
      startHistoryId: '100',
      pageToken: undefined,
    }));
    expect(historyList).toHaveBeenNthCalledWith(2, expect.objectContaining({
      startHistoryId: '100',
      pageToken: 'page-2',
    }));
    expect(messages.map((message) => message.id)).toEqual(['message-1', 'message-2']);
  });

  it('keeps the fallback Gmail scanner wired to a real OAuth client', () => {
    const source = readFileSync(new URL('../services/gmailApiService.ts', import.meta.url), 'utf8');

    expect(source).toContain('private async getGmailClient(userId: number)');
    expect(source).toContain("google.gmail({ version: 'v1', auth: clientResult.client, retry: false, timeout: 30_000 })");
    expect(source).toContain('guardGmailClient(');
    expect(source).not.toContain('this.getGmailClient(userId); // missing');
  });
});
