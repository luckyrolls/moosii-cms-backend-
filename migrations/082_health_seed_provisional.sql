-- ============================================================================
-- MIGRATION 082 (child health H2): PROVISIONAL seed — red flags, urgency rules, response copy
--   — APPLIED moosii 2026-09-15   *** MOOSII ONLY *** (financial has no children or classify traffic)
-- ============================================================================
-- DATA, not schema. Every row is_provisional = true and awaits clinical review
-- (docs/provisional-clinical-decisions.md H-D1..H-D9). Seeded from AAP when-to-call guidance,
-- pages fetched 2026-09-15:
--   [F]   AAP, Fever: When to Call the Pediatrician
--         healthychildren.org/English/health-issues/conditions/fever/Pages/When-to-Call-the-Pediatrician.aspx
--   [ER]  AAP, Urgent Care, ER or Pediatrician? A Parent Guide
--         healthychildren.org/English/family-life/health-management/Pages/urgent-care-ER-or-pediatrician-a-parent-guide.aspx
--   [EMS] AAP, When to Call Emergency Medical Services
--         healthychildren.org/English/health-issues/injuries-emergencies/Pages/When-to-Call-Emergency-Medical-Services-EMS.aspx
--   [DH]  AAP, Signs of Dehydration in Infants & Children
--         healthychildren.org/English/health-issues/injuries-emergencies/Pages/dehydration.aspx
--   poisoning: "AAP poison guidance — verify page" (decided by Mark 2026-09-15; not on the fetched pages)
--
-- BAND MAPPING (H-D1): AAP "ER / call 911" -> emergency; "call your doctor right away" and
-- "urgent care" -> same_day; "call pediatrician same/next day" and "manage at home" -> routine.
-- Where two AAP pages disagree, the HIGHER band (conservative-upward, like D2).
--
-- HOW RULES RESOLVE (code, src/classify/healthUrgency.ts; H-D2..H-D5): for each finding, a rule
-- matches when the age fits [min, max) — or ANY age when the child's age is unknown — the
-- temperature is >= min_temperature_c OR NOT STATED (a fever without a temperature meets the
-- threshold), and the duration is >= min_duration_hours (an unstated duration NEVER matches). The
-- highest band across all matches wins. A recognised flag with no matching rule -> routine.
--
-- APPLY per migrations/README.md: MOOSII only. Idempotent: ON CONFLICT DO NOTHING.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PRE-CHECK
-- 1. 080 and 081 applied — EXPECT three not-NULL:
--    SELECT to_regclass('public.health_red_flags'), to_regclass('public.health_urgency_rules'), to_regclass('public.health_responses');
-- 2. This is Moosii — EXPECT 'moosii':  SELECT value FROM app_settings WHERE key = 'domain';
-- 3. Row counts before (0 on a first run): SELECT (SELECT count(*) FROM health_red_flags),
--    (SELECT count(*) FROM health_urgency_rules), (SELECT count(*) FROM health_responses);
-- ---------------------------------------------------------------------------

BEGIN;

INSERT INTO public.health_red_flags (key, label, description, uses_temperature, uses_duration, source_ref) VALUES
('fever', 'Fever',
 'The child has a fever or a raised temperature, or the parent says the child is running a fever. Record the temperature exactly as written if one is given, and the duration only if one is stated.',
 true, true, '[F] [ER]'),
('breathing_severe', 'Severe breathing trouble',
 'Blue or gray lips, tongue or face; the chest pulling in between the ribs or at the collarbone; cannot speak in full sentences or seems panicked while breathing.',
 false, false, '[ER] "Lips, tongue or face are blue or gray"; "retractions"; "Can''t speak in full sentences or seems panicked"'),
('breathing_fast_alert', 'Fast or labored breathing, still alert',
 'Breathing fast or labored, but the child is still alert and interacting.',
 false, false, '[ER] urgent care: "Fast breathing or labored breathing but still alert and interacting"'),
('unresponsive_or_extreme_sleepiness', 'Unresponsive or extremely sleepy',
 'The child is unresponsive, very hard to wake, limp, or extremely sleepy.',
 false, false, '[ER] fever with "unresponsiveness or extreme sleepiness"; [EMS]'),
('seizure_new', 'Seizure',
 'A seizure or fit: abnormal body movements or stiffening with loss of consciousness.',
 false, false, '[ER] "Any abnormal body movements or stiffening with a loss of consciousness in a child without a previously known seizure disorder"; [F] "Has had a seizure"'),
('purple_rash', 'Purple or bruise-like rash',
 'A purple or bruise-like rash or small purple/red spots that appeared suddenly or are not from an injury.',
 false, false, '[ER] "Purple or bruise-like rash that appears suddenly"; [EMS]'),
