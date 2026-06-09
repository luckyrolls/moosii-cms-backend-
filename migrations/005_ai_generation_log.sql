-- 005_ai_generation_log.sql
-- Captures every AI API call made during content generation for debugging
-- and regression tracing. Do NOT apply from code — run in Supabase Studio.

CREATE TABLE ai_generation_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  correlation_id UUID,           -- groups multi-step generations within one handler call
  operation TEXT NOT NULL,       -- e.g. image_prompt_generate, image_generate, lesson_generate
  prompt TEXT NOT NULL,
  response JSONB NOT NULL,
  model TEXT,
  latency_ms INTEGER,
  related_entity_type TEXT,
  related_entity_id UUID,
  notes TEXT
);

CREATE INDEX idx_ai_gen_log_entity ON ai_generation_log (related_entity_type, related_entity_id);
CREATE INDEX idx_ai_gen_log_correlation ON ai_generation_log (correlation_id);
CREATE INDEX idx_ai_gen_log_created ON ai_generation_log (created_at DESC);
