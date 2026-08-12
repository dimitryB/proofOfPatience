"use client";

import { useEffect, useRef, useState } from "react";
import {
  createPublicClient,
  encodeFunctionData,
  http,
  isAddress,
  isHex,
  type Address,
  type Hex,
} from "viem";

import {
  GAME_VERSION,
  HEMI_CHAIN_ID,
  HEMI_CHAIN_ID_HEX,
  HEMI_EXPLORER_URL,
  HEMI_RPC_URL,
  hemiChain,
  proofOfPatienceScoresAbi,
  scoreTypedData,
  serializeScoreTypedData,
  type ChainConfigResponse,
  type FinalRunResult,
  type PlayerStatusResponse,
  type ScoreSubmissionPayload,
} from "../../lib/chain";

interface EthereumProvider {
  request<T>(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<T>;
}

interface TurnstileApi {
  render(
    el: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      "error-callback"?: () => void;
      "timeout-callback"?: () => void;
      "expired-callback"?: () => void;
    },
  ): string;
  remove(widgetId: string): void;
}

interface PreparedScore {
  contractAddress: Address;
  player: Address;
  submission: ScoreSubmissionPayload;
  playerSignature: Hex;
  verifierSignature?: Hex;
  transactionHash?: Hex;
}

type SubmitState =
  | "ready"
  | "connecting"
  | "switching"
  | "signing"
  | "attesting"
  | "confirming"
  | "confirmed"
  | "error";

const hemiPublicClient = createPublicClient({
  chain: hemiChain,
  transport: http(HEMI_RPC_URL),
});

const TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

function injectedProvider() {
  return (window as typeof window & { ethereum?: EthereumProvider }).ethereum;
}

function turnstileApi() {
  return (window as typeof window & { turnstile?: TurnstileApi }).turnstile;
}

function errorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error
    ? Number((error as { code: unknown }).code)
    : undefined;
}

function errorMessage(error: unknown) {
  // 4001 is the wallet's own "user rejected" code. Surfacing the raw provider
  // string here reads like a failure when it was a deliberate choice.
  if (errorCode(error) === 4_001) return "Cancelled in your wallet.";
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return "The score could not be recorded.";
}

function cooldownLabel(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp * 1_000));
}

function loadTurnstileScript(): Promise<void> {
  if (turnstileApi()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>("script[data-pop-turnstile]");
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("Verification failed to load.")));
      if (turnstileApi()) resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = TURNSTILE_SRC;
    script.async = true;
    script.defer = true;
    script.dataset.popTurnstile = "1";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Verification failed to load."));
    document.head.appendChild(script);
  });
}

/**
 * Fetches a fresh Turnstile token, rendering the widget into `container`.
 *
 * The Worker requires this token whenever the operator has set a site key, so
 * without it every attestation would 403. The token is single-use and short
 * lived, so it is fetched per submission rather than held.
 */
async function getTurnstileToken(siteKey: string, container: HTMLElement | null): Promise<string> {
  if (!container) throw new Error("Verification is unavailable.");
  await loadTurnstileScript();
  const turnstile = turnstileApi();
  if (!turnstile) throw new Error("Verification is unavailable.");

  let widgetId: string | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      widgetId = turnstile.render(container, {
        sitekey: siteKey,
        callback: (token) => resolve(token),
        "error-callback": () => reject(new Error("Verification failed. Try again.")),
        "timeout-callback": () => reject(new Error("Verification timed out. Try again.")),
        "expired-callback": () => reject(new Error("Verification expired. Try again.")),
      });
    });
  } finally {
    if (widgetId) {
      try {
        turnstile.remove(widgetId);
      } catch {
        /* widget already gone */
      }
    }
    container.innerHTML = "";
  }
}

async function ensureHemiNetwork(provider: EthereumProvider) {
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: HEMI_CHAIN_ID_HEX }],
    });
  } catch (error) {
    if (errorCode(error) !== 4_902) throw error;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: HEMI_CHAIN_ID_HEX,
          chainName: "Hemi Mainnet",
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: [HEMI_RPC_URL],
          blockExplorerUrls: [HEMI_EXPLORER_URL],
        },
      ],
    });
  }

  // Some wallets resolve the switch without actually switching. The typed-data
  // signature names chain 43111 explicitly, so it stays valid either way and the
  // mismatch would not surface until the transaction was sent.
  const active = await provider.request<string>({ method: "eth_chainId" });
  if (Number(active) !== HEMI_CHAIN_ID) {
    throw new Error("Switch your wallet to Hemi Mainnet to record this score.");
  }
}