('stiff_neck', 'Stiff neck',
 'A stiff neck, especially with fever or sensitivity to light.',
 false, false, '[ER] fever with "stiff neck and sensitivity to light"; [F] "stiff neck"'),
('head_injury_serious', 'Head injury with warning signs',
 'A head injury followed by vomiting, confusion, a seizure, or loss of consciousness.',
 false, false, '[ER] "Head injury with vomiting, confusion, seizure or loss of consciousness"'),
('dehydration_severe', 'Severe dehydration',
 'Prolonged vomiting and/or diarrhea where the child is too weak or too drowsy to drink.',
 false, false, '[ER] "Prolonged vomiting and/or diarrhea; child is too weak or drowsy to drink"'),
('dehydration_signs', 'Signs of dehydration',
 'Fewer wet diapers than usual (fewer than six a day), a dry mouth, few or no tears when crying, or a sunken soft spot on the head.',
 false, false, '[DH] "fewer than six wet diapers per day", "parched dry mouth", "fewer tears", "sunken soft spot"'),
('repeated_vomiting_diarrhea', 'Repeated vomiting or diarrhea',
 'Vomiting or diarrhea over and over.',
 false, false, '[F] "repeated vomiting or diarrhea" (call right away)'),
('looks_very_ill', 'Looks very ill',
 'The child looks very ill, is unusually drowsy, or is very fussy.',
 false, false, '[F] "Looks very ill, is unusually drowsy, or is very fussy"'),
('severe_abdominal_pain', 'Severe belly pain',
 'Severe belly or abdominal pain.',
 false, false, '[ER] "Severe Abdominal Pain"'),
('severe_head_throat_ear_pain', 'Severe head, throat or ear pain',
 'A severe headache, a severe sore throat, or severe ear pain.',
 false, false, '[F] "severe headache, severe sore throat, severe ear pain"'),
('allergic_reaction_mild', 'Allergic reaction without breathing trouble',
 'Swelling, hives or a rash after something the child may be allergic to, without any breathing trouble.',
 false, false, '[ER] urgent care: "Suspected allergic reaction" with swelling, rash, or hives'),
('injury_deformity_or_heavy_bleeding', 'Serious injury',
 'A bone that is visibly bent or sticking out, or heavy bleeding.',
 false, false, '[ER] bone "visibly bent or sticking out"'),
('injury_needs_care', 'Injury needing care',
 'A cut that may need stitches, or a possible broken bone without visible deformity.',
 false, false, '[ER] urgent care: "Cut that needs stitches"; suspected fracture "without obvious deformity"'),
('overheated', 'Overheated',
 'The child has been in a very hot place, such as an overheated car.',
 false, false, '[F] "Has been in a very hot place, such as an overheated car"'),
('poisoning_ingestion', 'Swallowed something harmful',
 'The child swallowed or was exposed to medicine, a household chemical, or another possibly poisonous substance.',
 false, false, 'AAP poison guidance — verify page'),
('mild_illness', 'Mild illness',
 'Mild cold symptoms, a mild rash, bug bites, or mild diaper rash, with the child otherwise acting well.',
 false, false, '[ER] safe to manage at home')
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.health_urgency_rules
  (rule_key, red_flag_key, min_age_months, max_age_months, min_temperature_c, min_duration_hours, band, source_ref, notes) VALUES
('fever_under_3mo', 'fever', 0, 3, 38.0, NULL, 'emergency',
 '[ER] "A baby under 3 months old with temperature of 100.4°F (38°C) or higher"',
 '[F] says call right away; [ER] lists it under ER — the higher band is used (H-D1). A fever with no stated temperature meets the threshold (H-D2).'),
('fever_40c_any_age', 'fever', 0, NULL, 40.0, NULL, 'same_day',
 '[F] "Temperature rises above 104°F (40°C) repeatedly"',
 'A single report counts as "repeatedly", and a fever with no stated temperature meets the threshold (H-D2) — so an unstated fever at 3+ months resolves same_day.'),
('fever_24h_under_2y', 'fever', 0, 24, NULL, 24, 'same_day',
 '[F] "Fever persists for more than 24 hours in a child younger than 2 years"',
 'An unstated duration never matches (H-D2).'),
('fever_72h_2y_plus', 'fever', 24, NULL, NULL, 72, 'same_day',
 '[F] "Fever persists for more than 3 days (72 hours) in a child 2 years of age or older"; [ER] "Fever lasting more than 3 days"',
 'An unstated duration never matches (H-D2).'),
('fever_3mo_plus', 'fever', 3, NULL, NULL, NULL, 'routine',
 '[ER] safe at home: "Fever with mild cold symptoms and good energy"', NULL),
