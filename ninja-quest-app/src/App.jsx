import React, { useState, useEffect, useMemo } from "react";
import { Menu, Trophy, ClipboardList, Package, Flame, CheckCircle2, Sparkles, X, Sliders, Home, Plus, History, Share2 } from "lucide-react";

/* ============================ reference asset notes ============================
   The ninja's look (red headband + trailing tails, black hood/gi, cream face,
   orange boots, sword) is redesigned off an open-license pixel-ninja asset the
   user provided (Ninja.zip). We rebuilt it as hand-drawn SVG rects rather than
   using the raw PNGs directly, so it stays crisp at any size and recolorable
   per tier/cosmetic (the PNGs are a fixed-resolution sprite sheet, which would
   fight both of those).

   That asset also ships a full pose/animation set we haven't wired up yet —
   noted here for when we build real action states instead of the current
   procedural bob/swing:
     idle_0..3    (4 frames)
     run_0..5     (6 frames)
     attack_0..2  (3 frames) — natural fit for chest-opening or a future combat hit
     jump_0..3    (4 frames) — natural fit for level-up
     swim_0..5    (6 frames)
     x_0..3       (4 frames, likely hurt/knockback or a death/reset animation)
   A consolidated preview sheet of these frames is saved as
   ninja_reference_sheet.png alongside this file for whenever that work starts.
*/

/* ============================ storage ============================ */

// Supabase project config. The anon key is meant to be public -- the actual
// security comes from the Row Level Security policies on the `saves` table
// (see supabase_setup.sql), not from hiding this key.
const SUPABASE_URL = "https://cfuyixkvvtgsntwhgjbn.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNmdXlpeGt2dnRnc250d2hnamJuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgxMTY0OTYsImV4cCI6MjEwMzY5MjQ5Nn0.8M5yFmsNkq7MAZ89ql6MSR6ixu1bmjWq_yi_2VQ1UtE";

// Loaded via a <script> tag in index.html on the real deployed site (see
// README notes), never imported directly -- Claude.ai's artifact preview
// doesn't support arbitrary npm packages, so a static import here would
// break the in-chat experience. When that script isn't present (i.e. we're
// running inside Claude.ai), `window.supabase` is simply undefined and the
// app quietly falls back to its existing window.storage/localStorage path.
const supabase =
  typeof window !== "undefined" && window.supabase
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;

