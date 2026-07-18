// server.js — GoalLine market sync worker
//
// Pulls World Cup fixtures/odds/scores from TxLINE and writes them into the
// Firestore "markets" collection in the exact shape index.html expects:
//   home, away, homeFlag, awayFlag, status, score, time,
//   oddsHome, oddsDraw, oddsAway, createdAt
//
// Requires (npm install):
//   npm install express axios firebase-admin
//
// Required Railway env vars:
//   TXLINE_GUEST_JWT        - from subscribeAndActivate.js output
//   TXLINE_API_TOKEN        - from subscribeAndActivate.js output
//   FIREBASE_SERVICE_ACCOUNT_KEY - full service account JSON, as a single-line string
//   PORT                    - Railway sets this automatically
//
// NOTE: if your other server.js files use a different env var name for the
// Firebase service account, tell me and I'll give you the one-line swap.

const express = require("express");
const axios = require("axios");
const admin = require("firebase-admin");
const TelegramBot = require("node-telegram-bot-api");

// ─── CONFIG ──────────────────────────────────────────────────────────────
const NETWORK = "devnet"; // switch to "mainnet" later if you move off devnet
const CONFIG = {
  mainnet: { apiOrigin: "https://txline.txodds.com" },
  devnet: { apiOrigin: "https://txline-dev.txodds.com" },
};
const apiOrigin = CONFIG[NETWORK].apiOrigin;
const apiBaseUrl = `${apiOrigin}/api`;

const SYNC_INTERVAL_MS = 65_000; // free tier delay is ~60s, no point polling faster

// ─── FIREBASE ADMIN INIT ────────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

