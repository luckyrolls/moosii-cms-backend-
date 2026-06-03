export interface ImageResult {
  bytes: Buffer;
  mimeType: string;
  model: string;
  version: string;
  raw: unknown;
}

export interface ImageGenerator {
  name: string;
  generate(prompt: string): Promise<ImageResult>;
}
