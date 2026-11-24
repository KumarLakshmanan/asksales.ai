import type { Request, Response } from 'express';

export async function dependenciesReady(checks: Array<() => Promise<boolean>>, timeoutMs = 2_000): Promise<boolean> {
  return (await Promise.all(checks.map(async check => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(check).then(Boolean),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
      ]);
    } catch { return false; }
    finally { if (timer) clearTimeout(timer); }
  }))).every(Boolean);
}

export function readinessHandler(checks: Array<() => Promise<boolean>>, draining: () => boolean = () => false) {
  return async (_req: Request, res: Response) => {
    const ready = !draining() && await dependenciesReady(checks) && !draining();
    res.status(ready ? 200 : 503).json({ status: ready ? 'healthy' : 'unhealthy' });
  };
}