// ─── TELEGRAM BOT (account linking + live alerts) ───────────────────────
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
let bot = null;
if (TELEGRAM_BOT_TOKEN) {
  bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

  // Registers the native "/" commands menu button in Telegram's chat UI
  bot.setMyCommands([
    { command: "start", description: "Get started / link your GoalLine account" },
    { command: "link", description: "Link your account" },
    { command: "unlink", description: "Stop receiving alerts" },
    { command: "help", description: "Show all commands" },
  ]);

  const awaitingOtp = new Set(); // chatIds we just asked for an OTP, expecting plain text next

  const HELP_TEXT = "📋 *GoalLine Bot Commands*\n\n"
    + "/start — Welcome message & instructions\n"
    + "/link — Link your GoalLine account (I'll ask for your code)\n"
    + "/unlink — Stop receiving alerts on this chat\n"
    + "/help — Show this list\n\n"
    + "Once linked, I message you here automatically for goals ⚽, cards 🟨🟥, big odds shifts 📊, and full-time results 🏁 — no further commands needed.";

  const START_TEXT = "👋 *Welcome to GoalLine!*\n\n"
    + "I send live World Cup alerts straight to this chat — goals, cards, odds shifts, and full-time scores.\n\n"
    + "*To link your account:*\n"
    + "1. Open the GoalLine app → Profile → Connect Telegram\n"
    + "2. You'll get a 6-digit code\n"
    + "3. Send /link here, then just type the code when I ask for it\n\n"
    + "Tap the button below any time to see all commands.";

  const commandsButton = {
    reply_markup: { inline_keyboard: [[{ text: "📋 Show Commands", callback_data: "show_commands" }]] },
  };

  async function findLinkedUser(chatId) {
    const snap = await db.collection("users").where("telegramChatId", "==", String(chatId)).limit(1).get();
    return snap.empty ? null : snap.docs[0];
  }

  bot.onText(/\/start(?:\s+(\w+))?/, async (msg, match) => {
    if (match[1]) {
      await linkTelegramCode(match[1], msg.chat.id);
      return;
    }
    const linkedDoc = await findLinkedUser(msg.chat.id);
    if (linkedDoc) {
      bot.sendMessage(msg.chat.id, `✅ You're already linked as *${linkedDoc.data().name || "a GoalLine user"}*. You'll keep getting live match alerts here — no action needed. Use /unlink if you ever want to stop.`, { parse_mode: "Markdown" });
      return;
    }
    bot.sendMessage(msg.chat.id, START_TEXT, { parse_mode: "Markdown", ...commandsButton });
  });

  bot.onText(/\/help/, (msg) => {
    bot.sendMessage(msg.chat.id, HELP_TEXT, { parse_mode: "Markdown" });
  });

  bot.onText(/^\/link(?:\s+(\w+))?$/, async (msg, match) => {
    const linkedDoc = await findLinkedUser(msg.chat.id);
    if (linkedDoc) {
      bot.sendMessage(msg.chat.id, `You're already linked as *${linkedDoc.data().name || "a GoalLine user"}*. Use /unlink first if you want to link a different account.`, { parse_mode: "Markdown" });
      return;
    }
    if (match[1]) {
      awaitingOtp.delete(msg.chat.id);
      await linkTelegramCode(match[1], msg.chat.id);
      return;
    }
    awaitingOtp.add(msg.chat.id);
    bot.sendMessage(msg.chat.id, "🔑 Please send me your 6-digit code from Profile → Connect Telegram in the app. Just type it and hit send.");
  });

  bot.onText(/\/unlink/, async (msg) => {
    const linkedDoc = await findLinkedUser(msg.chat.id);
    if (!linkedDoc) {
      bot.sendMessage(msg.chat.id, "You're not currently linked to a GoalLine account.");
      return;
    }
    bot.sendMessage(msg.chat.id, "⚠️ Are you sure? You'll stop receiving goal, card, odds-shift, and full-time alerts.", {
      reply_markup: { inline_keyboard: [[
        { text: "✅ Yes, unlink", callback_data: "unlink_confirm" },
        { text: "❌ Cancel", callback_data: "unlink_cancel" },
      ]] },
    });
  });

  // Free-text fallback: if we just asked this chat for an OTP, treat their next message as the code
  bot.on("message", async (msg) => {
    if (!msg.text || msg.text.startsWith("/")) return;
    if (!awaitingOtp.has(msg.chat.id)) return;
    awaitingOtp.delete(msg.chat.id);
    await linkTelegramCode(msg.text.trim(), msg.chat.id);
  });

  bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    if (query.data === "show_commands") {
      await bot.answerCallbackQuery(query.id);
      bot.sendMessage(chatId, HELP_TEXT, { parse_mode: "Markdown" });
      return;
    }
    if (query.data === "unlink_confirm") {
      await bot.answerCallbackQuery(query.id);
      const linkedDoc = await findLinkedUser(chatId);
      if (linkedDoc) {
        await linkedDoc.ref.update({ telegramChatId: admin.firestore.FieldValue.delete() });
        bot.sendMessage(chatId, "🔕 You've been unlinked. You won't receive any more alerts here. Send /link any time to reconnect.");
      } else {
        bot.sendMessage(chatId, "You're not currently linked.");
      }
      return;
    }
    if (query.data === "unlink_cancel") {
      await bot.answerCallbackQuery(query.id);
      bot.sendMessage(chatId, "👍 Staying linked — you'll keep getting alerts.");
      return;
    }
  });

  bot.on("polling_error", (err) => {
    // Expected during redeploys — the old container's connection briefly
    // overlaps with the new one. Non-fatal; polling recovers automatically.
    if (err.code !== "ETELEGRAM" || !String(err.message).includes("409")) {
      console.warn("Telegram polling error:", err.message);
    }
  });

  console.log("Telegram bot polling started.");
} else {
  console.warn("TELEGRAM_BOT_TOKEN not set — Telegram notifications disabled.");
}

async function linkTelegramCode(code, chatId) {
  const usersSnap = await db.collection("users").where("telegramOtp", "==", code).limit(1).get();
  if (usersSnap.empty) {
    bot.sendMessage(chatId, "❌ Invalid or expired code. Generate a new one from Profile → Connect Telegram.");
    return;
  }
  const userDoc = usersSnap.docs[0];
  const user = userDoc.data();
  if (user.telegramOtpExpires && user.telegramOtpExpires.toMillis() < Date.now()) {
    bot.sendMessage(chatId, "❌ That code expired. Generate a new one from Profile → Connect Telegram.");
    return;
  }
  await userDoc.ref.update({
    telegramChatId: String(chatId),
    telegramOtp: admin.firestore.FieldValue.delete(),
    telegramOtpExpires: admin.firestore.FieldValue.delete(),
  });
  bot.sendMessage(chatId, `✅ Linked! You're set as ${user.name || "a GoalLine user"}. I'll ping you here for goals, red cards, and big odds shifts.`);
}

const TTS_ENABLED = process.env.TELEGRAM_TTS_ENABLED === "true";