('breathing_severe_any', 'breathing_severe', 0, NULL, NULL, NULL, 'emergency', '[ER] breathing difficulty — call 911', NULL),
('breathing_fast_alert_any', 'breathing_fast_alert', 0, NULL, NULL, NULL, 'same_day', '[ER] urgent care — fast/labored breathing, still alert', NULL),
('unresponsive_any', 'unresponsive_or_extreme_sleepiness', 0, NULL, NULL, NULL, 'emergency', '[ER] unresponsiveness or extreme sleepiness; [EMS]', NULL),
('seizure_new_any', 'seizure_new', 0, NULL, NULL, NULL, 'emergency', '[ER] seizure without a known seizure disorder — ER/911', NULL),
('purple_rash_any', 'purple_rash', 0, NULL, NULL, NULL, 'emergency', '[ER] purple or bruise-like rash; [EMS] "call 911"', NULL),
('stiff_neck_any', 'stiff_neck', 0, NULL, NULL, NULL, 'emergency', '[ER] fever with stiff neck and sensitivity to light', NULL),
('head_injury_serious_any', 'head_injury_serious', 0, NULL, NULL, NULL, 'emergency', '[ER] head injury with vomiting, confusion, seizure or loss of consciousness', NULL),
('dehydration_severe_any', 'dehydration_severe', 0, NULL, NULL, NULL, 'emergency', '[ER] too weak or drowsy to drink', NULL),
('dehydration_signs_any', 'dehydration_signs', 0, NULL, NULL, NULL, 'same_day', '[DH] signs of dehydration — call the doctor', NULL),
('repeated_vomiting_diarrhea_any', 'repeated_vomiting_diarrhea', 0, NULL, NULL, NULL, 'same_day', '[F] repeated vomiting or diarrhea — call right away', NULL),
('looks_very_ill_any', 'looks_very_ill', 0, NULL, NULL, NULL, 'same_day', '[F] looks very ill / unusually drowsy / very fussy — call right away', NULL),
('severe_abdominal_pain_any', 'severe_abdominal_pain', 0, NULL, NULL, NULL, 'emergency', '[ER] severe abdominal pain', NULL),
('severe_head_throat_ear_pain_any', 'severe_head_throat_ear_pain', 0, NULL, NULL, NULL, 'same_day', '[F] severe headache / sore throat / ear pain — call right away', NULL),
('allergic_reaction_mild_any', 'allergic_reaction_mild', 0, NULL, NULL, NULL, 'same_day', '[ER] urgent care — suspected allergic reaction', NULL),
('injury_serious_any', 'injury_deformity_or_heavy_bleeding', 0, NULL, NULL, NULL, 'emergency', '[ER] bone visibly bent or sticking out', NULL),
('injury_needs_care_any', 'injury_needs_care', 0, NULL, NULL, NULL, 'same_day', '[ER] urgent care — stitches / suspected fracture without deformity', NULL),
('overheated_any', 'overheated', 0, NULL, NULL, NULL, 'same_day', '[F] overheated — call right away', NULL),
('poisoning_ingestion_any', 'poisoning_ingestion', 0, NULL, NULL, NULL, 'emergency', 'AAP poison guidance — verify page', 'Poison Control 1-800-222-1222 in the emergency copy (H-D8).'),
('mild_illness_any', 'mild_illness', 0, NULL, NULL, NULL, 'routine', '[ER] safe to manage at home', NULL)
ON CONFLICT (rule_key) DO NOTHING;

-- Neutral app voice, no first-person "I" (D12).
INSERT INTO public.health_responses (band, message, resources) VALUES
('emergency',
 $m$What you're describing can be a sign your child needs care right away. Please call 911 or go to the nearest emergency room now. If you're not sure, it's always okay to call.$m$,
 '[{"label":"Emergency services","value":"911","kind":"phone"},{"label":"Poison Control (24/7)","value":"1-800-222-1222","kind":"phone"}]'::jsonb),
('same_day',
 $m$This is worth a call to your child's doctor today. If it's after hours, most offices have a nurse line. If things get worse — trouble breathing, very hard to wake, or can't keep fluids down — go to the emergency room.$m$,
 '[{"label":"Emergency services","value":"911","kind":"phone"}]'::jsonb),
('routine',
 $m$Thanks for letting us know. This sounds like something to watch at home and mention to your child's doctor if it continues. When in doubt, call your pediatrician's office.$m$,
 '[]'::jsonb)
ON CONFLICT (band) DO NOTHING;

COMMIT;

-- ============================================================================
-- VERIFICATION — EXPECT 20 flags, 24 rules (all is_provisional), 3 responses (all is_provisional);
-- every rule's flag exists; exactly one fever rule is emergency (under 3 months).
-- ============================================================================
