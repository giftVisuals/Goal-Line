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
    { command: "help", description: "Show all commands" },
  ]);

  const awaitingOtp = new Set(); // chatIds we just asked for an OTP, expecting plain text next

  const HELP_TEXT = "📋 *GoalLine Bot Commands*\n\n"
    + "/start — Welcome message & instructions\n"
    + "/link — Link your GoalLine account (I'll ask for your code)\n"
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

  bot.onText(/\/start(?:\s+(\w+))?/, async (msg, match) => {
    if (match[1]) {
      await linkTelegramCode(match[1], msg.chat.id);
      return;
    }
    bot.sendMessage(msg.chat.id, START_TEXT, { parse_mode: "Markdown", ...commandsButton });
  });

  bot.onText(/\/help/, (msg) => {
    bot.sendMessage(msg.chat.id, HELP_TEXT, { parse_mode: "Markdown" });
  });

  bot.onText(/^\/link(?:\s+(\w+))?$/, async (msg, match) => {
    if (match[1]) {
      awaitingOtp.delete(msg.chat.id);
      await linkTelegramCode(match[1], msg.chat.id);
      return;
    }
    awaitingOtp.add(msg.chat.id);
    bot.sendMessage(msg.chat.id, "🔑 Please send me your 6-digit code from Profile → Connect Telegram in the app. Just type it and hit send.");
  });

  // Free-text fallback: if we just asked this chat for an OTP, treat their next message as the code
  bot.on("message", async (msg) => {
    if (!msg.text || msg.text.startsWith("/")) return;
    if (!awaitingOtp.has(msg.chat.id)) return;
    awaitingOtp.delete(msg.chat.id);
    await linkTelegramCode(msg.text.trim(), msg.chat.id);
  });

  bot.on("callback_query", async (query) => {
    if (query.data === "show_commands") {
      await bot.answerCallbackQuery(query.id);
      bot.sendMessage(query.message.chat.id, HELP_TEXT, { parse_mode: "Markdown" });
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

async function notifyLinkedUsers(text) {
  if (!bot) return;
  const usersSnap = await db.collection("users").where("telegramChatId", "!=", null).get();
  await Promise.all(usersSnap.docs.map(doc =>
    bot.sendMessage(doc.data().telegramChatId, text, { parse_mode: "Markdown" })
      .catch(err => console.warn(`Telegram send failed for ${doc.id}:`, err.message))
  ));
}

// ─── PREVIOUS STATE CACHE (for detecting goals / odds shifts) ───────────
const prevFixtureState = new Map();
const ODDS_SHIFT_THRESHOLD = 0.5;

async function maybeNotify(fixtureId, homeTeam, awayTeam, marketDoc, odds, cards, status) {
  const prev = prevFixtureState.get(fixtureId);
  const curr = {
    score: marketDoc.score,
    oddsHome: odds?.oddsHome,
    oddsAway: odds?.oddsAway,
    redHome: cards.redHome, redAway: cards.redAway,
    yellowHome: cards.yellowHome, yellowAway: cards.yellowAway,
  };

  if (prev) {
    if (prev.score !== curr.score && curr.score !== "0-0") {
      await notifyLinkedUsers(`⚽ *GOAL!*\n${homeTeam} ${curr.score} ${awayTeam}`);
    }
    if (curr.redHome > prev.redHome) {
      await notifyLinkedUsers(`🟥 *RED CARD* — ${homeTeam}\n${homeTeam} ${curr.score} ${awayTeam}`);
    }
    if (curr.redAway > prev.redAway) {
      await notifyLinkedUsers(`🟥 *RED CARD* — ${awayTeam}\n${homeTeam} ${curr.score} ${awayTeam}`);
    }
    if (curr.yellowHome > prev.yellowHome) {
      await notifyLinkedUsers(`🟨 Yellow card — ${homeTeam}\n${homeTeam} ${curr.score} ${awayTeam}`);
    }
    if (curr.yellowAway > prev.yellowAway) {
      await notifyLinkedUsers(`🟨 Yellow card — ${awayTeam}\n${homeTeam} ${curr.score} ${awayTeam}`);
    }
    if (prev.oddsHome != null && curr.oddsHome != null) {
      const shift = Math.max(Math.abs(curr.oddsHome - prev.oddsHome), Math.abs(curr.oddsAway - prev.oddsAway));
      if (shift >= ODDS_SHIFT_THRESHOLD) {
        await notifyLinkedUsers(`📊 *Odds shift* — ${homeTeam} vs ${awayTeam}\nHome ${prev.oddsHome.toFixed(2)} → ${curr.oddsHome.toFixed(2)} | Away ${prev.oddsAway.toFixed(2)} → ${curr.oddsAway.toFixed(2)}`);
      }
    }
    if (prev.status !== "completed" && status === "completed") {
      await notifyLinkedUsers(`🏁 *Full-time*\n${homeTeam} ${curr.score} ${awayTeam}`);
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
    return { yellowHome: 0, yellowAway: 0, redHome: 0, redAway: 0 };
  }
  let p1Yellow = 0, p2Yellow = 0, p1Red = 0, p2Red = 0;
  for (const entry of scoreEntries) {
    const key = entry.Key ?? entry.key ?? entry.StatKey;
    const value = entry.Value ?? entry.value ?? entry.StatValue;
    if (key === 3) p1Yellow = Number(value) || p1Yellow;
    if (key === 4) p2Yellow = Number(value) || p2Yellow;
    if (key === 5) p1Red = Number(value) || p1Red;
    if (key === 6) p2Red = Number(value) || p2Red;
  }
  return {
    yellowHome: participant1IsHome ? p1Yellow : p2Yellow,
    yellowAway: participant1IsHome ? p2Yellow : p1Yellow,
    redHome: participant1IsHome ? p1Red : p2Red,
    redAway: participant1IsHome ? p2Red : p1Red,
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
app.get("/", (req, res) => res.sendFile(__dirname + "/index.html"));
app.get("/health", (req, res) => res.json({ status: "ok", network: NETWORK }));

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