async function synthesizeSpeech(text) {
  // Free, no-key TTS endpoint — good enough for a hackathon demo.
  const url = `https://api.streamelements.com/kappa/v2/speech?voice=Brian&text=${encodeURIComponent(text)}`;
  const res = await axios.get(url, { responseType: "arraybuffer", timeout: 8000 });
  return Buffer.from(res.data);
}

async function notifyLinkedUsers(text, speakText) {
  if (!bot) return;
  const usersSnap = await db.collection("users").where("telegramChatId", "!=", null).get();

  let audioBuffer = null;
  if (TTS_ENABLED && speakText) {
    try {
      audioBuffer = await synthesizeSpeech(speakText);
    } catch (err) {
      console.warn("TTS synthesis failed, sending text only:", err.message);
    }
  }

  await Promise.all(usersSnap.docs.map(async (doc) => {
    const chatId = doc.data().telegramChatId;
    try {
      await bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
      if (audioBuffer) {
        await bot.sendVoice(chatId, audioBuffer, {}, { filename: "alert.mp3", contentType: "audio/mpeg" });
      }
    } catch (err) {
      console.warn(`Telegram send failed for ${doc.id}:`, err.message);
    }
  }));
}

// ─── PREVIOUS STATE CACHE (for detecting goals / odds shifts) ───────────
const prevFixtureState = new Map();
const ODDS_SHIFT_PROB_THRESHOLD = 8; // percentage points of implied probability — robust across all odds scales

function impliedProb(decimalOdds) {
  return decimalOdds ? Math.round((1 / decimalOdds) * 100) : null;
}

async function logMatchEvent(fixtureId, event) {
  try {
    await db.collection("markets").doc(`wc_${fixtureId}`).update({
      events: admin.firestore.FieldValue.arrayUnion({ ...event, timestamp: new Date().toISOString() }),
    });
  } catch (err) {
    console.warn(`Failed to log timeline event for fixture ${fixtureId}:`, err.message);
  }
}

async function maybeNotify(fixtureId, homeTeam, awayTeam, marketDoc, odds, cards, status) {
  const prev = prevFixtureState.get(fixtureId);
  const curr = {
    score: marketDoc.score,
    oddsHome: odds?.oddsHome,
    oddsAway: odds?.oddsAway,
    redHome: cards.redHome, redAway: cards.redAway,
    yellowHome: cards.yellowHome, yellowAway: cards.yellowAway,
    cornersHome: cards.cornersHome, cornersAway: cards.cornersAway,
  };

  if (prev) {
    if (prev.score !== curr.score && curr.score !== "0-0") {
      const text = `⚽ *GOAL!*\n${homeTeam} ${curr.score} ${awayTeam}\nThe scoreline just moved — that's a big swing in this one.`;
      await notifyLinkedUsers(text, `Goal! ${homeTeam} ${curr.score.replace("-", " ")} ${awayTeam}.`);
      const scoringTeam = curr.score.split("-")[0] > prev.score.split("-")[0] ? homeTeam : awayTeam;
      await logMatchEvent(fixtureId, { type: "goal", label: `Goal — ${scoringTeam}` });
    }
    if (curr.redHome > prev.redHome) {
      const text = `🟥 *RED CARD* — ${homeTeam}\n${homeTeam} ${curr.score} ${awayTeam}\n${homeTeam} are down to 10 men — expect the market to react fast.`;
      await notifyLinkedUsers(text, `Red card for ${homeTeam}. They're down to ten men.`);
      await logMatchEvent(fixtureId, { type: "red", label: `Red card — ${homeTeam}` });
    }
    if (curr.redAway > prev.redAway) {
      const text = `🟥 *RED CARD* — ${awayTeam}\n${homeTeam} ${curr.score} ${awayTeam}\n${awayTeam} are down to 10 men — expect the market to react fast.`;
      await notifyLinkedUsers(text, `Red card for ${awayTeam}. They're down to ten men.`);
      await logMatchEvent(fixtureId, { type: "red", label: `Red card — ${awayTeam}` });
    }
    if (curr.yellowHome > prev.yellowHome) {
      await notifyLinkedUsers(`🟨 Yellow card — ${homeTeam}\n${homeTeam} ${curr.score} ${awayTeam}`);
      await logMatchEvent(fixtureId, { type: "yellow", label: `Yellow card — ${homeTeam}` });
    }
    if (curr.yellowAway > prev.yellowAway) {
      await notifyLinkedUsers(`🟨 Yellow card — ${awayTeam}\n${homeTeam} ${curr.score} ${awayTeam}`);
      await logMatchEvent(fixtureId, { type: "yellow", label: `Yellow card — ${awayTeam}` });
    }
    // Corners: timeline only — too frequent to justify a Telegram push
    if (curr.cornersHome > prev.cornersHome) {
      await logMatchEvent(fixtureId, { type: "corner", label: `Corner — ${homeTeam}` });
    }
    if (curr.cornersAway > prev.cornersAway) {
      await logMatchEvent(fixtureId, { type: "corner", label: `Corner — ${awayTeam}` });
    }
    // Only fire for genuinely BIG shifts now — small odds wobble is noise, not news.
    if (prev.oddsHome != null && curr.oddsHome != null && prev.oddsAway != null && curr.oddsAway != null) {
      const prevHomeProb = impliedProb(prev.oddsHome);
      const currHomeProb = impliedProb(curr.oddsHome);
      const homeShiftPts = Math.abs(currHomeProb - prevHomeProb);
      if (homeShiftPts >= ODDS_SHIFT_PROB_THRESHOLD) {
        const favoring = currHomeProb > prevHomeProb ? homeTeam : awayTeam;
        const text = `📊 *Big odds shift* — ${homeTeam} vs ${awayTeam}\nHome ${prev.oddsHome.toFixed(2)} → ${curr.oddsHome.toFixed(2)} | Away ${prev.oddsAway.toFixed(2)} → ${curr.oddsAway.toFixed(2)}\nThe market has swung hard toward ${favoring} — implied confidence moved from roughly ${prevHomeProb}% to ${currHomeProb}%.`;
        await notifyLinkedUsers(text, `Big odds shift. The market is now favoring ${favoring}.`);
      }
    }
    if (prev.status !== "completed" && status === "completed") {
      const text = `🏁 *Full-time*\n${homeTeam} ${curr.score} ${awayTeam}`;
      await notifyLinkedUsers(text, `Full time. ${homeTeam} ${curr.score.replace("-", " ")} ${awayTeam}.`);
    }
  }
  prevFixtureState.set(fixtureId, { ...curr, status });
}