const store = {
  async get(key, fallback) {
    try {
      if (typeof window !== "undefined" && window.storage && window.storage.get) {
        const r = await window.storage.get(key);
        return r && r.value ? JSON.parse(r.value) : fallback;
      }
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  },
  async set(key, value) {
    try {
      if (typeof window !== "undefined" && window.storage && window.storage.set) {
        await window.storage.set(key, JSON.stringify(value));
        return true;
      }
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  },
};

/* ============================ xp / level engine ============================ */

const TIER_NAMES = [
  { name: "Back of the pack", color: "#8FA3C8" },
  { name: "Regular", color: "#4CD07D" },
  { name: "Club runner", color: "#3FB6F5" },
  { name: "Pack leader", color: "#A66BFF" },
  { name: "Front row", color: "#FF9E3D" },
  { name: "Sub-elite", color: "#FF6B8A" },
  { name: "Elite field", color: "#FF5470" },
  { name: "Course record", color: "#FFC53D" },
];
const LEVELS_PER_TIER = 4;
const tierFor = (level) => TIER_NAMES[Math.min(Math.floor((level - 1) / LEVELS_PER_TIER), TIER_NAMES.length - 1)];
const xpForLevel = (level) => 20 + (level - 1) * 9;

function cumulativeToLevel(level) {
  let total = 0;
  for (let l = 1; l < level; l++) total += xpForLevel(l);
  return total;
}

function levelFor(xp) {
  let level = 1;
  let remaining = xp;
  let req = xpForLevel(level);
  while (remaining >= req) {
    remaining -= req;
    level += 1;
    req = xpForLevel(level);
  }
  return { level, into: remaining, span: req, pct: Math.min(100, Math.round((remaining / req) * 100)), tier: tierFor(level) };
}

const STREAK_STEP = 0.01;
const STREAK_CAP = 0.4;
const streakMultiplier = (n) => 1 + Math.min(STREAK_CAP, n * STREAK_STEP);

/* ============================ activity categories & effort system ============================ */

// Five-point scales. Baseline is set at onboarding (and revisable anytime);
// per-log is an optional quick check-in on how a specific log felt. Both are
// bounded so self-report personalizes XP without being able to dominate it.
const EFFORT_LABELS = ["Very easy", "Easy", "Moderate", "Hard", "Very hard"];
const EFFORT_BASELINE_MULT = [0.8, 0.9, 1.0, 1.15, 1.3];
const PERLOG_LABELS = ["Light breeze", "Comfortable", "Steady", "Tough", "Brutal"];
const PERLOG_MULT = [0.9, 0.95, 1.0, 1.1, 1.15];
const EFFORT_MULT_MIN = 0.7;
const EFFORT_MULT_MAX = 1.4;

function effortMultiplier(baselineRating, perLogRating) {
  const base = EFFORT_BASELINE_MULT[(baselineRating || 3) - 1];
  const perLog = perLogRating ? PERLOG_MULT[perLogRating - 1] : 1;
  return Math.min(EFFORT_MULT_MAX, Math.max(EFFORT_MULT_MIN, base * perLog));
}

const CATEGORIES = {
  cardio: {
    label: "Cardio",
    stat: "Speed",
    icon: "🏃",
    calibrationQ: "How hard does a 1-mile run/jog feel for you right now?",
    activities: {
      run: { label: "Run", unit: "miles", icon: "🏃", xp: (v) => Math.round(v * 8), placeholder: "3.1" },
      walk: { label: "Walk", unit: "miles", icon: "🚶", xp: (v) => Math.round(v * 4), placeholder: "2" },
      bike: { label: "Bike", unit: "miles", icon: "🚴", xp: (v) => Math.round(v * 3), placeholder: "5" },
      cardioOther: { label: "Other", unit: "minutes", icon: "✨", xp: (v) => Math.round(v * 1.2), placeholder: "20", isCustom: true },
    },
  },
  strength: {
    label: "Strength",
    stat: "Power",
    icon: "💪",
    calibrationQ: "How hard do 10 push-ups feel for you right now?",
    activities: {
      pushups: { label: "Push-ups", unit: "reps", icon: "💪", xp: (v) => Math.round(v * 1), placeholder: "10" },
      squats: { label: "Squats", unit: "reps", icon: "🦵", xp: (v) => Math.round(v * 1), placeholder: "15" },
      weights: { label: "Weights", unit: "minutes", icon: "🏋️", xp: (v) => Math.round(v * 1.5), placeholder: "20" },
      strengthOther: { label: "Other", unit: "minutes", icon: "✨", xp: (v) => Math.round(v * 1.2), placeholder: "20", isCustom: true },
    },
  },
  habits: {
    label: "Healthy Habits",
    stat: "Discipline",
    icon: "🥗",
    calibrationQ: "How hard is it for you to stick to healthy habits day-to-day?",
    activities: {
      hydration: { label: "Hydration", unit: "glasses", icon: "💧", xp: (v) => Math.round(v * 2), placeholder: "8" },
      sleep: { label: "Sleep", unit: "hours", icon: "😴", xp: (v) => Math.round(v * 3), placeholder: "8" },
      meal: { label: "Healthy Meal", unit: "meals", icon: "🥗", xp: (v) => Math.round(v * 8), placeholder: "1" },
      habitsOther: { label: "Other", unit: "minutes", icon: "✨", xp: (v) => Math.round(v * 1.2), placeholder: "20", isCustom: true },
    },
  },
  recovery: {
    label: "Recovery",
    stat: "Focus",
    icon: "🧘",
    calibrationQ: "How hard is it for you to make time to stretch or unwind?",
    activities: {
      stretch: { label: "Stretching", unit: "minutes", icon: "🤸", xp: (v) => Math.round(v * 1), placeholder: "10" },
      meditate: { label: "Meditation", unit: "minutes", icon: "🧘", xp: (v) => Math.round(v * 1.2), placeholder: "10" },
      yoga: { label: "Yoga", unit: "minutes", icon: "🕉", xp: (v) => Math.round(v * 1.5), placeholder: "15" },
      recoveryOther: { label: "Other", unit: "minutes", icon: "✨", xp: (v) => Math.round(v * 1.2), placeholder: "20", isCustom: true },
    },
  },
};

// Flat lookup so existing code can still do ACTIVITIES[type] without caring
// which category it's in; each entry also knows its own category key.
const ACTIVITIES = Object.fromEntries(
  Object.entries(CATEGORIES).flatMap(([catKey, cat]) =>
    Object.entries(cat.activities).map(([actKey, act]) => [actKey, { ...act, category: catKey }])
  )
);

/* ============================ cosmetics ============================ */

const LOOT = [
  { key: "cape", name: "Shadow Cape", desc: "Trails behind you as you run." },
  { key: "scarf", name: "Crimson Scarf", desc: "A flash of color at the neck." },
  { key: "stars", name: "Throwing Stars", desc: "Clipped to your belt, ready." },
  { key: "aura", name: "Focus Aura", desc: "A quiet glow that follows you." },
  { key: "goldSash", name: "Golden Sash", desc: "Recolors your sash gold, any rank." },
  { key: "visor", name: "Night Visor", desc: "A sharper line across the eyes." },
];

function rollReward(owned, itemChance = 0.16) {
  const unowned = LOOT.filter((l) => !owned.includes(l.key));
  if (unowned.length && Math.random() < itemChance) {
    const item = unowned[Math.floor(Math.random() * unowned.length)];
    return { kind: "item", itemKey: item.key };
  }
  return { kind: "xp", amount: 2 + Math.floor(Math.random() * 6) };
}

/* ============================ date helpers ============================ */

const fmtDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const todayStr = () => fmtDate(new Date());
const addDays = (date, n) => {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + n);
  return d;
};

function computeStreak(activities, uptoDate) {
  const days = new Set(activities.map((a) => a.date));
  let streak = 0;
  let cursor = uptoDate;
  // Today doesn't have to have an entry yet to keep yesterday's streak alive.
  if (!days.has(fmtDate(cursor))) cursor = addDays(cursor, -1);
  while (days.has(fmtDate(cursor))) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

// Health: a Tamagotchi-style vitality meter, fully derived (not stored) from
// how long it's been since the last log. Logging anything snaps it back to
// full; several days of silence lets it decay. It never erases progress --
// hitting 0 just softly penalizes XP until the player checks back in.
const HEALTH_DECAY_PER_DAY = 20;
function computeHealth(activities, uptoDate) {
  if (activities.length === 0) return 100;
  const days = [...new Set(activities.map((a) => a.date))].sort();
  const lastLogged = new Date(days[days.length - 1] + "T00:00:00");
  const diffDays = Math.max(0, Math.round((uptoDate - lastLogged) / 86400000));
  const missedFullDays = Math.max(0, diffDays - 1); // logging yesterday is still "on track" today
  return Math.max(0, 100 - missedFullDays * HEALTH_DECAY_PER_DAY);
}

// Average Health: a rolling-window consistency score, worth showing off since
// a single point-in-time Health reading is nearly always 100 for anyone
// active (it snaps back the moment you log). Averaging over the last N days
// (or since account start, if younger than that) actually reveals how
// consistent someone's been, which is a much better bragging stat.
const AVG_HEALTH_WINDOW_DAYS = 30;
function computeAverageHealth(activities, uptoDate) {
  if (activities.length === 0) return 100;
  const firstDate = new Date([...new Set(activities.map((a) => a.date))].sort()[0] + "T00:00:00");
  const daysSinceStart = Math.max(1, Math.round((uptoDate - firstDate) / 86400000) + 1);
  const windowDays = Math.min(AVG_HEALTH_WINDOW_DAYS, daysSinceStart);
  let sum = 0;
  for (let i = 0; i < windowDays; i++) {
    const day = addDays(uptoDate, -i);
    const activitiesUpToDay = activities.filter((a) => new Date(a.date + "T00:00:00") <= day);
    sum += computeHealth(activitiesUpToDay, day);
  }
  return Math.round(sum / windowDays);
}

/* ============================ pixel-art background sprites ============================ */
/* Real pixel bitmaps (rows of chars) rendered as SVG rects, so clouds/trees read as
   actual blocky pixel-art silhouettes instead of flat CSS-gradient bands. */

const CLOUD_BIG = [
  "......................",
  "....BBBBBB.BBBBBBBB...",
  "..BBBBBBBBBBBBBBBBBB..",
  ".BBBBBBBBBBBBBBBBBBB..",
  ".BBBBBBBBBBBBBBBBBBB..",
  ".BBBBBBBBBBBBBBBBBBB..",
  ".BBBBBBBBBBBBBBBBBBB..",
  "..BBBBBBBBBBBBBBBBBB..",
  "...BBBBBBBBBBBBBBBB...",
  ".....SSSSSSSSSSSS.....",
  "......................",
];

const CLOUD_SMALL = [
  "...............",
  "...BBBB.BBBB...",
  "..BBBBBBBBBBB..",
  ".BBBBBBBBBBBBB.",
  ".BBBBBBBBBBBB..",
  "..BBBBBBBBBBBB.",
  "...SSSSSSSSSS..",
  "....SSSSSSSS...",
];

const TREE_ROUND_A = [
  ".....2111.....",
  "...12111121...",
  "..1211112111..",
  ".121111211112.",
  ".211112111121.",
  ".111121111211.",
  ".111211112111.",
  ".112111121111.",
  "..2111121111..",
  "...11121111...",
  ".....2111.....",
  "......TT......",
  "......TT......",
  "......TT......",
  "......TT......",
  "......TT......",
  "......TT......",
  "......TT......",
];

const TREE_ROUND_B = [
  "....1211....",
  "..11211112..",
  "..12111121..",
  ".1211112111.",
  ".2111121111.",
  ".1111211112.",
  "..11211112..",
  "..12111121..",
  "....1112....",
  ".....TT.....",
  ".....TT.....",
  ".....TT.....",
  ".....TT.....",
  ".....TT.....",
  ".....TT.....",
];

const TREE_PINE = [
  ".....12.....",
  ".....21.....",
  "....2111....",
  "....1111....",
  "....1111....",
  "...111121...",
  "...111211...",
  "..11121111..",
  "...121111...",
  "..12111112..",
  "..21111121..",
  ".2111112111.",
  "211111211111",
  ".....TT.....",
  ".....TT.....",
  ".....TT.....",
  ".....TT.....",
  ".....TT.....",
];

// Distant mountain range silhouette (replaces the old CSS-gradient "hill"
// bands, which could visibly seam/tear at the tiling loop point). 'M' = rock
// body, 'S' = snow-capped peak tips. One "hero" peak is built noticeably
// taller than the rest so it reaches up to moon height and the moon passes
// behind it as the range scrolls by.
// Dark-green ground-level shrubbery (several distinct shapes, applied at
// random along the strip), used to mask the gap where the farther tree
// layers' trunks sit above the actual ground line. 'G' = main foliage,
// 'H' = lighter top-texture highlight, 'D' = base shadow.
const SHRUB_DOME = [
  "..HGGHGHGGHGHGHGHG..",
  ".GGGHGGGGGHGGHGGGGH.",
  ".GGGGGGGGGGGGGGGGGG.",
  ".GGGGGGGGGGGGGGGGGG.",
  ".GGGGGGGGGGGGGGGGGG.",
  "..GGGGGGGGGGGGGGGG..",
  "HGGGGGGGGGGGGGGGGGGG",
  "DDDDDDDDDDDDDDDDDDDD",
];
const SHRUB_HEDGE = [
  "GHGHGHHGGHHHGGHHGHGGGGH.",
  "HGGGGGGGGHGGGGGGGGGGGGGG",
  "GGGGGGGGGGGGGGGGGGGGGGG.",
  "GGGGGGGGGGGGGGGGGGGGGGGG",
  "DDDDDDDDDDDDDDDDDDDDDDDD",
];
const SHRUB_TWIN = [
  "..GHGHGGHG.HGHGGG...",
  ".GGHGGGGGGGGGGGGGGG.",
  ".GGGGGGGGGGGGGGGGGG.",
  ".GGGGGGGGGGGGGGGGGG.",
  ".GGGGGGGGGGGGGGGGGG.",
  "HGGGGGGGGGGGGGGGGGGH",
  "DDDDDDDDDDDDDDDDDDDD",
];
const SHRUB_LOPSIDED = [
  "..HGGHHHGGHG........",
  ".HHGGGHGGGGGGHGHHGH.",
  ".GGGGGGGGGGGGGGGGGGG",
  "..GGGGGGGGGGGGGGGGGG",
  "....GGGGGG.GGGGGGGG.",
  "HGGGGGGGGGGGGGGGGGGG",
  "DDDDDDDDDDDDDDDDDDDD",
];
const SHRUB_VARIANTS = [SHRUB_DOME, SHRUB_HEDGE, SHRUB_TWIN, SHRUB_LOPSIDED];

const MOUNTAINS = [
  "................................................",
  "................................................",
  "...................SS...........................",
  "...................SS...........................",
  "..................SMMS..........................",
  ".......SS........SSMMSS.........................",
  ".......SS........SMMMMS.........................",
  "......SMMS......SMMMMMMS........................",
  "......SMMS......SMMMMMMS........SS..............",
  ".....SMMMMS....SMMMMMMMMS......SSSS.............",
  ".....SMMMMS...SSMMMMMMMMSS.....SMMS.............",
  "....SMMMMMMS..SMMMMMMMMMMS....SMMMMS......SS....",
  "....SMMMMMMS.SMMMMMMMMMMMMS...SMMMMS.....SSSS...",
  "...SMMMMMMMMSSMMMMMMMMMMMMS..SMMMMMMS....SMMS...",
  "...SMMMMMMMMSMMMMMMMMMMMMMMSSSMMMMMMSS..SMMMMS..",
  "...MMMMMMMMMMMMMMMMMMMMMMMMSSMMMMMMMMS..SMMMMS..",
  "..SMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMSSMMMMMMS.",
  "..SMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMSSMMMMMMSS",
  ".SMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMS",
  ".SMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM",
  "SMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM",
  "SMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM",
  "MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM",
];

// Shaded pixel moon: 'H' = lit highlight side, 'M' = mid-lit body, 'D' = terminator
// shadow side, 'C' = craters. Light is modeled as coming from the upper-left, same
// circle-mask technique used to build the cloud/tree bitmaps above.
const MOON = [
  "................",
  "....HHHHHHMM....",
  "...HHHHHHMMMM...",
  "..HHHHHHMMMMMM..",
  ".HHHHHHMMMCMMDD.",
  ".HHHHCMMMCCMDDD.",
  ".HHHCCCMMMMDDDD.",
  ".HHHMCMMMMDDDDD.",
  ".HHMMMMMMDDDDDD.",
  ".HMMMMMMDDDDDDD.",
  ".MMMMMMDDDDDDDD.",
  ".MMMMMDDDDDDDDD.",
  "..MMMDDDDDDDDD..",
  "...MDDDDDDDDD...",
  "....DDDDDDDD....",
  "................",
];

// Turn a row-strings bitmap into run-length-encoded rects (one rect per
// horizontal run of the same character), so each sprite is a handful of
// <rect> elements rather than one per pixel.
function spriteRects(grid) {
  const rects = [];
  grid.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const ch = row[x];
      if (ch === ".") { x += 1; continue; }
      let x2 = x + 1;
      while (x2 < row.length && row[x2] === ch) x2 += 1;
      rects.push({ x, y, w: x2 - x, ch });
      x = x2;
    }
  });
  return rects;
}

// Renders a repeating horizontal strip of a pixel sprite that scrolls via a
// translateX animation (seamless loop: enough copies are rendered to cover
// the widest scene plus one extra tile).
function PixelLayer({ grid, palette, cell, bottom, top, duration, speed, count = 8, opacity = 1, phase = 0, filter }) {
  const rows = grid.length;
  const cols = grid[0].length;
  const rects = useMemo(() => spriteRects(grid), [grid]);
  const spriteW = cols * cell;
  const spriteH = rows * cell;
  const tile = spriteW * 1.8;
  const animDuration = speed ? `${(tile / speed).toFixed(2)}s` : duration;
  return (
    <div
      className="nq-pixel-scroll"
      style={{
        position: "absolute", left: phase, height: spriteH, width: tile * count,
        bottom, top, opacity, filter, "--tile": `${tile}px`, animationDuration: animDuration,
      }}
    >
      {Array.from({ length: count }, (_, i) => (
        <svg
          key={i}
          width={spriteW}
          height={spriteH}
          viewBox={`0 0 ${cols} ${rows}`}
          shapeRendering="crispEdges"
          style={{ position: "absolute", left: i * tile, top: 0 }}
        >
          {rects.map((r, idx) => (
            <rect key={idx} x={r.x} y={r.y} width={r.w} height={1} fill={palette[r.ch]} />
          ))}
        </svg>
      ))}
    </div>
  );
}

