import { createClient } from "@supabase/supabase-js";
import ws from "ws";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("FATAL: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  process.exit(1);
}

export const supabase = createClient(supabaseUrl, supabaseKey, {
  // ws satisfies the interface at runtime; cast suppresses the constructor signature mismatch
  realtime: { transport: ws as unknown as typeof WebSocket },
});