// ─── TXLINE AUTH STATE (refreshed automatically on 401) ────────────────
let jwt = process.env.TXLINE_GUEST_JWT;
let apiToken = process.env.TXLINE_API_TOKEN;

if (!jwt || !apiToken) {
  throw new Error(
    "Missing TXLINE_GUEST_JWT or TXLINE_API_TOKEN env vars. Run subscribeAndActivate.js first and paste the output into Railway."
  );
}

async function refreshJwt() {
  console.log("Refreshing TxLINE guest JWT...");
  const res = await axios.post(`${apiOrigin}/auth/guest/start`);
  jwt = res.data.token;
  console.log("Guest JWT refreshed.");
}

async function txlineGet(path, params) {
  try {
    const res = await axios.get(`${apiBaseUrl}${path}`, {
      params,
      timeout: 30000,
      headers: {
        Authorization: `Bearer ${jwt}`,
        "X-Api-Token": apiToken,
      },
    });
    return res.data;
  } catch (err) {
    if (err.response?.status === 401) {
      await refreshJwt();
      const res = await axios.get(`${apiBaseUrl}${path}`, {
        params,
        timeout: 30000,
        headers: {
          Authorization: `Bearer ${jwt}`,
          "X-Api-Token": apiToken,
        },
      });
      return res.data;
    }
    throw err;
  }
}

