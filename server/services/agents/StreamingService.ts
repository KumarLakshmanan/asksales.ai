import type { LLMProvider, LLMStreamOptions } from './LLMProvider.js';

export class StreamingService {
  /**
   * Transforms callback-based LLM streaming into an ES2022 AsyncIterable<string>
   */
  static createAsyncIterable(
    provider: LLMProvider,
    options: Omit<LLMStreamOptions, 'onChunk' | 'onComplete' | 'onError'>
  ): AsyncIterable<string> {
    const queue: string[] = [];
    let isDone = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let streamError: any = null;
    let pendingResolve: (() => void) | null = null;

    const push = (chunk: string) => {
      queue.push(chunk);
      if (pendingResolve) {
        pendingResolve();
        pendingResolve = null;
      }
    };

    const finish = () => {
      isDone = true;
      if (pendingResolve) {
        pendingResolve();
        pendingResolve = null;
      }
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fail = (err: any) => {
      streamError = err;
      isDone = true;
      if (pendingResolve) {
        pendingResolve();
        pendingResolve = null;
      }
    };

    // Initiate the streaming loop
    provider.createChatCompletionStream({
      ...options,
      onChunk: (chunk: string) => {
        if (chunk) push(chunk);
      },
      onComplete: () => {
        finish();
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onError: (err: any) => {
        fail(new Error(err));
      },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }).catch((err: any) => {
      fail(err);
    });

    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            while (queue.length === 0 && !isDone) {
              await new Promise<void>((resolve) => {
                pendingResolve = resolve;
              });
            }

            if (queue.length > 0) {
              return { value: queue.shift()!, done: false };
            }

            if (streamError) {
              throw streamError;
            }

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return { value: undefined as any, done: true };
          },
        };
      },
    };
  }
}
