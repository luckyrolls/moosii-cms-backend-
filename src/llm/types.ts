export interface GenerateArgs {
  instructions: string;
  userPrompt: string;
  /** Wraps schema internally as { name: "output", strict: true, schema }. Mutually exclusive with rawJsonSchema. */
  responseSchema?: object;
  /** Full json_schema object { name, strict, schema } passed directly as response_format.json_schema.
   *  Use when the DB row owns the full schema. Mutually exclusive with responseSchema. */
  rawJsonSchema?: object;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface GenerateResult {
  text: string;
  model: string;
  version: string;
  raw: unknown;
  /** OpenAI finish_reason: "stop" | "length" | "content_filter" | etc. Not populated by all providers. */
  finishReason?: string;
}

export interface LLMClient {
  name: string;
  generate(args: GenerateArgs): Promise<GenerateResult>;
}