// ─── FLAG LOOKUP (emoji, since that's what index.html renders directly) ─
// Add to this as unmapped teams show up in the logs.
const FLAGS = {
  "Argentina": "🇦🇷", "Brazil": "🇧🇷", "France": "🇫🇷", "England": "🏴󠁧󠁢󠁥󠁮󠁧󠁿",
  "Spain": "🇪🇸", "Germany": "🇩🇪", "Portugal": "🇵🇹", "Netherlands": "🇳🇱",
  "Belgium": "🇧🇪", "Italy": "🇮🇹", "Croatia": "🇭🇷", "Morocco": "🇲🇦",
  "Uruguay": "🇺🇾", "Colombia": "🇨🇴", "Mexico": "🇲🇽", "USA": "🇺🇸",
  "United States": "🇺🇸", "Canada": "🇨🇦", "Japan": "🇯🇵", "South Korea": "🇰🇷",
  "Korea Republic": "🇰🇷", "Senegal": "🇸🇳", "Nigeria": "🇳🇬", "Ghana": "🇬🇭",
  "Australia": "🇦🇺", "Switzerland": "🇨🇭", "Denmark": "🇩🇰", "Poland": "🇵🇱",
  "Serbia": "🇷🇸", "Ecuador": "🇪🇨", "Iran": "🇮🇷", "Saudi Arabia": "🇸🇦",
  "Qatar": "🇶🇦", "Tunisia": "🇹🇳", "Cameroon": "🇨🇲", "Wales": "🏴󠁧󠁢󠁷󠁬󠁳󠁿",
  "Costa Rica": "🇨🇷", "Peru": "🇵🇪", "Chile": "🇨🇱", "Paraguay": "🇵🇾",
  "Sweden": "🇸🇪", "Norway": "🇳🇴", "Austria": "🇦🇹", "Scotland": "🏴󠁧󠁢󠁳󠁣󠁴󠁿",
  "Ukraine": "🇺🇦", "Turkey": "🇹🇷", "Egypt": "🇪🇬", "Ivory Coast": "🇨🇮",
  "Algeria": "🇩🇿", "South Africa": "🇿🇦", "New Zealand": "🇳🇿", "Jamaica": "🇯🇲",
  "Panama": "🇵🇦", "Honduras": "🇭🇳", "Vietnam": "🇻🇳", "Myanmar": "🇲🇲",
  "India": "🇮🇳", "Liechtenstein": "🇱🇮", "Gibraltar": "🇬🇮",
};
function getFlag(teamName) {
  if (FLAGS[teamName]) return FLAGS[teamName];
  console.warn(`No flag mapped for "${teamName}" — add it to FLAGS in server.js. Using 🏳️ for now.`);
  return "🏳️";
}

// ─── STATUS MAPPING ──────────────────────────────────────────────────────
// Fixture.GameState (fixtures/snapshot): 1 = scheduled, 6 = cancelled (per docs)
function statusFromFixture(fixture) {
  if (fixture.GameState === 6) return "cancelled";
  const start = new Date(fixture.StartTime).getTime();
  const now = Date.now();
  if (start > now) return "upcoming";
  return "live";
}

// Soccer feed "ended" phase codes (F=5, FET=10, FPE=13) — used if a Phase
// field is present on score entries. Field name unconfirmed until we see
// a real response; this checks a few likely names defensively.
const ENDED_PHASE_CODES = [5, 10, 13];
function isFinishedFromScores(scoreEntries) {
  if (!Array.isArray(scoreEntries) || !scoreEntries.length) return false;
  const last = scoreEntries[scoreEntries.length - 1];
  const phase = last.Phase ?? last.GamePhase ?? last.phase ?? null;
  if (phase == null) return false;
  return ENDED_PHASE_CODES.includes(phase);
}

// Extract "H-A" score string from stat keys (1 = P1 goals, 2 = P2 goals)
function extractScore(scoreEntries, participant1IsHome) {
  if (!Array.isArray(scoreEntries) || !scoreEntries.length) return "0-0";
  let p1Goals = 0;
  let p2Goals = 0;
  for (const entry of scoreEntries) {
    const key = entry.Key ?? entry.key ?? entry.StatKey;
    const value = entry.Value ?? entry.value ?? entry.StatValue;
    if (key === 1) p1Goals = Number(value) || p1Goals;
    if (key === 2) p2Goals = Number(value) || p2Goals;
  }
  const homeGoals = participant1IsHome ? p1Goals : p2Goals;
  const awayGoals = participant1IsHome ? p2Goals : p1Goals;
  return `${homeGoals}-${awayGoals}`;
}