// Like PixelLayer, but picks a random variant bitmap (from `variants`) for
// each slot along the strip, then loops that whole randomized sequence
// seamlessly -- gives natural-looking variety (e.g. shrubs) instead of one
// shape repeating identically. The random pick is memoized so it stays
// stable across re-renders rather than reshuffling every time.
function VariedPixelStrip({ variants, palette, cell, bottom, top, duration, speed, slots = 10, gapMin = 5, gapMax = 16, opacity = 1, zIndex }) {
  const seq = useMemo(() => {
    let x = 0;
    const items = [];
    for (let i = 0; i < slots; i++) {
      const grid = variants[Math.floor(Math.random() * variants.length)];
      const w = grid[0].length * cell;
      const h = grid.length * cell;
      items.push({ grid, x, w, h });
      const gap = gapMin + Math.random() * (gapMax - gapMin);
      x += w + gap * cell;
    }
    return { items, totalW: x };
  }, [variants, slots, cell, gapMin, gapMax]);

  const maxH = Math.max(...seq.items.map((it) => it.h));
  const animDuration = speed ? `${(seq.totalW / speed).toFixed(2)}s` : duration;

  return (
    <div
      className="nq-pixel-scroll"
      style={{
        position: "absolute", left: 0, height: maxH, width: seq.totalW * 2,
        bottom, top, opacity, zIndex, "--tile": `${seq.totalW}px`, animationDuration: animDuration,
      }}
    >
      {[0, 1].map((copy) => (
        <React.Fragment key={copy}>
          {seq.items.map((it, i) => {
            const rects = spriteRects(it.grid);
            const cols = it.grid[0].length;
            const rows = it.grid.length;
            return (
              <svg
                key={`${copy}-${i}`}
                width={it.w}
                height={it.h}
                viewBox={`0 0 ${cols} ${rows}`}
                shapeRendering="crispEdges"
                style={{ position: "absolute", left: copy * seq.totalW + it.x, bottom: 0 }}
              >
                {rects.map((r, idx) => (
                  <rect key={idx} x={r.x} y={r.y} width={r.w} height={1} fill={palette[r.ch]} />
                ))}
              </svg>
            );
          })}
        </React.Fragment>
      ))}
    </div>
  );
}

// A single static (non-scrolling) pixel sprite, used for the moon. Adds a
// gentle glimmer via a pulsing brightness/glow animation.
function PixelSprite({ grid, palette, cell, top, right, left, glimmer, zIndex, className }) {
  const rows = grid.length;
  const cols = grid[0].length;
  const rects = useMemo(() => spriteRects(grid), [grid]);
  const w = cols * cell;
  const h = rows * cell;
  const cls = [glimmer ? "nq-moon-glimmer" : null, className].filter(Boolean).join(" ") || undefined;
  return (
    <svg
      className={cls}
      width={w}
      height={h}
      viewBox={`0 0 ${cols} ${rows}`}
      shapeRendering="crispEdges"
      style={{ position: "absolute", top, right, left, zIndex }}
    >
      {rects.map((r, idx) => (
        <rect key={idx} x={r.x} y={r.y} width={r.w} height={1} fill={palette[r.ch]} />
      ))}
    </svg>
  );
}

// Fixed (not re-randomized per render) scattered star positions, spanning from
// the very top of the sky down through the area behind the progress bar.
const STAR_FIELD = [
  { x: 33.8, y: 7.1, size: 2, delay: 0.19, duration: 3.84 },
  { x: 12.7, y: 18.7, size: 1.5, delay: 0.86, duration: 2.37 },
  { x: 42.5, y: 9.5, size: 1.5, delay: 1.7, duration: 3.85 },
  { x: 15.4, y: 9.0, size: 2, delay: 2.33, duration: 2.32 },
  { x: 57.9, y: 4.3, size: 1, delay: 0.19, duration: 3.92 },
  { x: 30.6, y: 6.9, size: 1, delay: 2.28, duration: 3.32 },
  { x: 66.7, y: 5.8, size: 1.5, delay: 2.56, duration: 2.94 },
  { x: 54.4, y: 4.7, size: 1, delay: 2.48, duration: 3.19 },
  { x: 52.9, y: 24.0, size: 1.5, delay: 2.34, duration: 3.11 },
  { x: 31.6, y: 24.4, size: 2, delay: 3.12, duration: 2.36 },
  { x: 31.6, y: 16.4, size: 1, delay: 2.92, duration: 2.78 },
  { x: 94.2, y: 6.2, size: 1.5, delay: 0.66, duration: 2.88 },
  { x: 89.9, y: 14.4, size: 2, delay: 0.31, duration: 3.32 },
  { x: 76.6, y: 25.1, size: 1, delay: 2.78, duration: 3.39 },
  { x: 57.4, y: 15.3, size: 1, delay: 3.78, duration: 3.15 },
  { x: 65.1, y: 4.6, size: 2, delay: 1.24, duration: 3.36 },
  { x: 66.7, y: 15.0, size: 2, delay: 1.54, duration: 3.54 },
  { x: 6.1, y: 15.5, size: 1, delay: 2.44, duration: 3.19 },
  { x: 24.1, y: 10.8, size: 2, delay: 0.99, duration: 2.98 },
  { x: 84.2, y: 5.2, size: 1.5, delay: 1.61, duration: 2.76 },
  { x: 16.6, y: 14.6, size: 1.5, delay: 1.11, duration: 3.03 },
  { x: 37.0, y: 26.9, size: 1, delay: 0.6, duration: 2.55 },
];

function Starfield() {
  return (
    <div className="nq-starfield">
      {STAR_FIELD.map((s, i) => (
        <div
          key={i}
          className="nq-star"
          style={{
            left: `${s.x}%`, top: `${s.y}%`, width: s.size, height: s.size,
            animationDelay: `${s.delay}s`, animationDuration: `${s.duration}s`,
          }}
        />
      ))}
    </div>
  );
}

// A couple of possible shooting-star paths to pick from at random. Angle/length
// are derived from each path's (dx, dy) travel vector so the trail points the
// right way.
const SHOOTING_PATHS = [
  { top: 5, left: 12, dx: 90, dy: 46 },
  { top: 16, left: 55, dx: 78, dy: 40 },
  { top: 9, left: 30, dx: 70, dy: 52 },
];

// Small pixel-art lightning bolt (built the same way as the clouds/trees/moon:
// a row-string bitmap rendered as SVG rects).
const LIGHTNING_BOLT = [
  "......BB",
  ".....BB.",
  "....BB..",
  "...BBBBB",
  "..BB....",
  ".BB.....",
  "BB......",
  ".BB.....",
  "..BB....",
  "...BB...",
  "....BB..",
  ".....BB.",
];

// Drives both the thunder strike and shooting stars off one random scheduler
// so they're truly randomized (not fixed CSS loops) and never fire together --
// each tick rolls once and picks at most one event.
function SkyEvents({ fill }) {
  const [thunder, setThunder] = useState(false);
  const [starIdx, setStarIdx] = useState(null);

  useEffect(() => {
    if (!fill) return;
    let cancelled = false;
    let tid;
    const tick = () => {
      const delay = 8000 + Math.random() * 10000; // check roughly every 8-18s
      tid = setTimeout(() => {
        if (cancelled) return;
        const roll = Math.random();
        if (roll < 0.09) {
          // thunder: kept rare (~1% of overall time given the flash is brief
          // relative to the average ~13s gap between checks)
          setThunder(true);
          setTimeout(() => { if (!cancelled) setThunder(false); }, 450);
        } else if (roll < 0.4) {
          setStarIdx(Math.floor(Math.random() * SHOOTING_PATHS.length));
          setTimeout(() => { if (!cancelled) setStarIdx(null); }, 900);
        }
        tick();
      }, delay);
    };
    tick();
    return () => { cancelled = true; clearTimeout(tid); };
  }, [fill]);

  if (!fill) return null;

  const path = starIdx !== null ? SHOOTING_PATHS[starIdx] : null;
  const angle = path ? (Math.atan2(path.dy, path.dx) * 180) / Math.PI : 0;
  const dist = path ? Math.hypot(path.dx, path.dy) : 0;

  return (
    <>
      {thunder && (
        <>
          <div className="nq-lightning-once" />
          <PixelSprite
            grid={LIGHTNING_BOLT}
            palette={{ B: "#FFF08A" }}
            cell={5}
            top={70}
            left={44}
            zIndex={1}
            className="nq-bolt-glow"
          />
        </>
      )}
      {path && (
        <div
          className="nq-shooting-star-wrap"
          style={{ top: `${path.top}%`, left: `${path.left}%`, transform: `rotate(${angle}deg)` }}
        >
          <div className="nq-shooting-star-once" style={{ "--dist": `${dist}px` }} />
        </div>
      )}
    </>
  );
}

/* ============================ styles ============================ */

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600;700&family=Nunito:wght@400;600;700;800&display=swap');

.nq { --sky:#3FB6F5; --sky-d:#2691C9; --grass:#4CD07D; --grass-d:#36A862; --coin:#FFC53D; --coin-d:#D9A01F;
  --flame:#FF9E3D; --flame-d:#D9761C; --berry:#FF5470; --berry-d:#D63354; --plum:#A66BFF; --plum-d:#7F45D6;
  --maroon:#7A2E3A; --ink:#E7E9F5; --dim:#A9AFC9; --faint:#7D84A6; --line:#3C4160; --line-d:#262A42;
  --card:#2A2E45; --bg:#1E2136;
  font-family:'Nunito',system-ui,sans-serif; font-weight:600; color:var(--ink);
  background:#141A30;
  min-height:100vh; padding:0;
  -webkit-font-smoothing:antialiased; }
.nq * { box-sizing:border-box; }
.nq-num { font-variant-numeric:tabular-nums; letter-spacing:-.01em; }
.nq-disp { font-family:'Fredoka',sans-serif; font-weight:600; }

