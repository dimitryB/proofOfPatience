/**
 * Pre-deployment guard for the Hemi Mainnet parameter file.
 *
 * `owner` and `seasonStart` are constructor arguments. The contract is not
 * upgradeable, so a wrong value cannot be corrected afterwards — deploying with
 * the committed example addresses would hand ownership to an address nobody
 * controls and name a verifier whose key does not exist, permanently.
 *
 * Run before `hardhat ignition deploy`. Exits non-zero on any problem.
 */
import { readFileSync } from "node:fs";
import { keccak256, stringToHex, isAddress, getAddress } from "viem";

const PARAMETERS_PATH = process.argv[2] ?? "ignition/parameters/hemi-mainnet.json";
const MODULE = "ProofOfPatienceScoresModule";
const EXPECTED_GAME_VERSION = keccak256(stringToHex("proof-of-patience-v1"));
const PLACEHOLDERS = new Set([
  "0x1111111111111111111111111111111111111111".toLowerCase(),
  "0x2222222222222222222222222222222222222222".toLowerCase(),
  "0x0000000000000000000000000000000000000000".toLowerCase(),
]);

const problems = [];
const notes = [];

function fail(message) {
  problems.push(message);
}

let parsed;
try {
  parsed = JSON.parse(readFileSync(PARAMETERS_PATH, "utf8"));
} catch (error) {
  console.error(`Could not read ${PARAMETERS_PATH}: ${error.message}`);
  console.error("Copy ignition/parameters/hemi-mainnet.example.json and fill in real values.");
  process.exit(1);
}

const params = parsed[MODULE];
if (!params) {
  console.error(`${PARAMETERS_PATH} has no "${MODULE}" section.`);
  process.exit(1);
}

const { owner, verifier, gameVersion, seasonStart } = params;

for (const [name, value] of Object.entries({ owner, verifier })) {
  if (typeof value !== "string" || !isAddress(value)) {
    fail(`${name} is not a valid address: ${JSON.stringify(value)}`);
    continue;
  }
  if (PLACEHOLDERS.has(value.toLowerCase())) {
    fail(`${name} is still the placeholder from the example file (${value}).`);
  }
  if (value !== getAddress(value)) {
    notes.push(`${name} is not checksummed. ${getAddress(value)} is the checksummed form.`);
  }
}

if (
  typeof owner === "string" &&
  typeof verifier === "string" &&
  isAddress(owner) &&
  isAddress(verifier) &&
  owner.toLowerCase() === verifier.toLowerCase()
) {
  // The whole point of the split is that a compromised web-service key cannot
  // administer the contract.
  fail("owner and verifier are the same address. They must be separate accounts.");
}

if (gameVersion !== EXPECTED_GAME_VERSION) {
  fail(`gameVersion is ${gameVersion}, expected ${EXPECTED_GAME_VERSION} (keccak256 of "proof-of-patience-v1").`);
}

if (!Number.isSafeInteger(seasonStart) || seasonStart <= 0) {
  fail(`seasonStart must be a positive Unix timestamp in seconds, got ${JSON.stringify(seasonStart)}.`);
} else {
  const now = Math.floor(Date.now() / 1_000);
  const date = new Date(seasonStart * 1_000);

  if (seasonStart % 86_400 !== 0) {
    fail(
      `seasonStart ${seasonStart} (${date.toISOString()}) is not a UTC midnight. ` +
        "Weekly boundaries derive from it and it cannot be changed after deployment.",
    );
  }
  if (date.getUTCDay() !== 1) {
    fail(
      `seasonStart ${seasonStart} falls on a ${date.toUTCString().slice(0, 3)}, not a Monday. ` +
        "Every weekly reset would land mid-week for the life of the contract.",
    );
  }
  if (seasonStart > now) {
    fail(`seasonStart ${date.toISOString()} is in the future. The constructor rejects that.`);
  }
  if (now - seasonStart > 60 * 86_400) {
    notes.push(
      `seasonStart is ${Math.floor((now - seasonStart) / 86_400)} days ago, so week zero is long past. ` +
        "Intentional for a mid-season redeploy; check it is what you meant.",
    );
  }
}

if (notes.length > 0) {
  console.log("Notes:");
  for (const note of notes) console.log(`  - ${note}`);
}

if (problems.length > 0) {
  console.error(`\n${PARAMETERS_PATH} is not safe to deploy:\n`);
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  console.error("\nThese values are permanent. Fix them before deploying.");
  process.exit(1);
}

console.log(`${PARAMETERS_PATH} checks out:`);
console.log(`  owner        ${getAddress(owner)}`);
console.log(`  verifier     ${getAddress(verifier)}`);
console.log(`  gameVersion  ${gameVersion}`);
console.log(`  seasonStart  ${seasonStart}  (${new Date(seasonStart * 1_000).toUTCString()})`);