// Extract total card counts from stat keys (3/4 = yellow home/away, 5/6 = red home/away)
function extractCards(scoreEntries, participant1IsHome) {
  if (!Array.isArray(scoreEntries) || !scoreEntries.length) {
    return { yellowHome: 0, yellowAway: 0, redHome: 0, redAway: 0, cornersHome: 0, cornersAway: 0 };
  }
  let p1Yellow = 0, p2Yellow = 0, p1Red = 0, p2Red = 0, p1Corners = 0, p2Corners = 0;
  for (const entry of scoreEntries) {
    const key = entry.Key ?? entry.key ?? entry.StatKey;
    const value = entry.Value ?? entry.value ?? entry.StatValue;
    if (key === 3) p1Yellow = Number(value) || p1Yellow;
    if (key === 4) p2Yellow = Number(value) || p2Yellow;
    if (key === 5) p1Red = Number(value) || p1Red;
    if (key === 6) p2Red = Number(value) || p2Red;
    if (key === 7) p1Corners = Number(value) || p1Corners;
    if (key === 8) p2Corners = Number(value) || p2Corners;
  }
  return {
    yellowHome: participant1IsHome ? p1Yellow : p2Yellow,
    yellowAway: participant1IsHome ? p2Yellow : p1Yellow,
    redHome: participant1IsHome ? p1Red : p2Red,
    redAway: participant1IsHome ? p2Red : p1Red,
    cornersHome: participant1IsHome ? p1Corners : p2Corners,
    cornersAway: participant1IsHome ? p2Corners : p1Corners,
  };
}

// ─── ODDS EXTRACTION (confirmed field names from real TxLINE response) ──
let hasLoggedRawPrices = false;
function extract1x2Odds(oddsEntries, participant1IsHome) {
  if (!Array.isArray(oddsEntries) || !oddsEntries.length) return null;

  for (const entry of oddsEntries) {
    if (entry.SuperOddsType !== "1X2_PARTICIPANT_RESULT") continue;

    const names = entry.PriceNames;
    const prices = entry.Prices;
    if (!Array.isArray(names) || !Array.isArray(prices) || names.length !== prices.length) continue;

    if (!hasLoggedRawPrices) {
      console.log(`Raw 1X2 prices (scale check): names=${JSON.stringify(names)} prices=${JSON.stringify(prices)}`);
      hasLoggedRawPrices = true;
    }

    let part1 = null, draw = null, part2 = null;
    for (let i = 0; i < names.length; i++) {
      const label = String(names[i]).toLowerCase();
      const price = Number(prices[i]);
      if (label === "part1") part1 = price;
      else if (label === "draw") draw = price;
      else if (label === "part2") part2 = price;
    }
    if (part1 && draw && part2) {
      const home = participant1IsHome ? part1 : part2;
      const away = participant1IsHome ? part2 : part1;
      return {
        oddsHome: home / 1000,
        oddsDraw: draw / 1000,
        oddsAway: away / 1000,
      };
    }
  }
  return null;
}

// ─── BET SETTLEMENT ──────────────────────────────────────────────────────
async function settleBets(fixtureId, winner) {
  if (!winner) return;
  const marketId = `wc_${fixtureId}`;
  const betsSnap = await db.collection("bets")
    .where("marketId", "==", marketId)
    .where("status", "==", "pending")
    .get();
  if (betsSnap.empty) return;

  const batch = db.batch();
  let settledCount = 0;
  for (const betDoc of betsSnap.docs) {
    const bet = betDoc.data();
    if (!bet.outcome) continue; // pre-fix bets with no outcome field — leave pending, don't guess
    const won = bet.outcome === winner;
    batch.update(betDoc.ref, { status: won ? "won" : "lost" });
    if (won) {
      batch.update(db.collection("users").doc(bet.uid), {
        balance: admin.firestore.FieldValue.increment(bet.payout),
      });
    }
    settledCount++;
  }
  await batch.commit();
  console.log(`Settled ${settledCount} bet(s) for ${marketId} (winner: ${winner}).`);
}