/* phone-shaped device frame: matches a modern iPhone/Samsung aspect ratio (9:19.5) */
.nq-phone { position:relative; width:100%; max-width:480px; height:100dvh; margin:0 auto;
  overflow:hidden; transform:translateZ(0);
  background:linear-gradient(180deg,#23263B 0%,#1E2136 340px,#191B29 100%); }

.nq-wrap { position:absolute; inset:0; overflow-y:auto; padding:18px 16px 24px; }
.nq-wrap[data-fullscreen="1"] { overflow:hidden; padding:0; }
.nq-wrap[data-fullscreen="1"] > .nq-topbar { position:absolute; top:34px; left:16px; right:16px; z-index:6; margin-bottom:0; }
.nq-wrap[data-fullscreen="1"] .nq-icon-btn,
.nq-wrap[data-fullscreen="1"] .nq-chip { background:rgba(42,46,69,.75); backdrop-filter:blur(10px); -webkit-backdrop-filter:blur(10px); border-color:rgba(255,255,255,.14); }
.nq-wrap[data-fullscreen="1"] .nq-icon-btn[data-on="1"] { background:rgba(124,58,66,.9); border-color:rgba(124,58,66,.9); }

.nq-home-fill { position:absolute; inset:0; }
.nq-glass-card { background:rgba(30,33,54,.82); backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px);
  border:2px solid rgba(255,255,255,.14); border-radius:20px; padding:14px 16px; box-shadow:0 10px 28px rgba(0,0,0,.4); }
.nq-float-level { position:absolute; top:108px; left:16px; right:16px; z-index:5; }
.nq-corner-btn { position:absolute; z-index:6; width:52px; height:52px; border-radius:50%; border:none;
  background:rgba(30,33,54,.9); color:var(--ink); display:flex; align-items:center; justify-content:center;
  box-shadow:0 6px 16px rgba(0,0,0,.4); cursor:pointer; transition:transform .15s ease; }
.nq-corner-btn[data-primary="1"] { background:var(--flame); color:#fff; }
.nq-badge { position:absolute; top:-2px; right:-2px; background:var(--berry); color:#fff; border-radius:999px;
  font-size:10px; font-family:'Fredoka',sans-serif; min-width:18px; height:18px; padding:0 4px;
  display:flex; align-items:center; justify-content:center; }
.nq-fab-option { position:absolute; z-index:6; width:44px; height:44px; border-radius:50%; border:none;
  background:rgba(30,33,54,.92); font-size:19px; display:flex; align-items:center; justify-content:center;
  box-shadow:0 4px 12px rgba(0,0,0,.4); cursor:pointer; animation:nq-fadeUp .18s ease both; }


@keyframes nq-pop { 0%{transform:scale(.6);opacity:0;} 65%{transform:scale(1.12);opacity:1;} 100%{transform:scale(1);} }
@keyframes nq-fadeUp { 0%{opacity:0;transform:translateY(8px);} 100%{opacity:1;transform:translateY(0);} }
@keyframes nq-pulse { 0%,100%{transform:scale(1);} 50%{transform:scale(1.07);} }
@keyframes nq-flicker { 0%,100%{transform:rotate(-3deg) scale(1);} 50%{transform:rotate(3deg) scale(1.08);} }
@keyframes nq-bob { 0%,100%{transform:translateY(0);} 50%{transform:translateY(-3px);} }

@keyframes nq-swing-fwd { 0%{transform:rotate(-30deg);} 50%{transform:rotate(30deg);} 100%{transform:rotate(-30deg);} }
@keyframes nq-swing-back { 0%{transform:rotate(30deg);} 50%{transform:rotate(-30deg);} 100%{transform:rotate(30deg);} }
@keyframes nq-scroll-clouds { from{background-position-x:0;} to{background-position-x:-64px;} }
@keyframes nq-scroll-trees { from{background-position-x:0;} to{background-position-x:-72px;} }
@keyframes nq-scroll-ground { from{background-position-x:0;} to{background-position-x:-12px;} }
.nq-anim-pop { animation:nq-pop .4s cubic-bezier(.34,1.56,.64,1) both; }

.nq-topbar { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:14px; }
.nq-icon-btn { width:44px; height:44px; border-radius:14px; background:var(--card); border:2px solid var(--line);
  color:var(--ink); display:flex; align-items:center; justify-content:center; cursor:pointer;
  box-shadow:0 3px 0 var(--line-d); flex:none; transition:transform .06s; }
.nq-icon-btn:active { transform:translateY(3px); box-shadow:0 0 0 var(--line-d); }
.nq-icon-btn[data-on="1"] { background:#4A1E28; border-color:#4A1E28; color:#fff; box-shadow:0 3px 0 #2E1119; }
.nq-menu-wrap { position:relative; }
.nq-menu-scrim { position:fixed; inset:0; z-index:20; }
.nq-menu { position:absolute; top:52px; left:0; z-index:21; background:var(--card); border:2px solid var(--line);
  border-radius:18px; box-shadow:0 6px 0 var(--line-d); padding:8px; min-width:190px; animation:nq-fadeUp .2s ease both; }
.nq-menu-item { display:flex; align-items:center; gap:10px; width:100%; text-align:left; background:none; border:none;
  border-radius:12px; padding:11px 14px; font-size:15px; color:var(--ink); cursor:pointer; font-family:'Fredoka',sans-serif; }
.nq-menu-item:hover { background:var(--bg); }
.nq-menu-item[data-on="1"] { background:var(--sky); color:#fff; }
.nq-chip { background:var(--card); border:2px solid var(--line); border-radius:14px; padding:6px 12px;
  text-align:center; box-shadow:0 3px 0 var(--line-d); }
.nq-chip-v { font-family:'Fredoka',sans-serif; font-size:19px; line-height:1; display:flex; align-items:center; gap:4px; justify-content:center; }
.nq-chip-l { font-size:10px; color:var(--faint); text-transform:uppercase; letter-spacing:.08em; margin-top:2px; }

.nq-card { background:var(--card); border:2px solid var(--line); border-radius:20px; padding:18px 20px;
  margin-bottom:14px; box-shadow:0 4px 0 var(--line-d); animation:nq-fadeUp .3s ease both; }
.nq-eyebrow { font-size:11px; letter-spacing:.1em; color:var(--faint); text-transform:uppercase; font-family:'Fredoka',sans-serif; }
.nq-big { font-size:26px; margin:4px 0 0; }

.nq-level { display:flex; align-items:center; gap:16px; }
.nq-level-lvlwrap { display:flex; flex-direction:column; align-items:center; }
.nq-level-lvl { font-family:'Fredoka',sans-serif; font-size:12px; letter-spacing:.14em; color:var(--faint); text-transform:uppercase; }
.nq-level-n { font-family:'Fredoka',sans-serif; font-weight:700; font-size:48px; line-height:.85; }
.nq-level-side { flex:1; min-width:0; }
.nq-pill { display:inline-block; font-family:'Fredoka',sans-serif; font-size:13px; color:#fff; padding:3px 12px; border-radius:999px; }
.nq-track { height:11px; background:var(--line); border-radius:999px; margin-top:7px; overflow:hidden; border:1px solid var(--line-d); }
.nq-track i { display:block; height:100%; border-radius:999px; transition:width .6s cubic-bezier(.22,1,.36,1); box-shadow:inset 0 2px 0 rgba(255,255,255,.45); }

.nq-btn { background:var(--card); border:2px solid var(--line); color:var(--ink); border-radius:14px;
  padding:11px 16px; font-size:14px; cursor:pointer; font-family:'Fredoka',sans-serif;
  box-shadow:0 4px 0 var(--line-d); transition:transform .06s; }
.nq-btn:active { transform:translateY(4px); box-shadow:0 0 0 var(--line-d); }
.nq-btn[data-primary="1"] { background:var(--flame); border-color:var(--flame); color:#fff; box-shadow:0 4px 0 var(--flame-d); }
.nq-btn[data-primary="1"]:active { box-shadow:0 0 0 var(--flame-d); }
.nq-btn:disabled { opacity:.45; cursor:not-allowed; }

.nq-actgrid { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
.nq-actgrid-compact { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; }
.nq-actbtn { background:var(--card); border:2px solid var(--line); border-radius:16px; padding:14px 10px;
  text-align:center; cursor:pointer; box-shadow:0 3px 0 var(--line-d); transition:transform .06s; }
.nq-actbtn:active { transform:translateY(3px); box-shadow:0 0 0 var(--line-d); }
.nq-actbtn-i { font-size:24px; }
.nq-actbtn-l { font-family:'Fredoka',sans-serif; font-size:13px; margin-top:4px; }
.nq-actbtn-compact { padding:8px 4px; border-radius:12px; }
.nq-actbtn-compact .nq-actbtn-i { font-size:18px; }
.nq-actbtn-compact .nq-actbtn-l { font-size:10px; margin-top:2px; }

.nq-field { display:block; margin-bottom:14px; }
.nq-label { font-size:11px; letter-spacing:.08em; color:var(--faint); display:block; margin-bottom:6px; text-transform:uppercase; font-family:'Fredoka',sans-serif; }
.nq-input { width:100%; background:var(--bg); border:2px solid var(--line); color:var(--ink); border-radius:14px;
  padding:11px 13px; font-size:16px; font-family:inherit; font-weight:700; }
.nq-input:focus { outline:none; border-color:var(--sky); background:#2A2E48; }

.nq-note { font-size:12.5px; color:var(--faint); line-height:1.55; font-weight:600; }
.nq-cheer { font-size:13px; color:#8FE7B9; line-height:1.55; background:#1F3B2E; border-radius:14px; padding:10px 14px; }
.nq-empty { color:var(--dim); font-size:14.5px; line-height:1.6; padding:8px 0; font-weight:600; }

.nq-row { display:flex; align-items:center; gap:12px; padding:12px 0; border-bottom:2px solid var(--line); }
.nq-row:last-child { border-bottom:none; }

/* chest reveal */
.nq-reveal { text-align:center; padding:8px 0; }
.nq-reveal-icon { font-size:40px; animation:nq-pop .5s cubic-bezier(.34,1.56,.64,1) both; }
.nq-reveal-title { font-family:'Fredoka',sans-serif; font-size:19px; margin-top:6px; }
.nq-reveal-sub { font-size:13px; color:var(--dim); margin-top:2px; }
.nq-chestbtn { background:linear-gradient(180deg,#FFDD87,var(--coin)); border:2px solid var(--coin-d); border-radius:16px;
  padding:16px; text-align:center; cursor:pointer; box-shadow:0 4px 0 var(--coin-d); animation:nq-pulse 1.6s ease-in-out infinite; }
.nq-chestbtn-icon { font-size:30px; }

/* inventory */
.nq-inv-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(110px,1fr)); gap:10px; }
.nq-inv-item { border:2px solid var(--line); border-radius:14px; padding:12px 10px; text-align:center; background:var(--bg); }
.nq-inv-item[data-on="1"] { border-color:var(--coin); background:#3A2E12; }
.nq-inv-icon { font-size:22px; }
.nq-inv-name { font-family:'Fredoka',sans-serif; font-size:12.5px; margin-top:4px; }
.nq-inv-name[data-on="0"] { color:var(--faint); }
.nq-inv-desc { font-size:10.5px; color:var(--faint); margin-top:2px; line-height:1.35; }

/* runner scene */
.nq-scene-wrap { background:var(--card); border:2px solid var(--line); border-radius:20px; padding:0;
  margin-bottom:14px; box-shadow:0 4px 0 var(--line-d); animation:nq-fadeUp .3s ease both; overflow:hidden; }
.nq-scene-wrap-bg { position:absolute; inset:0; margin:0; border:none; border-radius:0; box-shadow:none; animation:none; z-index:0; --lift:150px; }
.nq-scene-wrap-bg .nq-scene { height:100%; }
.nq-scene { position:relative; height:130px; overflow:hidden; background:linear-gradient(180deg,#0B0F1E 0%,#171F3D 45%,#232B4C 100%); }
.nq-moon-glimmer { animation:nq-moon-glimmer 34s ease-in-out infinite; }
@keyframes nq-moon-glimmer {
  0%, 100% { filter:drop-shadow(0 0 4px rgba(231,236,247,.35)) brightness(1); }
  50% { filter:drop-shadow(0 0 14px rgba(231,236,247,.75)) brightness(1.18); }
}
.nq-starfield { position:absolute; inset:0; z-index:0; pointer-events:none; }
.nq-star { position:absolute; background:#F2F5FF; border-radius:50%; animation:nq-star-twinkle ease-in-out infinite; }
@keyframes nq-star-twinkle { 0%,100%{opacity:.2; transform:scale(1);} 50%{opacity:1; transform:scale(1.6);} }
.nq-shooting-star-wrap { position:absolute; z-index:1; pointer-events:none; }
.nq-shooting-star-once { position:relative; width:52px; height:2px; border-radius:2px; opacity:0;
  background:linear-gradient(90deg, rgba(255,255,255,0) 0%, #fff 80%, #fff 100%);
  box-shadow:0 0 6px 1px rgba(255,255,255,.7);
  animation:nq-shooting-star-once .9s ease-out; }
@keyframes nq-shooting-star-once {
  0% { opacity:1; transform:translateX(0); }
  85% { opacity:.9; transform:translateX(var(--dist)); }
  100% { opacity:0; transform:translateX(var(--dist)); }
}
.nq-layer { position:absolute; left:0; right:0; background-repeat:repeat-x; animation-timing-function:linear; animation-iteration-count:infinite; }
.nq-pixel-scroll { animation-name:nq-pixel-scroll; animation-timing-function:linear; animation-iteration-count:infinite; }
@keyframes nq-pixel-scroll { from{transform:translateX(0);} to{transform:translateX(calc(-1 * var(--tile)));} }
.nq-lightning-once { position:absolute; inset:0; background:#DCE6FF; mix-blend-mode:screen; z-index:1; pointer-events:none;
  animation:nq-lightning-flash-once .45s ease-out; }
@keyframes nq-lightning-flash-once { 0%{opacity:0;} 12%{opacity:.7;} 30%{opacity:.1;} 45%{opacity:.55;} 70%{opacity:0;} 100%{opacity:0;} }
.nq-bolt-glow { filter:drop-shadow(0 0 8px rgba(255,240,138,.9)) drop-shadow(0 0 18px rgba(255,240,138,.5)); }
.nq-ground-cap { bottom:calc(11px + var(--lift, 0px)); height:3px; background-image:repeating-linear-gradient(90deg, #4A3016 0 10px, #2E1D0D 10px 12px); animation-name:nq-scroll-ground; }
.nq-ground { bottom:var(--lift, 0px); height:11px; background-image:repeating-linear-gradient(90deg, #5A3B22 0 10px, #3A2414 10px 12px); animation-name:nq-scroll-ground; }
.nq-scene-fade { position:absolute; left:0; right:0; bottom:0; height:var(--lift, 0px); background:linear-gradient(180deg, #5A3B22 0%, #3A2414 45%, #140C06 100%); z-index:1; pointer-events:none; }
.nq-figure { position:absolute; left:33%; bottom:calc(14px + var(--lift, 0px)); transform:translateX(-50%); z-index:2; }
.nq-bob { position:relative; animation:nq-bob 1.4s ease-in-out infinite; }
.nq-flame-trail { position:absolute; left:-16px; bottom:6px; opacity:.85; animation:nq-flicker 1s ease-in-out infinite; }
.nq-arm-fwd, .nq-leg-back { animation:nq-swing-fwd 1.4s ease-in-out infinite; }
.nq-arm-back, .nq-leg-fwd { animation:nq-swing-back 1.4s ease-in-out infinite; }
.nq-tail-a, .nq-tail-b { animation:nq-flicker .5s ease-in-out infinite; }
.nq-tail-b { animation-delay:.12s; }
.nq-cape { animation:nq-flicker .6s ease-in-out infinite; }

@media (max-width:420px){ .nq-actgrid{grid-template-columns:1fr 1fr;} }
@media (prefers-reduced-motion:reduce){ .nq *{animation:none!important;transition:none!important;} }
`;

/* ============================ runner sprite ============================ */

function NinjaScene({ level, streak, flags, size = 50, fill = false }) {
  const color = level.tier.color;
  const speedScale = Math.max(0.55, 1 - level.level * 0.016);
  const dur = (base) => `${(base * speedScale).toFixed(2)}s`;
  // shared px/sec speed for layers that must visually move together
  // (ground, shrubs, nearest tree line) despite having different tile widths
  const planeSpeed = 100 / (4 * speedScale);
  const onFire = streak > 1;
  const sashColor = color;

  // The ninja faces right (direction of travel) by default. At random
  // intervals -- guaranteed at least once every 5 seconds -- just the head
  // turns to look at the viewer briefly, then turns back.
  const [facingViewer, setFacingViewer] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let tid;
    const cycle = () => {
      const wait = 2600 + Math.random() * 2000; // 2.6-4.6s between turns
      tid = setTimeout(() => {
        if (cancelled) return;
        setFacingViewer(true);
        tid = setTimeout(() => {
          if (cancelled) return;
          setFacingViewer(false);
          cycle();
        }, 1100);
      }, wait);
    };
    cycle();
    return () => { cancelled = true; clearTimeout(tid); };
  }, []);

  return (
    <div className={fill ? "nq-scene-wrap-bg" : "nq-scene-wrap"}>
      <div className="nq-scene">
        {fill && <Starfield />}
        {fill && <SkyEvents fill={fill} />}
        <PixelSprite
          grid={MOON}
          palette={{ H: "#F5F8FF", M: "#C7D0EC", D: "#7F8AB8", C: "#AAB4D8" }}
          cell={fill ? 5.5 : 1.6}
          top={fill ? 335 : 6}
          right={fill ? 22 : 14}
          glimmer
        />
        <PixelLayer
          grid={CLOUD_BIG}
          palette={{ B: "#4A5580", S: "#262C4A" }}
          cell={fill ? 6 : 2}
          top={fill ? 325 : 8}
          duration={dur(50)}
          phase={0}
          opacity={1}
        />
        <PixelLayer
          grid={CLOUD_SMALL}
          palette={{ B: "#39406B", S: "#1E2340" }}
          cell={fill ? 6 : 2}
          top={fill ? 365 : 20}
          duration={dur(55)}
          phase={40}
          opacity={0.55}
          filter="blur(0.4px)"
        />
        <PixelLayer
          grid={MOUNTAINS}
          palette={{ M: "#171C34", S: "#2B335C" }}
          cell={fill ? 16 : 1}
          bottom={`calc(10px + var(--lift, 0px))`}
          duration={dur(360)}
          phase={65}
          opacity={1}
        />
        <PixelLayer
          grid={TREE_PINE}
          palette={{ 1: "#0B0D18", 2: "#12141F", T: "#2E2013" }}
          cell={fill ? 4 : 0.7}
          bottom={`calc(8px + var(--lift, 0px))`}
          duration={dur(9)}
          phase={20}
          opacity={1}
        />
        <PixelLayer
          grid={TREE_ROUND_B}
          palette={{ 1: "#0B0D18", 2: "#12141F", T: "#2E2013" }}
          cell={fill ? 6.5 : 0.85}
          bottom={`calc(8px + var(--lift, 0px))`}
          duration={dur(9)}
          phase={55}
          opacity={1}
        />
        <PixelLayer
          grid={TREE_ROUND_A}
          palette={{ 1: "#0B0D18", 2: "#12141F", T: "#2E2013" }}
          cell={fill ? 9 : 1}
          bottom={`calc(8px + var(--lift, 0px))`}
          speed={planeSpeed}
          phase={0}
          opacity={1}
          filter={fill ? "drop-shadow(0 4px 3px rgba(0,0,0,.45))" : undefined}
        />
        <VariedPixelStrip
          variants={SHRUB_VARIANTS}
          palette={{ G: "#1B3B24", D: "#0F2415", H: "#3A6644" }}
          cell={fill ? 4 : 0.6}
          bottom={`calc(4px + var(--lift, 0px))`}
          speed={planeSpeed}
          slots={12}
          opacity={1}
        />
        <div className="nq-layer nq-ground" style={{ animationDuration: `${(12 / planeSpeed).toFixed(2)}s` }} />
        <div className="nq-layer nq-ground-cap" style={{ animationDuration: `${(12 / planeSpeed).toFixed(2)}s` }} />
        {fill && <div className="nq-scene-fade" />}
        <VariedPixelStrip
          variants={SHRUB_VARIANTS}
          palette={{ G: "#20472C", D: "#122A18", H: "#457850" }}
          cell={fill ? 5 : 0.7}
          bottom={`calc(2px + var(--lift, 0px))`}
          speed={planeSpeed}
          slots={6}
          gapMin={22}
          gapMax={46}
          opacity={1}
          zIndex={3}
        />

        <div className="nq-figure">
          <div className="nq-bob">
            <svg viewBox="0 0 60 60" width={size} height={size} shapeRendering="crispEdges">
              <g
                key={facingViewer ? "front" : "profile"}
                style={{ transformOrigin: "30px 10px" }}
              >
                {facingViewer ? (
                  <>
                    <g className="nq-tail-a" style={{ transformOrigin: "20px 8px" }}>
                      <rect x="11" y="6" width="10" height="3" fill="#C0392B" />
                    </g>
                    <g className="nq-tail-b" style={{ transformOrigin: "40px 9px" }}>
                      <rect x="40" y="8" width="10" height="3" fill="#C0392B" />
                    </g>
                    <rect x="23" y="2" width="14" height="4" fill="#151515" />
                    <rect x="19" y="6" width="22" height="4" fill="#C0392B" />
                    <rect x="19" y="10" width="22" height="1" fill="#151515" />
                    <rect x="21" y="11" width="18" height="3" fill="#F4C99B" />
                    <rect x="24" y="12" width="2" height="1" fill="#151515" />
                    <rect x="34" y="12" width="2" height="1" fill="#151515" />
                    <rect x="21" y="14" width="18" height="2" fill="#151515" />
                    <rect x="19" y="16" width="22" height="4" fill="#151515" />
                  </>
                ) : (
                  <>
                    <g className="nq-tail-a" style={{ transformOrigin: "20px 8px" }}>
                      <rect x="11" y="6" width="10" height="3" fill="#C0392B" />
                    </g>
                    <rect x="23" y="2" width="14" height="4" fill="#151515" />
                    <rect x="19" y="6" width="22" height="4" fill="#C0392B" />
                    <rect x="19" y="10" width="22" height="1" fill="#151515" />
                    <rect x="27" y="11" width="10" height="3" fill="#F4C99B" />
                    <rect x="33" y="12" width="2" height="1" fill="#151515" />
                    <rect x="21" y="14" width="18" height="2" fill="#151515" />
                    <rect x="19" y="16" width="22" height="4" fill="#151515" />
                  </>
                )}
              </g>

              <g transform="rotate(-30 24 24)">
                <rect x="22.5" y="10" width="3" height="28" fill="#C7D0DC" />
                <rect x="21.5" y="38" width="5" height="2" fill="#151515" />
                <rect x="22" y="40" width="4" height="5" fill="#3A2A18" />
              </g>

              <rect x="20" y="20" width="20" height="5" fill="#17181D" />
              <rect x="17" y="25" width="26" height="11" fill="#17181D" />
              <rect x="17" y="29" width="26" height="4" fill={sashColor} />
              <rect x="20" y="36" width="20" height="4" fill="#17181D" />


              <g className="nq-arm-back" style={{ transformOrigin: "30px 22px" }}>
                <rect x="26" y="22" width="8" height="13" fill="#1F2128" />
                <rect x="25" y="33" width="9" height="4" fill="#F4C99B" />
              </g>
              <g className="nq-leg-fwd" style={{ transformOrigin: "30px 40px" }}>
                <rect x="25" y="40" width="8" height="14" fill="#151515" />
                <rect x="23" y="52" width="12" height="8" fill="#E8963A" />
              </g>
              <g className="nq-leg-back" style={{ transformOrigin: "30px 40px" }}>
                <rect x="27" y="40" width="8" height="14" fill="#151515" />
                <rect x="25" y="52" width="12" height="8" fill="#E8963A" />
              </g>
              <g className="nq-arm-fwd" style={{ transformOrigin: "30px 22px" }}>
                <rect x="26" y="22" width="8" height="13" fill="#1F2128" />
                <rect x="25" y="33" width="9" height="4" fill="#F4C99B" />
              </g>
            </svg>
            {onFire && <Flame className="nq-flame-trail" size={14} fill="var(--flame)" strokeWidth={1.5} />}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================ app ============================ */

const DEFAULT_STATE = {
  activities: [],
  chestEvents: [],
  unlockedItems: [],
  onboarded: false,
  effortBaseline: { cardio: 3, strength: 3, habits: 3, recovery: 3 },
};

export default function NinjaQuest() {
  const [state, setState] = useState(DEFAULT_STATE);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState("home");
  const [menuOpen, setMenuOpen] = useState(false);
  const [reveal, setReveal] = useState(null);
  const [logPreset, setLogPreset] = useState(null);
  // undefined = still checking auth, null = signed out, object = signed in.
  // Stays null forever when Supabase isn't configured (Claude.ai chat), so
  // everything below behaves exactly as it did before.
  const [session, setSession] = useState(supabase ? undefined : null);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, sess) => setSession(sess));
    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (session === undefined) return; // still checking auth, hold off loading
    (async () => {
      if (supabase && session) {
        const { data } = await supabase.from("saves").select("state").eq("user_id", session.user.id).maybeSingle();
        if (data && data.state) setState({ ...DEFAULT_STATE, ...data.state });
        setLoaded(true);
      } else if (!supabase) {
        const s = await store.get("ninjaquest:state:v2", null);
        if (s) setState({ ...DEFAULT_STATE, ...s });
        setLoaded(true);
      }
      // supabase configured but signed out: nothing to load, sign-in screen shows instead
    })();
  }, [session]);

  useEffect(() => {
    if (!loaded) return;
    if (supabase && session) {
      supabase.from("saves").upsert({ user_id: session.user.id, state, updated_at: new Date().toISOString() }).then(() => {});
    } else if (!supabase) {
      store.set("ninjaquest:state:v2", state);
    }
  }, [state, loaded, session]);

  const totalXp = useMemo(() => state.activities.reduce((s, a) => s + a.xp, 0), [state.activities]);
  const level = useMemo(() => levelFor(totalXp), [totalXp]);
  const categoryTotals = useMemo(() => {
    const totals = { cardio: 0, strength: 0, habits: 0, recovery: 0 };
    state.activities.forEach((a) => {
      if (a.category) totals[a.category] = (totals[a.category] || 0) + a.xp;
    });
    return totals;
  }, [state.activities]);
  const categoryLevels = useMemo(
    () => Object.fromEntries(Object.entries(categoryTotals).map(([k, v]) => [k, levelFor(v)])),
    [categoryTotals]
  );
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const streak = useMemo(() => computeStreak(state.activities, today), [state.activities]);
  const health = useMemo(() => computeHealth(state.activities, today), [state.activities]);
  const avgHealth = useMemo(() => computeAverageHealth(state.activities, today), [state.activities]);
  const pendingChests = state.chestEvents.filter((c) => !c.opened);

  const logActivity = (type, value, effortRating, customLabel) => {
    const activity = ACTIVITIES[type];
    const category = activity.category;
    const base = activity.xp(value);
    const streakAfter = computeStreak([...state.activities, { date: todayStr() }], today);
    const streakMult = streakMultiplier(streakAfter);
    const effortMult = effortMultiplier(state.effortBaseline[category], effortRating);

    // Health penalty: evaluated on the gap *before* this log, so coming
    // back after a long silence costs a little (deconditioning is real) but
    // this very log is what restores health to full for everything after it.
    const healthBefore = computeHealth(state.activities, today);
    const healthPenalized = healthBefore <= 0;
    const healthMult = healthPenalized ? 0.75 : 1;

    // Cross-training bonus: a flat bump the first time a category is
    // touched on a given day, so branching out is rewarded, not just allowed.
    const todaysCategoriesSoFar = new Set(state.activities.filter((a) => a.date === todayStr()).map((a) => a.category));
    const crossBonus = todaysCategoriesSoFar.size > 0 && !todaysCategoriesSoFar.has(category) ? 6 : 0;

    const xpEarned = Math.round(base * streakMult * effortMult * healthMult) + crossBonus;

    const prevLevel = levelFor(totalXp).level;
    const newActivities = [
      ...state.activities,
      { id: Date.now(), date: todayStr(), type, category, value, xp: xpEarned, effortRating: effortRating || null, customLabel: customLabel || null },
    ];
    const newTotal = totalXp + xpEarned;
    const newLevel = levelFor(newTotal).level;

    const newChestEvents = [...state.chestEvents];
    for (let l = prevLevel + 1; l <= newLevel; l++) {
      newChestEvents.push({ id: `lvl-${l}-${Date.now()}`, kind: "level", level: l, opened: false });
    }

    // Category-weighted loot: nudge the odds for whichever stat is
    // currently furthest behind, without ever guaranteeing anything.
    const sortedCats = Object.entries(categoryTotals).sort((a, b) => a[1] - b[1]);
    const leastTrained = sortedCats[0][0];
    const isImbalanced = sortedCats[0][1] < sortedCats[sortedCats.length - 1][1];
    const itemChance = category === leastTrained && isImbalanced ? 0.24 : 0.16;
    const workoutReward = rollReward(state.unlockedItems, itemChance);
    let unlockedItems = state.unlockedItems;
    if (workoutReward.kind === "item") unlockedItems = [...unlockedItems, workoutReward.itemKey];

    // Personal-best day detection for this category (only counts if there's
    // an actual prior day to beat, so a first-ever log isn't a hollow "PB").
    const dailyTotalsForCategory = {};
    newActivities.forEach((a) => {
      if (a.category === category) dailyTotalsForCategory[a.date] = (dailyTotalsForCategory[a.date] || 0) + a.xp;
    });
    const todayCategoryTotal = dailyTotalsForCategory[todayStr()] || 0;
    const priorBestDay = Math.max(0, ...Object.entries(dailyTotalsForCategory).filter(([d]) => d !== todayStr()).map(([, v]) => v));
    const personalBest = priorBestDay > 0 && todayCategoryTotal > priorBestDay ? { category } : null;

    // Recalibration nudge: if the last 8 ratings in this category average
    // "easy" while the baseline still says otherwise, suggest lowering it.
    const recentRatings = newActivities
      .filter((a) => a.category === category && a.effortRating)
      .slice(-8)
      .map((a) => a.effortRating);
    let recalibrate = null;
    if (recentRatings.length >= 8) {
      const avg = recentRatings.reduce((s, r) => s + r, 0) / recentRatings.length;
      if (avg <= 2 && state.effortBaseline[category] >= 3) {
        recalibrate = { category, suggested: state.effortBaseline[category] - 1 };
      }
    }

    setState({ ...state, activities: newActivities, chestEvents: newChestEvents, unlockedItems });
    setReveal({
      kind: "workout",
      xpEarned,
      mult: streakMult,
      crossBonus,
      personalBest,
      healthPenalized,
      reward: workoutReward,
      leveledUp: newLevel > prevLevel,
      recalibrate,
    });
  };

  const setEffortBaseline = (category, rating) => {
    setState((prev) => ({ ...prev, effortBaseline: { ...prev.effortBaseline, [category]: rating } }));
  };

  const completeOnboarding = (baseline) => {
    setState((prev) => ({ ...prev, onboarded: true, effortBaseline: baseline }));
  };

  const openLevelChest = (chestId) => {
    const reward = rollReward(state.unlockedItems);
    let unlockedItems = state.unlockedItems;
    if (reward.kind === "item") unlockedItems = [...unlockedItems, reward.itemKey];
    setState((prev) => ({
      ...prev,
      chestEvents: prev.chestEvents.map((c) => (c.id === chestId ? { ...c, opened: true } : c)),
      unlockedItems,
    }));
    setReveal({ kind: "level", reward });
  };

  if (supabase && (session === undefined || session === null)) {
    return (
      <div className="nq">
        <style>{CSS}</style>
        <div className="nq-phone">
          <div className="nq-wrap">
            {session === undefined ? <p className="nq-empty">Checking your account…</p> : <SignInScreen />}
          </div>
        </div>
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="nq">
        <style>{CSS}</style>
        <div className="nq-phone">
          <div className="nq-wrap">
            <p className="nq-empty">Warming up…</p>
          </div>
        </div>
      </div>
    );
  }

  if (!state.onboarded) {
    return (
      <div className="nq">
        <style>{CSS}</style>
        <div className="nq-phone">
          <div className="nq-wrap">
            <Onboarding onComplete={completeOnboarding} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="nq">
      <style>{CSS}</style>
      <div className="nq-phone">
        <div className="nq-wrap" data-fullscreen={tab === "home" ? "1" : "0"}>
        <div className="nq-topbar">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {tab !== "home" && (
              <button className="nq-icon-btn" onClick={() => setTab("home")} aria-label="Back to Home">
                <Home size={20} />
              </button>
            )}
            <div className="nq-menu-wrap">
            <button className="nq-icon-btn" onClick={() => setMenuOpen((v) => !v)} aria-label="Menu">
              <Menu size={20} />
            </button>
            {menuOpen && (
              <>
                <div className="nq-menu-scrim" onClick={() => setMenuOpen(false)} />
                <div className="nq-menu">
                  {[
                    ["home", "Home", Sparkles],
                    ["log", "Log activity", ClipboardList],
                    ["chests", `Chests${pendingChests.length ? ` (${pendingChests.length})` : ""}`, Trophy],
                    ["inventory", "Inventory", Package],
                    ["effort", "Effort settings", Sliders],
                    ["share", "Share progress", Share2],
                  ].map(([k, label, Icon]) => (
                    <button
                      key={k}
                      className="nq-menu-item"
                      data-on={tab === k ? "1" : "0"}
                      onClick={() => {
                        setTab(k);
                        setMenuOpen(false);
                      }}
                    >
                      <Icon size={16} />
                      {label}
                    </button>
                  ))}
                </div>
              </>
            )}
            </div>
          </div>
          <div className="nq-chip">
            <div className="nq-chip-v nq-num" style={{ color: "var(--flame-d)" }}>
              <Flame size={13} fill="var(--flame-d)" strokeWidth={1} /> {streak}
            </div>
            <div className="nq-chip-l">Streak</div>
          </div>
          <div className="nq-icon-btn" data-on={tab === "chests" ? "1" : "0"} onClick={() => setTab("chests")} style={{ cursor: "pointer", position: "relative" }}>
            <Trophy size={19} />
            {pendingChests.length > 0 && (
              <span
                className="nq-num"
                style={{
                  position: "absolute", top: -4, right: -4, background: "var(--berry)", color: "#fff",
                  borderRadius: 999, fontSize: 10, width: 16, height: 16, display: "flex", alignItems: "center", justifyContent: "center",
                }}
              >
                {pendingChests.length}
              </span>
            )}
          </div>
        </div>

        {reveal && <RewardModal reveal={reveal} onClose={() => setReveal(null)} onRecalibrate={setEffortBaseline} />}

        {tab === "home" && (
          <HomeView
            level={level}
            streak={streak}
            health={health}
            flags={state.unlockedItems}
            totalXp={totalXp}
            activities={state.activities}
            categoryLevels={categoryLevels}
            setTab={setTab}
            onQuickLog={(category) => {
              setLogPreset(category);
              setTab("log");
            }}
          />
        )}
        {tab === "log" && <LogView onLog={logActivity} initialCategory={logPreset} />}
        {tab === "chests" && <ChestsView chestEvents={state.chestEvents} onOpen={openLevelChest} />}
        {tab === "inventory" && <InventoryView unlockedItems={state.unlockedItems} level={level} streak={streak} />}
        {tab === "effort" && <EffortSettings baseline={state.effortBaseline} onSave={setEffortBaseline} />}
        {tab === "share" && <ShareCard level={level} avgHealth={avgHealth} streak={streak} />}
        </div>
      </div>
    </div>
  );
}

/* ============================ reward modal ============================ */

function RewardModal({ reveal, onClose, onRecalibrate }) {
  const item = reveal.reward.kind === "item" ? LOOT.find((l) => l.key === reveal.reward.itemKey) : null;
  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(44,53,80,.45)", zIndex: 30,
        display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
      }}
      onClick={onClose}
    >
      <div className="nq-card" style={{ maxWidth: 320, width: "100%", marginBottom: 0 }} onClick={(e) => e.stopPropagation()}>
        <div className="nq-reveal">
          <div className="nq-reveal-icon">{item ? "🎁" : reveal.kind === "level" ? "🏆" : "✨"}</div>
          {reveal.kind === "workout" && (
            <>
              <div className="nq-reveal-title">+{reveal.xpEarned} XP</div>
              {reveal.mult > 1 && <div className="nq-reveal-sub">×{reveal.mult.toFixed(2)} streak bonus included</div>}
              {reveal.crossBonus > 0 && (
                <div className="nq-reveal-sub">+{reveal.crossBonus} XP for mixing it up today</div>
              )}
              {reveal.healthPenalized && (
                <div className="nq-reveal-sub" style={{ color: "var(--berry)" }}>
                  −25% XP — your health ran out, but you're back now and it's full again
                </div>
              )}
              {reveal.personalBest && (
                <p className="nq-cheer" style={{ marginTop: 10 }}>
                  New personal best day for {CATEGORIES[reveal.personalBest.category].stat}! 🔥
                </p>
              )}
              {reveal.leveledUp && <p className="nq-cheer" style={{ marginTop: 10 }}>Level up! A chest is waiting for you.</p>}
            </>
          )}
          {item ? (
            <>
              <div className="nq-reveal-title">{item.name}</div>
              <div className="nq-reveal-sub">{item.desc}</div>
            </>
          ) : (
            reveal.kind === "level" && (
              <>
                <div className="nq-reveal-title">+{reveal.reward.amount} bonus XP</div>
                <div className="nq-reveal-sub">Every cosmetic is already yours — nice work.</div>
              </>
            )
          )}
          {reveal.recalibrate && (
            <div className="nq-cheer" style={{ marginTop: 10, textAlign: "left" }}>
              <div style={{ marginBottom: 8 }}>
                {CATEGORIES[reveal.recalibrate.category].label} has felt easy lately — lower your baseline?
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  className="nq-btn"
                  style={{ flex: 1, padding: "8px 10px", fontSize: 13 }}
                  onClick={() => {
                    onRecalibrate(reveal.recalibrate.category, reveal.recalibrate.suggested);
                    onClose();
                  }}
                >
                  Lower it
                </button>
                <button className="nq-btn" style={{ flex: 1, padding: "8px 10px", fontSize: 13 }} onClick={onClose}>
                  Keep as is
                </button>
              </div>
            </div>
          )}
          {!reveal.recalibrate && (
            <button className="nq-btn" data-primary="1" onClick={onClose} style={{ marginTop: 16 }}>
              Nice
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ============================ effort calibration ============================ */

function EffortPickerRow({ value, onChange, labels }) {
  return (
    <div style={{ display: "flex", gap: 6 }}>
      {labels.map((label, i) => {
        const rating = i + 1;
        const on = value === rating;
        return (
          <button
            key={rating}
            onClick={() => onChange(rating)}
            className="nq-btn"
            style={{
              flex: 1, padding: "8px 4px", fontSize: 11, lineHeight: 1.2,
              background: on ? "var(--sky)" : "var(--card)",
              borderColor: on ? "var(--sky)" : "var(--line)",
              color: on ? "#fff" : "var(--ink)",
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function SignInScreen() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);

  const sendLink = async () => {
    if (!email.trim()) return;
    setSending(true);
    setError("");
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: window.location.origin },
    });
    setSending(false);
    if (error) setError(error.message);
    else setSent(true);
  };

  return (
    <div className="nq-card" style={{ marginTop: 18 }}>
      <div className="nq-disp" style={{ fontSize: 20, marginBottom: 6 }}>Welcome, ninja</div>
      {sent ? (
        <p className="nq-note" style={{ lineHeight: 1.5 }}>
          Check <strong>{email}</strong> for a sign-in link. Tap it on this device to jump back in — your
          progress will be waiting for you here and on any device you sign into.
        </p>
      ) : (
        <>
          <p className="nq-note" style={{ marginBottom: 14, lineHeight: 1.5 }}>
            Enter your email and we'll send a link — no password to remember. Your progress saves to your
            account, not just this browser.
          </p>
          <label className="nq-field">
            <span className="nq-label">Email</span>
            <input
              className="nq-input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              onKeyDown={(e) => e.key === "Enter" && sendLink()}
            />
          </label>
          {error && <p className="nq-note" style={{ color: "var(--berry)", marginBottom: 10 }}>{error}</p>}
          <button className="nq-btn" data-primary="1" onClick={sendLink} disabled={!email.trim() || sending} style={{ width: "100%" }}>
            {sending ? "Sending…" : "Send sign-in link"}
          </button>
        </>
      )}
    </div>
  );
}

function Onboarding({ onComplete }) {
  const [answers, setAnswers] = useState({ cardio: 3, strength: 3, habits: 3, recovery: 3 });
  return (
    <div className="nq-card" style={{ marginTop: 18 }}>
      <div className="nq-disp" style={{ fontSize: 20, marginBottom: 6 }}>Before we start…</div>
      <p className="nq-note" style={{ marginBottom: 16, lineHeight: 1.5 }}>
        Everyone's starting point is different — a run that's easy for one person can be brutal for
        another. Answer as honestly as you can; this just makes sure the game rewards <em>your</em>{" "}
        effort fairly. You can change these anytime in Effort settings.
      </p>
      {Object.entries(CATEGORIES).map(([key, cat]) => (
        <div key={key} style={{ marginBottom: 16 }}>
          <div className="nq-label" style={{ marginBottom: 6 }}>{cat.icon} {cat.calibrationQ}</div>
          <EffortPickerRow value={answers[key]} onChange={(r) => setAnswers((a) => ({ ...a, [key]: r }))} labels={EFFORT_LABELS} />
        </div>
      ))}
      <button className="nq-btn" data-primary="1" onClick={() => onComplete(answers)} style={{ width: "100%", marginTop: 4 }}>
        Let's go
      </button>
    </div>
  );
}

function EffortSettings({ baseline, onSave }) {
  return (
    <div className="nq-card">
      <div className="nq-eyebrow" style={{ marginBottom: 10 }}>Effort settings</div>
      <p className="nq-note" style={{ marginBottom: 16, lineHeight: 1.5 }}>
        Adjust how hard each category feels for you right now. As you get fitter, things that used to
        feel hard may feel easier — update these whenever that's true.
      </p>
      {Object.entries(CATEGORIES).map(([key, cat]) => (
        <div key={key} style={{ marginBottom: 16 }}>
          <div className="nq-label" style={{ marginBottom: 6 }}>{cat.icon} {cat.label}</div>
          <EffortPickerRow value={baseline[key]} onChange={(r) => onSave(key, r)} labels={EFFORT_LABELS} />
        </div>
      ))}
    </div>
  );
}

function ShareCard({ level, avgHealth, streak }) {
  const [copied, setCopied] = useState(false);
  const shareText = `I'm Level ${level.level} (${level.tier.name}) in Ninja Quest — ${avgHealth}% average health over the last 30 days and a ${streak}-day streak. 🥷`;

  const share = async () => {
    if (navigator.share) {
      try {
        await navigator.share({ text: shareText });
      } catch (e) {
        // user cancelled the share sheet — nothing to do
      }
    } else {
      try {
        await navigator.clipboard.writeText(shareText);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch (e) {
        // clipboard unavailable — the text is still visible below to copy manually
      }
    }
  };

  return (
    <div className="nq-card">
      <div className="nq-eyebrow" style={{ marginBottom: 12 }}>Share progress</div>
      <div
        className="nq-glass-card"
        style={{ background: "var(--card)", border: "2px solid var(--line)", textAlign: "center", padding: "24px 16px", marginBottom: 16 }}
      >
        <div className="nq-num" style={{ fontSize: 12, color: "var(--dim)", marginBottom: 4 }}>LEVEL</div>
        <div className="nq-disp" style={{ fontSize: 42, lineHeight: 1 }}>{level.level}</div>
        <span className="nq-pill" style={{ background: level.tier.color, marginTop: 6, display: "inline-block" }}>
          {level.tier.name}
        </span>
        <div style={{ display: "flex", justifyContent: "center", gap: 24, marginTop: 18 }}>
          <div>
            <div className="nq-disp" style={{ fontSize: 22, color: "var(--grass-d)" }}>{avgHealth}%</div>
            <div className="nq-note" style={{ fontSize: 10 }}>Avg Health (30d)</div>
          </div>
          <div>
            <div className="nq-disp" style={{ fontSize: 22, color: "var(--flame-d)" }}>{streak}</div>
            <div className="nq-note" style={{ fontSize: 10 }}>Day streak</div>
          </div>
        </div>
      </div>
      <button className="nq-btn" data-primary="1" onClick={share} style={{ width: "100%" }}>
        {copied ? "Copied to clipboard!" : "Share with a friend"}
      </button>
    </div>
  );
}

/* ============================ home ============================ */

function HomeView({ level, streak, health, flags, totalXp, activities, categoryLevels, setTab, onQuickLog }) {
  const [fabOpen, setFabOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const todayActs = activities.filter((a) => a.date === todayStr()).sort((a, b) => b.id - a.id);
  const todayXp = todayActs.reduce((s, a) => s + a.xp, 0);
  const healthColor = health <= 0 ? "var(--berry)" : health < 50 ? "var(--flame)" : "var(--grass)";

  return (
    <div className="nq-home-fill">
      <NinjaScene level={level} streak={streak} flags={flags} size={100} fill />

      <div className="nq-float-level nq-glass-card" style={{ padding: "10px 14px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div className="nq-level-n" style={{ fontSize: 26, lineHeight: 1 }}>{level.level}</div>
          <div style={{ flex: 1 }}>
            <div className="nq-note nq-num" style={{ fontSize: 11 }}>
              {totalXp} XP · {level.span - level.into} to next level
            </div>
            <div className="nq-track" style={{ height: 6, marginTop: 3 }}>
              <i style={{ width: `${level.pct}%`, background: level.tier.color }} />
            </div>
          </div>
        </div>

        <div style={{ marginTop: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span className="nq-note" style={{ fontSize: 10 }}>Health</span>
            <span className="nq-num" style={{ fontSize: 10, color: healthColor, fontFamily: "'Fredoka',sans-serif" }}>
              {health}/100
            </span>
          </div>
          <div className="nq-track" style={{ height: 6, marginTop: 2 }}>
            <i style={{ width: `${health}%`, background: healthColor }} />
          </div>
          {health <= 0 && (
            <div className="nq-note" style={{ fontSize: 10, color: "var(--berry)", marginTop: 2 }}>
              Depleted — log something to bring it back
            </div>
          )}
        </div>

        {categoryLevels && (
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            {Object.entries(CATEGORIES).map(([key, cat]) => (
              <div key={key} style={{ flex: 1, textAlign: "center" }}>
                <div style={{ fontSize: 11 }}>{cat.icon}</div>
                <div className="nq-num" style={{ fontSize: 10, fontFamily: "'Fredoka',sans-serif" }}>
                  Lv {categoryLevels[key].level}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {(fabOpen || historyOpen) && (
        <div
          style={{ position: "absolute", inset: 0, zIndex: 5 }}
          onClick={() => {
            setFabOpen(false);
            setHistoryOpen(false);
          }}
        />
      )}

      {historyOpen && (
        <div className="nq-glass-card" style={{ position: "absolute", left: 16, right: 16, bottom: 84, zIndex: 6, maxHeight: "48%", overflowY: "auto" }}>
          <div className="nq-eyebrow" style={{ marginBottom: 8 }}>
            Today · {todayActs.length} logged · +{todayXp} XP
          </div>
          {todayActs.length === 0 && <p className="nq-empty">Nothing logged yet today.</p>}
          {todayActs.map((a) => (
            <div key={a.id} className="nq-row">
              <span style={{ fontSize: 18 }}>{ACTIVITIES[a.type].icon}</span>
              <div style={{ flex: 1 }}>
                <div className="nq-num" style={{ fontSize: 13 }}>
                  {a.value} {ACTIVITIES[a.type].unit} · {a.customLabel || ACTIVITIES[a.type].label}
                </div>
                <div className="nq-note" style={{ fontSize: 10.5 }}>
                  +{a.xp} XP → {CATEGORIES[a.category].stat} & Level
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <button
        className="nq-corner-btn"
        style={{ left: 16, bottom: 16 }}
        onClick={() => {
          setHistoryOpen((v) => !v);
          setFabOpen(false);
        }}
        aria-label="History"
      >
        <History size={20} />
        {todayActs.length > 0 && <span className="nq-badge">{todayActs.length}</span>}
      </button>

      {fabOpen &&
        Object.entries(CATEGORIES).map(([key, cat], i) => (
          <button
            key={key}
            className="nq-fab-option"
            style={{ right: 16, bottom: 16 + (i + 1) * 58 }}
            onClick={() => {
              setFabOpen(false);
              onQuickLog(key);
            }}
            aria-label={cat.label}
          >
            {cat.icon}
          </button>
        ))}

      <button
        className="nq-corner-btn"
        data-primary="1"
        style={{ right: 16, bottom: 16, transform: fabOpen ? "rotate(45deg)" : "rotate(0deg)" }}
        onClick={() => {
          setFabOpen((v) => !v);
          setHistoryOpen(false);
        }}
        aria-label="Log an activity"
      >
        <Plus size={24} />
      </button>
    </div>
  );
}

/* ============================ log ============================ */

function LogView({ onLog, initialCategory }) {
  const [category, setCategory] = useState(initialCategory || "cardio");
  const [type, setType] = useState(Object.keys(CATEGORIES[initialCategory || "cardio"].activities)[0]);
  const [value, setValue] = useState("");
  const [customLabel, setCustomLabel] = useState("");
  const [effortRating, setEffortRating] = useState(null);
  const a = ACTIVITIES[type];
  const preview = value ? a.xp(parseFloat(value) || 0) : 0;

  const pickCategory = (key) => {
    setCategory(key);
    setType(Object.keys(CATEGORIES[key].activities)[0]);
    setCustomLabel("");
  };

  const submit = () => {
    const v = parseFloat(value);
    if (!v || v <= 0) return;
    if (a.isCustom && !customLabel.trim()) return;
    onLog(type, v, effortRating, a.isCustom ? customLabel.trim() : null);
    setValue("");
    setCustomLabel("");
    setEffortRating(null);
  };

  return (
    <div className="nq-card">
      <div className="nq-eyebrow" style={{ marginBottom: 12 }}>Category</div>
      <div className="nq-actgrid" style={{ marginBottom: 16 }}>
        {Object.entries(CATEGORIES).map(([key, cat]) => (
          <div
            key={key}
            className="nq-actbtn"
            style={category === key ? { borderColor: "var(--sky)", background: "#1E2E3D" } : undefined}
            onClick={() => pickCategory(key)}
          >
            <div className="nq-actbtn-i">{cat.icon}</div>
            <div className="nq-actbtn-l">{cat.label}</div>
          </div>
        ))}
      </div>

      <div className="nq-eyebrow" style={{ marginBottom: 12 }}>What did you do?</div>
      <div className="nq-actgrid" style={{ marginBottom: 16 }}>
        {Object.entries(CATEGORIES[category].activities).map(([key, act]) => (
          <div
            key={key}
            className="nq-actbtn"
            style={type === key ? { borderColor: "var(--sky)", background: "#1E2E3D" } : undefined}
            onClick={() => setType(key)}
          >
            <div className="nq-actbtn-i">{act.icon}</div>
            <div className="nq-actbtn-l">{act.label}</div>
          </div>
        ))}
      </div>

      {a.isCustom && (
        <label className="nq-field">
          <span className="nq-label">What was it?</span>
          <input
            className="nq-input"
            value={customLabel}
            onChange={(e) => setCustomLabel(e.target.value)}
            placeholder="Rowing, climbing, dance class…"
          />
        </label>
      )}

      <label className="nq-field">
        <span className="nq-label">{a.label} — {a.unit}</span>
        <input
          className="nq-input nq-num"
          inputMode="decimal"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={a.placeholder}
        />
      </label>

      {value && (
        <>
          <p className="nq-note" style={{ marginBottom: 10 }}>
            Roughly <span className="nq-num" style={{ color: "var(--coin-d)" }}>+{preview} XP</span> before your streak
            and effort bonuses.
          </p>
          <div className="nq-field">
            <span className="nq-label">How did it feel? (optional)</span>
            <EffortPickerRow value={effortRating} onChange={setEffortRating} labels={PERLOG_LABELS} />
          </div>
        </>
      )}

      <button className="nq-btn" data-primary="1" onClick={submit} disabled={!value || (a.isCustom && !customLabel.trim())}>
        Log it
      </button>
    </div>
  );
}

/* ============================ chests ============================ */

function ChestsView({ chestEvents, onOpen }) {
  const pending = chestEvents.filter((c) => !c.opened).sort((a, b) => a.level - b.level);
  const opened = chestEvents.filter((c) => c.opened).sort((a, b) => b.level - a.level);

  return (
    <>
      <div className="nq-card">
        <div className="nq-eyebrow" style={{ marginBottom: 12 }}>Waiting to open</div>
        {pending.length === 0 && <p className="nq-empty">No chests waiting. Level up to unlock one.</p>}
        {pending.map((c) => (
          <div key={c.id} className="nq-chestbtn" style={{ marginBottom: 10 }} onClick={() => onOpen(c.id)}>
            <div className="nq-chestbtn-icon">🎁</div>
            <div className="nq-disp" style={{ fontSize: 15, marginTop: 4 }}>Level {c.level} chest</div>
            <div className="nq-note" style={{ color: "#7A5A0E" }}>Tap to open</div>
          </div>
        ))}
      </div>

      {opened.length > 0 && (
        <div className="nq-card">
          <div className="nq-eyebrow" style={{ marginBottom: 10 }}>Opened</div>
          {opened.map((c) => (
            <div key={c.id} className="nq-row">
              <CheckCircle2 size={16} color="var(--grass-d)" />
              <span className="nq-num">Level {c.level} chest</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/* ============================ inventory ============================ */

function InventoryView({ unlockedItems, level, streak }) {
  return (
    <>
      <NinjaScene level={level} streak={streak} flags={unlockedItems} />
      <div className="nq-card">
        <div className="nq-eyebrow" style={{ marginBottom: 16 }}>
          Gear — {unlockedItems.length} of {LOOT.length}
        </div>
        <div className="nq-inv-grid">
          {LOOT.map((item) => {
            const on = unlockedItems.includes(item.key);
            return (
              <div key={item.key} className="nq-inv-item" data-on={on ? "1" : "0"}>
                <div className="nq-inv-icon">{on ? "✅" : "🔒"}</div>
                <div className="nq-inv-name" data-on={on ? "1" : "0"}>{item.name}</div>
                <div className="nq-inv-desc">{on ? item.desc : "Keep leveling to find this."}</div>
              </div>
            );
          })}
        </div>
        <p className="nq-note" style={{ marginTop: 14 }}>
          Everything unlocked shows up on your ninja automatically — there's no separate equip step yet.
        </p>
      </div>
    </>
  );
}
