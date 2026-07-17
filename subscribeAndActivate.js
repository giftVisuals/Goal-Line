// subscribeAndActivate.js
// Run this ONCE after generateWallet.js. It:
//   1. Airdrops devnet SOL to your wallet (if needed)
//   2. Subscribes on-chain to the free World Cup tier (Service Level 1)
//   3. Activates your API token
//   4. Prints the JWT + API token to save as Railway env vars
//
// Usage: node subscribeAndActivate.js
// Requires: your wallet secret key array saved in an env var WALLET_SECRET_KEY
//   (a JSON array like the one printed by generateWallet.js)

const anchor = require("@coral-xyz/anchor");
const {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} = require("@solana/spl-token");
const { Connection, PublicKey, Keypair, SystemProgram } = require("@solana/web3.js");
const axios = require("axios");
const nacl = require("tweetnacl");

// ---- CONFIG: devnet ----
const rpcUrl = "https://api.devnet.solana.com";
const apiOrigin = "https://txline-dev.txodds.com";
const apiBaseUrl = `${apiOrigin}/api`;
const programId = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
const txlTokenMint = new PublicKey("4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG");

const SERVICE_LEVEL_ID = 1; // free World Cup + Int'l Friendlies tier
const DURATION_WEEKS = 4;
const SELECTED_LEAGUES = []; // empty = standard free bundle

async function main() {
  // ---- Load wallet from env var (never commit this file's output) ----
  const secretKeyRaw = process.env.WALLET_SECRET_KEY;
  if (!secretKeyRaw) {
    throw new Error("Set WALLET_SECRET_KEY env var to your wallet's secret key JSON array.");
  }
  const secretKey = Uint8Array.from(JSON.parse(secretKeyRaw));
  const payer = Keypair.fromSecretKey(secretKey);
  console.log("Wallet:", payer.publicKey.toBase58());

  const connection = new Connection(rpcUrl, "confirmed");
  const wallet = new anchor.Wallet(payer);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  // ---- Step 0: Airdrop devnet SOL if balance is low (never crash the process on faucet limits) ----
  let balance = await connection.getBalance(payer.publicKey);
  console.log("Current balance:", balance / 1e9, "SOL");
  if (balance < 0.05 * 1e9) {
    console.log("Requesting devnet airdrop...");
    try {
      const sig = await connection.requestAirdrop(payer.publicKey, 1e9); // 1 SOL
      await connection.confirmTransaction(sig, "confirmed");
      console.log("Airdrop confirmed:", sig);
      balance = await connection.getBalance(payer.publicKey);
    } catch (err) {
      console.warn("Airdrop failed (faucet likely rate-limited):", err.response?.data?.error?.message || err.message);
      console.warn("Try https://faucet.solana.com in a browser instead, then re-run this script.");
    }
  }
  if (balance < 0.002 * 1e9) {
    throw new Error("Wallet still has no usable SOL. Fund it manually at https://faucet.solana.com and re-run.");
  }

  // ---- Load IDL directly from the chain (no local file needed) ----
  console.log("Fetching IDL from devnet...");
  const txoracleIdl = await anchor.Program.fetchIdl(programId, provider);
  if (!txoracleIdl) {
    throw new Error(
      `No on-chain IDL found for program ${programId.toBase58()}. It may not be published on-chain — we'll need to find the real download link from TxLINE if this happens.`
    );
  }
  const program = new anchor.Program(txoracleIdl, provider);
  if (!program.programId.equals(programId)) {
    throw new Error(
      `Loaded IDL program ${program.programId.toBase58()} does not match devnet program ${programId.toBase58()}`
    );
  }

  // ---- Step 1: Subscribe on-chain ----
  const [tokenTreasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_treasury_v2")],
    program.programId
  );
  const tokenTreasuryVault = getAssociatedTokenAddressSync(
    txlTokenMint,
    tokenTreasuryPda,
    true,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const [pricingMatrixPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pricing_matrix")],
    program.programId
  );
  const userTokenAccount = getAssociatedTokenAddressSync(
    txlTokenMint,
    payer.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  console.log("Submitting subscribe transaction...");
  const txSig = await program.methods
    .subscribe(SERVICE_LEVEL_ID, DURATION_WEEKS)
    .accounts({
      user: payer.publicKey,
      pricingMatrix: pricingMatrixPda,
      tokenMint: txlTokenMint,
      userTokenAccount,
      tokenTreasuryVault,
      tokenTreasuryPda,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        userTokenAccount,
        payer.publicKey,
        txlTokenMint,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      ),
    ])
    .rpc();
  console.log("Subscribe tx confirmed:", txSig);

  // ---- Step 2: Get guest JWT ----
  const authResponse = await axios.post(`${apiOrigin}/auth/guest/start`);
  const jwt = authResponse.data.token;
  console.log("Got guest JWT");

  // ---- Step 3: Sign activation message ----
  const messageString = `${txSig}:${SELECTED_LEAGUES.join(",")}:${jwt}`;
  const message = new TextEncoder().encode(messageString);
  const signatureBytes = nacl.sign.detached(message, payer.secretKey);
  const walletSignature = Buffer.from(signatureBytes).toString("base64");

  // ---- Step 4: Activate API token ----
  const activationResponse = await axios.post(
    `${apiBaseUrl}/token/activate`,
    { txSig, walletSignature, leagues: SELECTED_LEAGUES },
    { headers: { Authorization: `Bearer ${jwt}` } }
  );
  const apiToken = activationResponse.data.token || activationResponse.data;

  console.log("\n=== SAVE THESE AS RAILWAY ENV VARS ===");
  console.log("TXLINE_GUEST_JWT=", jwt);
  console.log("TXLINE_API_TOKEN=", apiToken);
  console.log("=======================================\n");
  console.log("Note: the guest JWT may expire — server.js should refresh it via /auth/guest/start if a request 401s.");
}

main().catch((err) => {
  console.error("Failed:", err.response?.data || err.message);
  process.exit(1);
});