// ─── MAIN SYNC ────────────────────────────────────────────────────────────
async function syncMarkets() {
  console.log(`[${new Date().toISOString()}] Sync starting...`);

  const fixtures = await txlineGet("/fixtures/snapshot");
  console.log(`Fetched ${fixtures.length} fixtures.`);

  for (const fixture of fixtures) {
    try {
      const fixtureId = fixture.FixtureId;
      const homeTeam = fixture.Participant1IsHome ? fixture.Participant1 : fixture.Participant2;
      const awayTeam = fixture.Participant1IsHome ? fixture.Participant2 : fixture.Participant1;

      if (fixture.GameState === 6) {
        // cancelled — remove if it exists, skip otherwise
        await db.collection("markets").doc(`wc_${fixtureId}`).delete().catch(() => {});
        continue;
      }

      const [oddsData, scoreData] = await Promise.all([
        txlineGet(`/odds/snapshot/${fixtureId}`).catch(() => null),
        txlineGet(`/scores/snapshot/${fixtureId}`).catch(() => null),
      ]);

      const finished = isFinishedFromScores(scoreData);
      const status = finished ? "completed" : statusFromFixture(fixture);
      const score = extractScore(scoreData, fixture.Participant1IsHome);
      const cards = extractCards(scoreData, fixture.Participant1IsHome);
      const odds = extract1x2Odds(oddsData, fixture.Participant1IsHome);

      if (!odds && status !== "completed") {
        console.warn(`Fixture ${fixtureId} (${homeTeam} vs ${awayTeam}) — no odds yet, writing without them.`);
      }

      let winner = null;
      if (status === "completed") {
        const [h, a] = score.split("-").map(Number);
        winner = h > a ? "home" : a > h ? "away" : "draw";
      }

      const marketDoc = {
        home: homeTeam,
        away: awayTeam,
        homeFlag: getFlag(homeTeam),
        awayFlag: getFlag(awayTeam),
        status,
        score,
        winner,
        time: new Date(fixture.StartTime).toLocaleString("en-GB", {
          day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
        }),
        kickoffAt: fixture.StartTime, // raw ISO timestamp — used client-side to estimate elapsed match minute
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      if (odds) {
        marketDoc.oddsHome = odds.oddsHome;
        marketDoc.oddsDraw = odds.oddsDraw;
        marketDoc.oddsAway = odds.oddsAway;
      }

      await db.collection("markets").doc(`wc_${fixtureId}`).set(marketDoc, { merge: true });

      await maybeNotify(fixtureId, homeTeam, awayTeam, marketDoc, odds, cards, status);

      if (status === "completed") {
        await settleBets(fixtureId, marketDoc.winner);
      }
    } catch (err) {
      console.error(`Failed syncing fixture ${fixture.FixtureId}:`, err.message);
      // never let one bad fixture kill the whole cycle
    }
  }

  console.log(`[${new Date().toISOString()}] Sync complete.`);
}

// ─── LOOP (never crash the process on a bad cycle) ──────────────────────
async function syncLoop() {
  try {
    await syncMarkets();
  } catch (err) {
    console.error("Sync cycle failed:", err.response?.data || err.message);
  } finally {
    setTimeout(syncLoop, SYNC_INTERVAL_MS);
  }
}

// ─── HEALTHCHECK SERVER (Railway needs a listening port) ────────────────
const app = express();
app.use(express.static(__dirname));
app.use(express.json({ limit: "8mb" })); // profile photos as base64 can be a few MB
app.get("/", (req, res) => res.sendFile(__dirname + "/index.html"));
app.get("/health", (req, res) => res.json({ status: "ok", network: NETWORK }));

// ─── AVATAR UPLOAD (proxies to imgbb so the API key never reaches the browser) ─
app.post("/api/upload-avatar", async (req, res) => {
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) return res.status(400).json({ error: "No image provided" });
    if (!process.env.IMGBB_API_KEY) return res.status(500).json({ error: "Uploads not configured" });

    const cleaned = imageBase64.includes(",") ? imageBase64.split(",")[1] : imageBase64;
    const params = new URLSearchParams();
    params.append("key", process.env.IMGBB_API_KEY);
    params.append("image", cleaned);

    const response = await axios.post("https://api.imgbb.com/1/upload", params, { timeout: 15000 });
    const url = response.data?.data?.url;
    if (!url) return res.status(502).json({ error: "Upload failed" });
    res.json({ url });
  } catch (err) {
    console.error("Avatar upload failed:", err.message);
    res.status(500).json({ error: "Upload failed" });
  }
});

// SPA fallback: any other route (e.g. /home, /matches, /bets, /profile) still
// serves index.html so a page refresh doesn't 404 — the client-side router
// in index.html reads the URL and switches to the right tab.
app.get(/^\/(?!health).*/, (req, res) => res.sendFile(__dirname + "/index.html"));

app.listen(process.env.PORT || 3000, () => {
  console.log(`Server listening on port ${process.env.PORT || 3000}`);
  syncLoop();
});

// ─── GRACEFUL SHUTDOWN (stops Telegram polling before the old container dies) ──
function shutdown(signal) {
  console.log(`${signal} received — stopping Telegram polling before exit...`);
  if (bot) {
    bot.stopPolling().finally(() => process.exit(0));
  } else {
    process.exit(0);
  }
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
