# ⚽ GoalLine: The Future of Live Sports Prediction

**A real-time, mobile-first World Cup prediction market powered by TxLINE and Solana.**

> 🎥 **[WATCH THE 2-MINUTE DEMO VIDEO HERE]** *https://www.loom.com/share/f8b112b003b0423e92bccbe72320ee0b*  
> 🌐 **[TRY THE LIVE APP HERE]** *https://goal-line-production.up.railway.app/*

---

## 🌟 Why GoalLine? (Consumer Fan Experience)
Most prediction apps are clunky DeFi dashboards. GoalLine is built for **real fans**. We combined institutional-grade live odds with a seamless, mobile-first consumer experience:
- ⚡ **Live TxLINE Sync:** Odds and scores update automatically every ~65s.
- 🔔 **Smart Telegram Alerts:** Get instant push notifications for goals, red cards, and massive odds shifts.
- 📱 **Shareable Fan Cards:** One-tap generation of beautiful prediction cards to share on WhatsApp, Instagram, and Twitter.
- 🛡️ **Frictionless Onboarding:** Seamless Phantom Wallet connection + Firebase Auth.
- 🏆 **Auto-Settlement:** No manual grading. When the match ends, smart logic settles bets instantly.

---

## 🛠️ Tech Stack
- **Frontend:** Vanilla HTML/JS, Firebase Authentication, Firestore (Real-time listeners)
- **Backend:** Node.js, Express (Hosted on Railway)
- **Blockchain:** Solana Web3.js, Anchor (Devnet)
- **Data:** TxLINE API (Fixtures, Odds, Scores)
- **Notifications:** Telegram Bot API

---

## 📡 TxLINE Integration Depth
GoalLine leverages the TxLINE API to create a truly live experience:
1. `POST /auth/guest/start` — Secure guest JWT generation.
2. `GET /fixtures/snapshot` — Fetches live World Cup fixtures.
3. `GET /odds/snapshot/{fixtureId}` — Pulls real-time 1X2 odds for dynamic pricing.
4. `GET /scores/snapshot/{fixtureId}` — Tracks live match events to trigger auto-settlement and Telegram alerts.
5. **On-Chain:** `subscribe` instruction + `POST /api/token/activate` for Solana-based API access.

---

## 🏗️ Architecture
- **`index.html`**: Mobile-optimized frontend handling wallet connections, live UI updates, and shareable card generation.
- **`server.js`**: The brain. A Railway worker that continuously polls TxLINE, calculates implied probability shifts, updates Firestore, and triggers Telegram webhooks upon match completion.
- **`generateWallet.js` / `subscribeAndActivate.js`**: Utility scripts for one-time devnet wallet setup and TxLINE subscription management.

---

## 🌐 Network
**Solana Devnet** (Fully compliant with hackathon rules).

---

## 👥 Team
Built with ❤️ by **Gift**
