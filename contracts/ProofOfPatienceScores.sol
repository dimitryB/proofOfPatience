// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title Proof of Patience score registry
/// @notice Records one verifier-approved score per wallet every rolling 24 hours,
///         and keeps a weekly board and a permanent all-time board.
/// @dev The submitting wallet normally pays gas, but any relayer may submit a
///      fully signed result: both signatures bind every field, so no submitter
///      can change an outcome.
///
///      Trust model, stated plainly. The verifier attests results off-chain and
///      is trusted to do so honestly. This contract does not re-simulate a run.
///      What it does is bound what a compromised or buggy verifier can express,
///      and give the owner a way to undo damage after the fact:
///
///        - every result field is bounded, including `score`, which is capped
///          both absolutely and by a ceiling derived from the claimed work
///          (see `scoreCeiling`). That ceiling is the only check here a
///          compromised verifier cannot assert its way past;
///        - the owner can pause submissions, void an individual result from
///          either board, and block an address;
///        - `seed` and `traceHash` are carried in the signed payload and emitted,
///          so a future deterministic-replay verifier can be turned on without
///          redeploying — the EIP-712 type hash is fixed at deployment.
///
///      There is no "season" reset. The all-time board is permanent; a poisoned
///      entry is removed by naming it (`voidAllTimeBest`), not by wiping the
///      board. This keeps the all-time-high board meaningful across the life of
///      the contract.
contract ProofOfPatienceScores is EIP712, Ownable2Step, Pausable {
    uint64 public constant SUBMISSION_COOLDOWN = 24 hours;
    uint32 public constant MAX_SURVIVAL_SECONDS = 5 minutes;
    uint32 public constant MAX_ANSWERED = 1_000;
    uint32 public constant MAX_SHOTS = 10_000;
    uint256 public constant MAX_PAGE_SIZE = 100;

    /// @notice Absolute ceiling on a recorded score.
    /// @dev The game's honest maximum at the `MAX_ANSWERED` / `MAX_SHOTS` limits is
    ///      about 201,700,000. This sits modestly above that so ordinary tuning does
    ///      not require a redeployment, while keeping a compromised verifier many
    ///      orders of magnitude away from `type(uint64).max`.
    uint64 public constant MAX_SCORE = 250_000_000;

    /// @notice Longest a signed result may stay submittable once it reaches the chain.
    uint64 public constant MAX_DEADLINE_WINDOW = 1 hours;

    bytes32 public constant SCORE_SUBMISSION_TYPEHASH = keccak256(
        "ScoreSubmission(bytes32 runId,bytes32 gameVersion,address player,uint64 score,uint32 survivalSeconds,uint32 answered,uint32 shots,uint32 hits,bytes32 seed,bytes32 traceHash,uint64 deadline)"
    );

    /// @dev Domain-separates the verifier's attestation from the player's own
    ///      signature. Without this, one signature satisfies both checks whenever
    ///      the player happens to be the verifier.
    ///      `scoreHash` is the player's FULL EIP-712 digest, not the struct hash.
    bytes32 public constant VERIFIER_ATTESTATION_TYPEHASH =
        keccak256("VerifierAttestation(bytes32 scoreHash)");

    struct ScoreSubmission {
        bytes32 runId;
        bytes32 gameVersion;
        address player;
        uint64 score;
        uint32 survivalSeconds;
        uint32 answered;
        uint32 shots;
        uint32 hits;
        bytes32 seed;
        bytes32 traceHash;
        uint64 deadline;
    }

    struct StoredScore {
        bytes32 runId;
        address player;
        uint64 score;
        uint32 survivalSeconds;
        uint32 answered;
        uint32 shots;
        uint32 hits;
        uint64 submittedAt;
    }

    error CooldownActive(uint64 nextEligibleAt);
    error DuplicateRun(bytes32 runId);
    error ExpiredSignature(uint64 deadline);
    error DeadlineTooDistant(uint64 deadline);
    error GameVersionMismatch(bytes32 expected, bytes32 received);
    error InvalidPlayerSignature();
    error InvalidVerifierSignature();
    error InvalidResult();
    error ScoreAboveCeiling(uint64 score, uint256 ceiling);
    error InvalidVerifier();
    error PageTooLarge(uint256 requested);
    error PlayerBlocked(address player);
    error NothingToVoid(address player, uint256 weekId);
    error VoidTargetMismatch(bytes32 stored, bytes32 expected);

    /// @dev Carries the whole stored result plus the replay fields, so an offchain
    ///      indexer can build both leaderboards from logs alone and never has to
    ///      scan the player arrays.
    event ScoreSubmitted(
        bytes32 indexed runId,
        address indexed player,
        uint256 indexed weekId,
        StoredScore result,
        bytes32 seed,
        bytes32 traceHash
    );
    event AllTimeBestUpdated(address indexed player, uint64 score, bytes32 indexed runId);
    event AllTimeBestVoided(address indexed player, bytes32 indexed runId);
    event WeeklyScoreVoided(address indexed player, uint256 indexed weekId, bytes32 indexed runId);
    event PlayerBlockedSet(address indexed player, bool blocked);
    event VerifierUpdated(address indexed previousVerifier, address indexed newVerifier);
    event GameVersionUpdated(bytes32 indexed previousVersion, bytes32 indexed newVersion);

    address public verifier;
    bytes32 public activeGameVersion;
    /// @notice Anchor for weekly boundaries. A UTC-midnight Monday.
    uint64 public immutable seasonStart;

    mapping(address player => uint64 timestamp) public nextEligibleAt;
    mapping(bytes32 runId => bool used) public usedRunIds;
    mapping(address player => bool blocked) public blockedPlayers;

    mapping(address player => StoredScore score) public allTimeBest;
    mapping(uint256 weekId => mapping(address player => StoredScore score)) public weeklyScore;

    address[] private _allPlayers;
    mapping(address player => bool seen) private _knownPlayer;
    mapping(uint256 weekId => address[] players) private _weeklyPlayers;
    mapping(uint256 weekId => mapping(address player => bool seen)) private _knownWeeklyPlayer;

    constructor(
        address initialOwner,
        address initialVerifier,
        bytes32 initialGameVersion,
        uint64 initialSeasonStart
    ) EIP712("Proof of Patience", "1") Ownable(initialOwner) {
        if (initialVerifier == address(0)) revert InvalidVerifier();
        if (initialGameVersion == bytes32(0) || initialSeasonStart > block.timestamp) {
            revert InvalidResult();
        }
        // Weekly boundaries derive from this value and it is immutable, so a start
        // that is not a UTC midnight silently skews every week for the life of the
        // contract. Zero is rejected too: it would make `currentWeekId` an absolute
        // epoch-week number rather than a board-relative one.
        if (initialSeasonStart == 0 || initialSeasonStart % 1 days != 0) revert InvalidResult();

        verifier = initialVerifier;
        activeGameVersion = initialGameVersion;
        seasonStart = initialSeasonStart;
    }

    /// @notice Submit a signed result. The connected player normally sends and pays for this transaction.
    /// @dev Split into three private steps purely to keep `submitScore` inside the
    ///      stack limit under legacy codegen; the ordering is unchanged.
    function submitScore(
        ScoreSubmission calldata submission,
        bytes calldata playerSignature,
        bytes calldata verifierSignature
    ) external whenNotPaused {
        _checkSubmission(submission);
        _checkSignatures(submission, playerSignature, verifierSignature);
        _record(submission);
    }

    /// @notice Highest score reachable from a run that answered `answered` questions
    ///         with `hits` correct letters.
    /// @dev Derived from the game's award sites, then given roughly 5x headroom so
    ///      ordinary tuning cannot invalidate honest runs. The quadratic term is the
    ///      per-answer award, which scales with a combo counter that is uncapped in
    ///      the game but cannot exceed `answered`. Widened to uint256 before
    ///      multiplying, so it cannot overflow for any uint32 inputs.
    function scoreCeiling(uint32 answered, uint32 hits) public pure returns (uint256) {
        uint256 a = answered;
        uint256 h = hits;
        return (1_000 * a * a) + (5_000 * a) + (10 * h * a) + (50 * h) + 20_000;
    }

    function currentWeekId() public view returns (uint256) {
        return (block.timestamp - seasonStart) / 1 weeks;
    }

    function allPlayerCount() external view returns (uint256) {
        return _allPlayers.length;
    }

    function weeklyPlayerCount(uint256 weekId) external view returns (uint256) {
        return _weeklyPlayers[weekId].length;
    }

    /// @notice Returns an unsorted page of the permanent all-time board.
    /// @dev Consumers sort it by score offchain. Voided entries are returned as an
    ///      all-zero struct; filter on `runId != 0`.
    function getAllTimeScores(uint256 offset, uint256 limit) external view returns (StoredScore[] memory) {
        _validatePage(limit);
        uint256 end = _pageEnd(offset, limit, _allPlayers.length);
        StoredScore[] memory page = new StoredScore[](end - offset);
        for (uint256 index = offset; index < end; ++index) {
            page[index - offset] = allTimeBest[_allPlayers[index]];
        }
        return page;
    }

    /// @notice Returns an unsorted page of one week's board.
    function getWeeklyScores(uint256 weekId, uint256 offset, uint256 limit)
        external
        view
        returns (StoredScore[] memory)
    {
        _validatePage(limit);
        address[] storage players = _weeklyPlayers[weekId];
        uint256 end = _pageEnd(offset, limit, players.length);
        StoredScore[] memory page = new StoredScore[](end - offset);
        for (uint256 index = offset; index < end; ++index) {
            page[index - offset] = weeklyScore[weekId][players[index]];
        }
        return page;
    }

    /* ------------------------------ administration ----------------------------- */

    /// @notice Halt submissions. Every read stays available.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Erase one player's all-time result.
    /// @dev Incident response, not routine moderation. The contract keeps only a
    ///      best per board, so voiding resets the player to no result there rather
    ///      than restoring an earlier score. The run ID stays spent.
    ///
    ///      Each board is voided by its own call, and each call names the exact run
    ///      it expects to delete. A void is the one operation performed under
    ///      pressure against a board an attacker is actively writing to, so it
    ///      fails loudly on a stale or mistyped target rather than deleting whatever
    ///      happens to be there.
    function voidAllTimeBest(address player, bytes32 expectedRunId) external onlyOwner {
        bytes32 stored = allTimeBest[player].runId;
        if (stored == bytes32(0)) revert NothingToVoid(player, 0);
        if (stored != expectedRunId) revert VoidTargetMismatch(stored, expectedRunId);

        delete allTimeBest[player];
        emit AllTimeBestVoided(player, stored);
    }

    /// @notice Erase one player's result on a single week.
    function voidWeeklyScore(address player, uint256 weekId, bytes32 expectedRunId) external onlyOwner {
        bytes32 stored = weeklyScore[weekId][player].runId;
        if (stored == bytes32(0)) revert NothingToVoid(player, weekId);
        if (stored != expectedRunId) revert VoidTargetMismatch(stored, expectedRunId);

        delete weeklyScore[weekId][player];
        emit WeeklyScoreVoided(player, weekId, stored);
    }

    /// @notice The week a stored all-time result was recorded in.
    /// @dev Saves working a week number out by hand mid-incident. Read the weekly
    ///      board to confirm the run you want gone actually lives in this week
    ///      before calling `voidWeeklyScore`, and void the weekly board before the
    ///      all-time board — this reads the all-time entry, so voiding that first
    ///      destroys the lookup.
    function weekIdOfAllTimeBest(address player) external view returns (uint256) {
        uint64 submittedAt = allTimeBest[player].submittedAt;
        if (submittedAt == 0) revert NothingToVoid(player, 0);
        return (submittedAt - seasonStart) / 1 weeks;
    }

    /// @notice Prevent an address from recording further results.
    function setPlayerBlocked(address player, bool blocked) external onlyOwner {
        blockedPlayers[player] = blocked;
        emit PlayerBlockedSet(player, blocked);
    }

    function setVerifier(address newVerifier) external onlyOwner {
        if (newVerifier == address(0)) revert InvalidVerifier();
        address previous = verifier;
        verifier = newVerifier;
        emit VerifierUpdated(previous, newVerifier);
    }

    function setActiveGameVersion(bytes32 newVersion) external onlyOwner {
        if (newVersion == bytes32(0)) revert InvalidResult();
        bytes32 previous = activeGameVersion;
        activeGameVersion = newVersion;
        emit GameVersionUpdated(previous, newVersion);
    }

    /* --------------------------------- internals -------------------------------- */

    function _checkSubmission(ScoreSubmission calldata submission) private view {
        if (submission.player == address(0) || submission.runId == bytes32(0)) {
            revert InvalidResult();
        }
        if (blockedPlayers[submission.player]) revert PlayerBlocked(submission.player);
        if (submission.gameVersion != activeGameVersion) {
            revert GameVersionMismatch(activeGameVersion, submission.gameVersion);
        }
        if (submission.deadline < block.timestamp) revert ExpiredSignature(submission.deadline);
        if (submission.deadline > block.timestamp + MAX_DEADLINE_WINDOW) {
            revert DeadlineTooDistant(submission.deadline);
        }
        if (usedRunIds[submission.runId]) revert DuplicateRun(submission.runId);

        uint64 eligibleAt = nextEligibleAt[submission.player];
        if (block.timestamp < eligibleAt) revert CooldownActive(eligibleAt);

        if (
            submission.survivalSeconds > MAX_SURVIVAL_SECONDS ||
            submission.answered > MAX_ANSWERED ||
            submission.shots > MAX_SHOTS ||
            submission.hits > submission.shots ||
            submission.score > MAX_SCORE
        ) revert InvalidResult();

        uint256 ceiling = scoreCeiling(submission.answered, submission.hits);
        if (submission.score > ceiling) revert ScoreAboveCeiling(submission.score, ceiling);
    }

    function _checkSignatures(
        ScoreSubmission calldata submission,
        bytes calldata playerSignature,
        bytes calldata verifierSignature
    ) private view {
        bytes32 scoreHash = _hashSubmission(submission);
        if (ECDSA.recover(scoreHash, playerSignature) != submission.player) {
            revert InvalidPlayerSignature();
        }
        if (ECDSA.recover(_hashAttestation(scoreHash), verifierSignature) != verifier) {
            revert InvalidVerifierSignature();
        }
    }

    function _record(ScoreSubmission calldata submission) private {
        uint64 submittedAt = uint64(block.timestamp);
        uint256 weekId = currentWeekId();

        StoredScore memory result = StoredScore({
            runId: submission.runId,
            player: submission.player,
            score: submission.score,
            survivalSeconds: submission.survivalSeconds,
            answered: submission.answered,
            shots: submission.shots,
            hits: submission.hits,
            submittedAt: submittedAt
        });

        usedRunIds[submission.runId] = true;
        nextEligibleAt[submission.player] = submittedAt + SUBMISSION_COOLDOWN;

        if (!_knownWeeklyPlayer[weekId][submission.player]) {
            _knownWeeklyPlayer[weekId][submission.player] = true;
            _weeklyPlayers[weekId].push(submission.player);
        }
        if (
            weeklyScore[weekId][submission.player].runId == bytes32(0) ||
            result.score > weeklyScore[weekId][submission.player].score
        ) {
            weeklyScore[weekId][submission.player] = result;
        }

        if (!_knownPlayer[submission.player]) {
            _knownPlayer[submission.player] = true;
            _allPlayers.push(submission.player);
        }
        if (
            allTimeBest[submission.player].runId == bytes32(0) ||
            result.score > allTimeBest[submission.player].score
        ) {
            allTimeBest[submission.player] = result;
            emit AllTimeBestUpdated(submission.player, result.score, result.runId);
        }

        emit ScoreSubmitted(result.runId, result.player, weekId, result, submission.seed, submission.traceHash);
    }

    function _hashSubmission(ScoreSubmission calldata submission) private view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    SCORE_SUBMISSION_TYPEHASH,
                    submission.runId,
                    submission.gameVersion,
                    submission.player,
                    submission.score,
                    submission.survivalSeconds,
                    submission.answered,
                    submission.shots,
                    submission.hits,
                    submission.seed,
                    submission.traceHash,
                    submission.deadline
                )
            )
        );
    }

    function _hashAttestation(bytes32 scoreHash) private view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(VERIFIER_ATTESTATION_TYPEHASH, scoreHash)));
    }

    function _validatePage(uint256 limit) private pure {
        if (limit > MAX_PAGE_SIZE) revert PageTooLarge(limit);
    }

    function _pageEnd(uint256 offset, uint256 limit, uint256 length) private pure returns (uint256) {
        if (offset >= length) return offset;
        uint256 end = offset + limit;
        return end < length ? end : length;
    }
}
