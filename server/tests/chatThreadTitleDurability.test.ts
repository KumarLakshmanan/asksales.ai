import { readFileSync } from 'node:fs';

describe('chat thread title durability', () => {
  it('checks persisted user messages instead of the restart-volatile history cache', () => {
    const controller = readFileSync(
      new URL('../mastra/chatController.ts', import.meta.url),
      'utf8',
    );
    const messageModel = readFileSync(
      new URL('../models/chatMessages/functions.ts', import.meta.url),
      'utf8',
    );

    expect(controller).toContain('isFirstMessage = !(await hasUserMessageInThread(threadId))');
    expect(controller).not.toContain("chatHistoryManager.getMessages(threadId, 'existing_check')");
    expect(messageModel).toContain('export async function hasUserMessageInThread');
    expect(messageModel).toContain("eq(chatMessagesTable.role, 'user')");
  });
});
