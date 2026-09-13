import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { JWT } from "npm:google-auth-library@9";
// ----------------------
// Logging helpers
// ----------------------
function ts() {
  return new Date().toISOString();
}
function log(stage, msg, extra) {
  const payload = extra ? ` | ${JSON.stringify(extra)}` : "";
  console.log(`[${ts()}] [${stage}] ${msg}${payload}`);
}
function warn(stage, msg, extra) {
  const payload = extra ? ` | ${JSON.stringify(extra)}` : "";
  console.warn(`[${ts()}] [${stage}] ${msg}${payload}`);
}
function err(stage, msg, extra) {
  const payload = extra ? ` | ${JSON.stringify(extra)}` : "";
  console.error(`[${ts()}] [${stage}] ${msg}${payload}`);
}
// ----------------------
// Init Supabase client
// ----------------------
const supabaseUrl = Deno.env.get("SUPABASE_URL");
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const supabase = createClient(supabaseUrl, supabaseServiceKey);
// ----------------------
// Random-row helper (no RPC)
// ----------------------
async function getRandomTemplateText(table, opts = {}) {
  const stage = "getRandomTemplateText";
  const maxRetries = opts.maxRetries ?? 3;
  for(let attempt = 1; attempt <= maxRetries; attempt++){
    try {
      const { count, error: countErr } = await supabase.from(table).select("*", {
        count: "exact",
        head: true
      });
      if (countErr) {
        err(stage, "Count failed", {
          table,
          attempt,
          ...countErr
        });
        continue;
      }
      if (!count || count <= 0) {
        warn(stage, "No rows to choose from", {
          table,
          attempt
        });
        return null;
      }
      const offset = Math.floor(Math.random() * count);
      const { data, error: rowErr } = await supabase.from(table).select("template_text").order("id", {
        ascending: true
      }).range(offset, offset).maybeSingle();
      if (rowErr) {
        err(stage, "Row fetch failed", {
          table,
          attempt,
          offset,
          ...rowErr
        });
        continue;
      }
      if (data?.template_text) {
        log(stage, "Random row fetched", {
          table,
          attempt,
          offset,
          preview: data.template_text.slice(0, 80)
        });
        return data.template_text;
      }
      warn(stage, "Empty result at offset — retrying", {
        table,
        attempt,
        offset
      });
    } catch (e) {
      err(stage, "Unexpected error", {
        table,
        attempt,
        error: e.message
      });
    }
  }
  warn(stage, "Exhausted retries", {
    table,
    maxRetries
  });
  return null;
}
// ----------------------
// Lesson/Streak template logic
// ----------------------
async function getCompletedItemNames(userId) {
  const { data, error } = await supabase.from("completed_items").select("item_name").eq("user_id", userId);
  if (error) return new Set();
  return new Set((data ?? []).map((r)=>r.item_name).filter(Boolean));
}
async function getNextLesson(userId) {
  const completed = await getCompletedItemNames(userId);
  const PAGE_SIZE = 50;
  let offset = 0;
  for(let page = 0; page < 10; page++){
    const { data, error } = await supabase.from("user_mlp").select("item_name").eq("user_id", userId).order("position", {
      ascending: true
    }).range(offset, offset + PAGE_SIZE - 1);
    if (error || !data?.length) return null;
    const next = data.find((r)=>r?.item_name && !completed.has(r.item_name));
    if (next?.item_name) return next.item_name;
    offset += PAGE_SIZE;
  }
  return null;
}
async function isUserStreakActive(userId) {
  const { data, error } = await supabase.from("completed_items_streak").select("streak_dates").eq("user_id", userId).maybeSingle();
  if (error || !data?.streak_dates) return false;
  const streakDates = data.streak_dates.map((d)=>new Date(d).toDateString());
  const today = new Date().toDateString();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  return streakDates.includes(today) || streakDates.includes(yesterday.toDateString());
}
async function getUserStreakCount(userId) {
  const { data, error } = await supabase.from("completed_items_streak").select("max_unique_weekday_streak").eq("user_id", userId).maybeSingle();
  if (error) return 0;
  return data?.max_unique_weekday_streak || 0;
}
async function getTemplateMessage(userId) {
  const [hasStreak, streakCount, lessonName] = await Promise.all([
    isUserStreakActive(userId),
    getUserStreakCount(userId),
    getNextLesson(userId)
  ]);
  const table = hasStreak ? "continue_streak" : "start_streak";
  const templateText = await getRandomTemplateText(table);
  if (!templateText || !lessonName) {
    return "Here’s your daily nudge from Moosii — keep learning and growing!";
  }
  return templateText.replace("{lesson}", lessonName).replace("{streak}", String(streakCount));
}
// ----------------------
// Push helpers
// ----------------------
async function getAccessToken({ clientEmail, privateKey }) {
  const jwtClient = new JWT({
    email: clientEmail,
    key: privateKey,
    scopes: [
      "https://www.googleapis.com/auth/firebase.messaging"
    ]
  });
  const tokens = await jwtClient.authorize();
  if (!tokens?.access_token) throw new Error("Failed to obtain access token");
  return tokens.access_token;
}
// ----------------------
// Main serve handler
// ----------------------
serve(async (_req)=>{
  const startAt = Date.now();
  let users = [];
  try {
    const { data, error } = await supabase.from("user").select("id, daily_reminder_time, user_offset, fcm_token, allow_daily_reminders_notifications").eq("allow_daily_reminders_notifications", true);
    if (error) return new Response("Supabase query failed", {
      status: 500
    });
    users = data ?? [];
  } catch  {
    return new Response("Supabase query failed", {
      status: 500
    });
  }
  const nowGMT = new Date(new Date().toISOString().slice(0, 19) + "Z");
  nowGMT.setSeconds(0, 0);
  const matchingUsers = users.filter((user)=>{
    if (!user.daily_reminder_time || !user.fcm_token) return false;
    const [hour, minute] = user.daily_reminder_time.split(":").map(Number);
    const scheduled = new Date(nowGMT);
    scheduled.setUTCHours(hour, minute, 0, 0);
    if (user.user_offset != null) scheduled.setMinutes(scheduled.getMinutes() - user.user_offset);
    return scheduled.getUTCHours() === nowGMT.getUTCHours() && scheduled.getUTCMinutes() === nowGMT.getUTCMinutes();
  });
  if (!matchingUsers.length) return new Response("No users to notify", {
    status: 200
  });
  let accessToken;
  try {
    const clientEmail = Deno.env.get("FIREBASE_CLIENT_EMAIL");
    const privateKeyRaw = Deno.env.get("FIREBASE_PRIVATE_KEY");
    if (!clientEmail || !privateKeyRaw) return new Response("Missing Firebase credentials", {
      status: 500
    });
    accessToken = await getAccessToken({
      clientEmail,
      privateKey: privateKeyRaw.replace(/\\n/g, "\n")
    });
  } catch  {
    return new Response("Failed to get access token", {
      status: 500
    });
  }
  const results = [];
  for (const user of matchingUsers){
    let messageBody;
    try {
      messageBody = await getTemplateMessage(String(user.id));
      if (!messageBody?.trim()) {
        results.push({
          userId: user.id,
          status: "skipped_empty_message"
        });
        continue;
      }
    } catch  {
      results.push({
        userId: user.id,
        status: "failed_template"
      });
      continue;
    }
    const fcmPayload = {
      message: {
        token: user.fcm_token,
        notification: {
          title: "📬 Daily Reminder",
          body: messageBody
        },
        data: {
          type: "daily_reminder",
          userId: String(user.id)
        },
        android: {
          priority: "high"
        },
        apns: {
          payload: {
            aps: {
              contentAvailable: true,
              alert: {
                title: "📬 Daily Reminder",
                body: messageBody
              }
            }
          }
        }
      }
    };
    try {
      const res = await fetch(`https://fcm.googleapis.com/v1/projects/${Deno.env.get("FIREBASE_PROJECT_ID")}/messages:send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`
        },
        body: JSON.stringify(fcmPayload)
      });
      const json = await res.json().catch(()=>({}));
      if (!res.ok) {
        results.push({
          userId: user.id,
          status: "failed",
          response: json
        });
        continue;
      }
      results.push({
        userId: user.id,
        status: "sent",
        response: json
      });
    } catch (e) {
      results.push({
        userId: user.id,
        status: "failed",
        error: e.message
      });
    }
  }
  return new Response(JSON.stringify({
    results
  }), {
    headers: {
      "Content-Type": "application/json"
    }
  });
});
