"use client";

import { useCallback, useEffect, useState } from "react";

import { HEMI_EXPLORER_URL, type LeaderboardEntry, type LeaderboardResponse } from "../../lib/chain";

function walletLabel(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function Board({ title, note, entries }: { title: string; note?: string; entries: LeaderboardEntry[] }) {
  return (
    <div className="chain-board">
      <h3>{title}</h3>
      {note && <p className="board-note">{note}</p>}
      {entries.length === 0 ? (
        <p className="board-empty">No recorded scores yet. The first slot is open.</p>
      ) : (
        <ol>
          {entries.map((entry, index) => (
            <li key={`${entry.runId}-${entry.player}`}>
              <span className="board-rank">{String(index + 1).padStart(2, "0")}</span>
              <a
                href={`${HEMI_EXPLORER_URL}/address/${entry.player}`}
                target="_blank"
                rel="noreferrer"
              >
                {walletLabel(entry.player)}
              </a>
              <strong>{entry.score.toLocaleString()}</strong>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function Leaderboards() {
  const [data, setData] = useState<LeaderboardResponse | null>(null);

  const refresh = useCallback(() => {
    void fetch("/api/chain/leaderboard")
      .then(async (response) => {
        if (!response.ok) throw new Error("Leaderboard unavailable");
        return response.json() as Promise<LeaderboardResponse>;
      })
      .then(setData)
      .catch(() => setData({ enabled: false, weekly: [], allTime: [], error: "Leaderboard unavailable." }));
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener("pop:score-submitted", refresh);
    return () => window.removeEventListener("pop:score-submitted", refresh);
  }, [refresh]);

  return (
    <section className="chain-leaderboards" aria-labelledby="chain-title">
      <div className="chain-head">
        <div>
          <p className="panel-kicker">HEMI MAINNET · ONCHAIN RECORD</p>
          <h2 id="chain-title">Proof lasts longer than patience.</h2>
        </div>
        <p>
          Practice without a wallet. After a run, connect to record it and pay the Hemi network gas.
          Each wallet can submit once every rolling 24 hours; only its best score ranks.
        </p>
      </div>
      {data?.enabled ? (
        <>
          <div className="chain-board-grid">
            <Board
              title={`THIS WEEK · W${data.weekId ?? 0}`}
              note="Resets every Monday at 00:00 UTC."
              entries={data.weekly}
            />
            <Board title="ALL-TIME HIGH" entries={data.allTime} />
          </div>
          {data.partial && (
            <p className="board-note is-warning" role="status">
              Showing a partial board while the index catches up.
            </p>
          )}
        </>
      ) : (
        <div className="chain-pending" role="status">
          <span className="status-lamp" aria-hidden="true" />
          <p>{data?.error || "Mainnet board activates when the score contract is deployed and configured."}</p>
        </div>
      )}
      {data?.contractAddress && (
        <a
          className="contract-link"
          href={`${HEMI_EXPLORER_URL}/address/${data.contractAddress}`}
          target="_blank"
          rel="noreferrer"
        >
          VIEW SCORE CONTRACT ↗
        </a>
      )}
    </section>
  );
}
