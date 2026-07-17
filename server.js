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
  "Panama": "🇵🇦", "Honduras": "🇭🇳",
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

// ─── ODDS EXTRACTION (confirmed field names from real TxLINE response) ──
function extract1x2Odds(oddsEntries, participant1IsHome) {
  if (!Array.isArray(oddsEntries) || !oddsEntries.length) return null;

  for (const entry of oddsEntries) {
    if (entry.SuperOddsType !== "1X2_PARTICIPANT_RESULT") continue;

    const names = entry.PriceNames;
    const prices = entry.Prices;
    if (!Array.isArray(names) || !Array.isArray(prices) || names.length !== prices.length) continue;

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
      return { oddsHome: home, oddsDraw: draw, oddsAway: away };
    }
  }
  return null;
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
      const odds = extract1x2Odds(oddsData, fixture.Participant1IsHome);

      if (!odds && status !== "completed") {
        console.warn(`Fixture ${fixtureId} (${homeTeam} vs ${awayTeam}) — no odds yet, writing without them.`);
      }

      const marketDoc = {
        home: homeTeam,
        away: awayTeam,
        homeFlag: getFlag(homeTeam),
        awayFlag: getFlag(awayTeam),
        status,
        score,
        time: new Date(fixture.StartTime).toLocaleString("en-GB", {
          day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
        }),
        oddsHome: odds ? odds.oddsHome : null,
        oddsDraw: odds ? odds.oddsDraw : null,
        oddsAway: odds ? odds.oddsAway : null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      await db.collection("markets").doc(`wc_${fixtureId}`).set(marketDoc, { merge: true });
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
app.get("/", (req, res) => res.json({ status: "ok", network: NETWORK }));
app.listen(process.env.PORT || 3000, () => {
  console.log(`Server listening on port ${process.env.PORT || 3000}`);
  syncLoop();
});
