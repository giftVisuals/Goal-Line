# GoalLine

A live World Cup prediction market built on TxLINE.

## Core Idea
Users stake GL credits on match outcomes (Home/Draw/Away). Odds and scores 
sync live from TxLINE every ~65s. When a match completes, bets settle 
automatically — no manual grading.

## TxLINE Endpoints Used
- POST /auth/guest/start — guest JWT
- GET /fixtures/snapshot — live World Cup fixtures
- GET /odds/snapshot/{fixtureId} — 1X2 odds
- GET /scores/snapshot/{fixtureId} — live scores
- On-chain `subscribe` instruction + POST /api/token/activate — Solana-based API access (devnet)

## Architecture
- index.html — frontend (Firebase Auth + Firestore realtime listeners)
- server.js — Railway worker: polls TxLINE, writes to Firestore, auto-settles bets
- generateWallet.js / subscribeAndActivate.js — one-time devnet wallet + TxLINE subscription setup

## Network
Devnet (permitted per hackathon rules).
