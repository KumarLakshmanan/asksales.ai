declare module 'pdf-parse' {
  type PdfParseResult = {
    text?: string;
    numpages?: number;
    numrender?: number;
    info?: Record<string, unknown>;
    metadata?: unknown;
    version?: string;
  };

  function parsePdf(dataBuffer: Buffer | Uint8Array): Promise<PdfParseResult>;

  export = parsePdf;
}