export function OnchainScore({ result }: { result: FinalRunResult }) {
  const [config, setConfig] = useState<ChainConfigResponse | null>(null);
  const [state, setState] = useState<SubmitState>("ready");
  const [message, setMessage] = useState("");
  const [explorerUrl, setExplorerUrl] = useState("");
  const turnstileRef = useRef<HTMLDivElement>(null);
  const preparedRef = useRef<PreparedScore | null>(null);

  useEffect(() => {
    let active = true;
    void fetch("/api/chain/config")
      .then(async (response) => {
        if (!response.ok) throw new Error("Hemi configuration is unavailable.");
        return response.json() as Promise<ChainConfigResponse>;
      })
      .then((next) => {
        if (active) setConfig(next);
      })
      .catch(() => {
        if (active) {
          setConfig({
            enabled: false,
            submissionEnabled: false,
            reason: "Hemi configuration is unavailable.",
            chainId: HEMI_CHAIN_ID,
            chainName: "Hemi Mainnet",
            rpcUrl: HEMI_RPC_URL,
            explorerUrl: HEMI_EXPLORER_URL,
            gameVersion: GAME_VERSION,
          });
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const submit = async () => {
    if (!config?.submissionEnabled || !config.contractAddress || !result.ticket) return;
    const provider = injectedProvider();
    if (!provider) {
      setState("error");
      setMessage("Install or open an EVM wallet to record this score.");
      return;
    }

    try {
      setMessage("");
      setState("connecting");
      const accounts = await provider.request<string[]>({ method: "eth_requestAccounts" });
      const player = accounts[0];
      if (!isAddress(player)) throw new Error("The wallet did not return a valid account.");

      let prepared = preparedRef.current;
      const preparedForThisWallet =
        prepared?.player.toLowerCase() === player.toLowerCase() &&
        prepared.contractAddress.toLowerCase() === config.contractAddress.toLowerCase();
      if (prepared && !preparedForThisWallet) {
        if (prepared.verifierSignature || prepared.transactionHash) {
          throw new Error("Reconnect the wallet that signed this recorded score.");
        }
        preparedRef.current = null;
        prepared = null;
      }
      if (
        prepared &&
        !prepared.verifierSignature &&
        prepared.submission.deadline <= Math.floor(Date.now() / 1_000) + 30
      ) {
        preparedRef.current = null;
        prepared = null;
      }

      // A dedicated status route: this used to call the leaderboard endpoint,
      // which rebuilt both boards to read one timestamp.
      if (!prepared?.transactionHash) {
        const statusResponse = await fetch(`/api/chain/status?address=${encodeURIComponent(player)}`);
        if (statusResponse.ok) {
          const status = (await statusResponse.json()) as PlayerStatusResponse;
          if (status.blocked) throw new Error("This wallet cannot record scores.");
          if (status.nextEligibleAt > Math.floor(Date.now() / 1_000)) {
            setState("error");
            setMessage(`This wallet can record again ${cooldownLabel(status.nextEligibleAt)}.`);
            return;
          }
        }
      }

      setState("switching");
      await ensureHemiNetwork(provider);

      if (!prepared) {
        const submission: ScoreSubmissionPayload = {
          runId: result.runId,
          gameVersion: GAME_VERSION,
          player: player as Address,
          score: result.score,
          survivalSeconds: result.survivalSeconds,
          answered: result.answered,
          shots: result.shots,
          hits: result.hits,
          seed: result.seed,
          traceHash: result.traceHash,
          deadline: Math.floor(Date.now() / 1_000) + 10 * 60,
        };
        setState("signing");
        const playerSignature = await provider.request<Hex>({
          method: "eth_signTypedData_v4",
          params: [player, serializeScoreTypedData(submission, config.contractAddress)],
        });
        prepared = {
          contractAddress: config.contractAddress,
          player: player as Address,
          submission,
          playerSignature,
        };
        // Preserve the exact signed payload across Turnstile, network and wallet
        // failures. A retry must not create a new deadline or a second attestation.
        preparedRef.current = prepared;
      }

      const typedData = scoreTypedData(prepared.submission, prepared.contractAddress);
      if (!prepared.verifierSignature) {
        setState("attesting");
        const turnstileToken = config.turnstileSiteKey
          ? await getTurnstileToken(config.turnstileSiteKey, turnstileRef.current)
          : undefined;

        const response = await fetch("/api/chain/attest", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            submission: prepared.submission,
            playerSignature: prepared.playerSignature,
            runProof: { runId: result.runId, issuedAt: result.issuedAt, ticket: result.ticket },
            turnstileToken,
          }),
        });
        const payload = (await response.json()) as {
          error?: string;
          nextEligibleAt?: number;
          verifierSignature?: Hex;
        };
        if (!response.ok) {
          if (payload.nextEligibleAt) {
            throw new Error(`This wallet can record again ${cooldownLabel(payload.nextEligibleAt)}.`);
          }
          throw new Error(payload.error || "The score could not be attested.");
        }
        if (!payload.verifierSignature || !isHex(payload.verifierSignature)) {
          throw new Error("The verifier did not return a valid attestation.");
        }
        prepared.verifierSignature = payload.verifierSignature;
      }

      const verifierSignature = prepared.verifierSignature;
      if (!verifierSignature) throw new Error("The score has no verifier attestation.");

      if (!prepared.transactionHash) {
        setState("confirming");
        setMessage("Review the Hemi network gas estimate in your wallet.");
        prepared.transactionHash = await provider.request<Hex>({
          method: "eth_sendTransaction",
          params: [
            {
              from: player,
              to: prepared.contractAddress,
              data: encodeFunctionData({
                abi: proofOfPatienceScoresAbi,
                functionName: "submitScore",
                args: [typedData.message, prepared.playerSignature, verifierSignature],
              }),
            },
          ],
        });
      }
      const transactionHash = prepared.transactionHash;
      setMessage("Transaction sent. Waiting for Hemi confirmation…");
      const receipt = await hemiPublicClient.waitForTransactionReceipt({
        hash: transactionHash,
        confirmations: 1,
      });
      if (receipt.status !== "success") throw new Error("The Hemi transaction reverted.");

      setExplorerUrl(`${HEMI_EXPLORER_URL}/tx/${transactionHash}`);
      setState("confirmed");
      setMessage("Recorded on Hemi. This wallet can submit again in 24 hours.");
      window.dispatchEvent(new CustomEvent("pop:score-submitted"));
    } catch (error) {
      setState("error");
      setMessage(errorMessage(error));
    }
  };

  const disabled =
    !config?.submissionEnabled || !result.ticket || (state !== "ready" && state !== "error");
  const label =
    config === null
      ? "CHECKING HEMI…"
      : !config.enabled
        ? "HEMI SETUP PENDING"
        : config.paused
          ? "SUBMISSIONS PAUSED"
          : !config.submissionEnabled
            ? "SUBMISSIONS PAUSED"
            : !result.ticket
              ? "PRACTICE RUN ONLY"
              : state === "connecting"
                ? "CONNECTING…"
                : state === "switching"
                  ? "SWITCHING NETWORK…"
                  : state === "signing"
                    ? "SIGN SCORE…"
                    : state === "attesting"
                      ? "VERIFYING SCORE…"
                      : state === "confirming"
                        ? "CONFIRM GAS…"
                        : state === "confirmed"
                          ? "VIEW LEADERBOARD"
                          : "RECORD ON HEMI";

  return (
    <div className="onchain-submit" title={message || config?.reason || undefined}>
      {state === "confirmed" && explorerUrl ? (
        <a className="primary-control chain-control" href="#leaderboards">
          <span className="control-label">{label}</span>
          <span aria-hidden="true">↓</span>
        </a>
      ) : (
        <button type="button" className="primary-control chain-control" onClick={submit} disabled={disabled}>
          <span className="control-label">{label}</span>
          <span className="chain-mark" aria-hidden="true">H</span>
        </button>
      )}
      <div ref={turnstileRef} className="turnstile-slot" aria-hidden={state !== "attesting"} />
      <p className={state === "error" ? "chain-status is-error" : "chain-status"} aria-live="polite">
        {message || config?.reason || "Wallet pays network gas · one recorded score every 24 hours"}
        {state === "confirmed" && explorerUrl && (
          <>
            {" "}
            <a href={explorerUrl} target="_blank" rel="noreferrer">
              View transaction ↗
            </a>
          </>
        )}
      </p>
    </div>
  );
}
