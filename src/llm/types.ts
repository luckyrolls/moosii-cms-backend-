export interface GenerateArgs {
  instructions: string;
  userPrompt: string;
  responseSchema?: object;
}

export interface GenerateResult {
  text: string;
  model: string;
  version: string;
  raw: unknown;
}

export interface LLMClient {
  name: string;
  generate(args: GenerateArgs): Promise<GenerateResult>;
}
