const { Keypair } = require("@solana/web3.js");

// Generate a brand new throwaway wallet — only for devnet testing
const wallet = Keypair.generate();

console.log("=== NEW DEVNET WALLET CREATED ===");
console.log("Public Address (copy this):", wallet.publicKey.toBase58());
console.log("Secret Key (KEEP THIS SAFE, needed for next step):");
console.log(JSON.stringify(Array.from(wallet.secretKey)));
console.log("==================================");
