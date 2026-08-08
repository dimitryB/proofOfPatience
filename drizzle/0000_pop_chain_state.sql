CREATE TABLE `pop_leaderboard_snapshots` (
	`contract_address` text PRIMARY KEY NOT NULL,
	`cursor` integer NOT NULL,
	`snapshot_json` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pop_rate_limits` (
	`bucket_key` text NOT NULL,
	`window_start` integer NOT NULL,
	`count` integer NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`bucket_key`, `window_start`)
);
--> statement-breakpoint
CREATE INDEX `idx_pop_rate_limits_expires_at` ON `pop_rate_limits` (`expires_at`);--> statement-breakpoint
CREATE TABLE `pop_run_tickets` (
	`run_id` text PRIMARY KEY NOT NULL,
	`issued_at` integer NOT NULL,
	`seed` text NOT NULL,
	`expires_at` integer NOT NULL,
	`payload_hash` text,
	`verifier_signature` text,
	`attested_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_pop_run_tickets_expires_at` ON `pop_run_tickets` (`expires_at`);