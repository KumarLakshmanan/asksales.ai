/**
 * Module declarations for packages without TypeScript types
 */

declare module '@opentelemetry/resources' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function resourceFromAttributes(attributes: Record<string, any>): any;
}

declare module '@opentelemetry/semantic-conventions' {
  export const ATTR_SERVICE_NAME: string;
  export const ATTR_SERVICE_VERSION: string;
}

declare module '@aws-sdk/client-s3' {
  // Phase 6.12 / TYPE-004: generic `send<C extends S3Command>(command: C)`
  // so callers get the correct response type back rather than `any`.
  // The official `@aws-sdk/client-s3` types already do this — the local
  // declaration existed so the codebase compiles without depending on the
  // upstream `.d.ts` files (which add 100+ KB of types to the build).
  export type S3Command =
    | PutObjectCommand
    | GetObjectCommand
    | DeleteObjectCommand
    | ListObjectsV2Command
    | HeadObjectCommand
    | CopyObjectCommand
    | PutObjectAclCommand;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  export interface S3ResponseFor<C extends S3Command> {
    // Intentionally structural — call sites use `as` only when they need
    // a specific field. Most callers just check the truthy return.
    $metadata: { httpStatusCode: number; requestId?: string };
    [key: string]: unknown;
  }

  export class S3Client {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(config: any);
    send<C extends S3Command>(command: C): Promise<S3ResponseFor<C>>;
  }
  export class PutObjectCommand {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(params: any);
  }
  export class GetObjectCommand {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(params: any);
  }
  export class DeleteObjectCommand {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(params: any);
  }
  export class ListObjectsV2Command {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(params: any);
  }
  export class HeadObjectCommand {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(params: any);
  }
  // New commands added in Phase 6.12 — used by the cross-region copy +
  // public-read workflows the S3 storage layer added in recent sprints.
  export class CopyObjectCommand {
    constructor(params: { Bucket: string; Key: string; CopySource: string });
  }
  export class PutObjectAclCommand {
    constructor(params: { Bucket: string; Key: string; ACL: 'private' | 'public-read' | 'public-read-write' | 'authenticated-read' });
  }
}

declare module '@aws-sdk/s3-request-presigner' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function getSignedUrl(client: any, command: any, options?: any): Promise<string>;
}
