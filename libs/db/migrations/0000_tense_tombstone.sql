CREATE TABLE `auth_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`purpose` text DEFAULT 'magic_link' NOT NULL,
	`email` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_tokens_token_hash_unique` ON `auth_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `auth_tokens_email_idx` ON `auth_tokens` (`email`);--> statement-breakpoint
CREATE TABLE `calendar_events` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`family_member_id` text NOT NULL,
	`provenance` text NOT NULL,
	`synth_key` text NOT NULL,
	`link_id` text,
	`source_event_id` text,
	`matched_rule_id` text,
	`task_id` text,
	`pending_decision_id` text,
	`external_uid` text,
	`external_recurrence_id` text,
	`dtstart` integer NOT NULL,
	`dtend` integer,
	`all_day` integer DEFAULT false NOT NULL,
	`summary` text,
	`location` text,
	`description` text,
	`content_hash` text NOT NULL,
	`tasks_built_hash` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`family_member_id`) REFERENCES `family_members`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`link_id`) REFERENCES `family_member_feeds`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_event_id`) REFERENCES `source_events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`matched_rule_id`) REFERENCES `link_rules`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`pending_decision_id`) REFERENCES `pending_decisions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_events_member_synth_key_uq` ON `calendar_events` (`family_member_id`,`synth_key`);--> statement-breakpoint
CREATE INDEX `calendar_events_member_start_idx` ON `calendar_events` (`family_member_id`,`dtstart`);--> statement-breakpoint
CREATE INDEX `calendar_events_task_idx` ON `calendar_events` (`task_id`);--> statement-breakpoint
CREATE INDEX `calendar_events_family_idx` ON `calendar_events` (`family_id`);--> statement-breakpoint
CREATE TABLE `event_mirrors` (
	`id` text PRIMARY KEY NOT NULL,
	`family_member_id` text NOT NULL,
	`calendar_event_id` text NOT NULL,
	`ical_uid` text NOT NULL,
	`sequence` integer DEFAULT 0 NOT NULL,
	`payload_hash` text,
	`external_ref` text,
	`status` text DEFAULT 'sent' NOT NULL,
	`sent_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`family_member_id`) REFERENCES `family_members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_mirrors_member_uid_uq` ON `event_mirrors` (`family_member_id`,`ical_uid`);--> statement-breakpoint
CREATE INDEX `event_mirrors_calendar_event_idx` ON `event_mirrors` (`calendar_event_id`);--> statement-breakpoint
CREATE TABLE `external_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`server_url` text,
	`username` text,
	`credentials_ref` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`credentials_ref`) REFERENCES `secrets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `external_accounts_user_idx` ON `external_accounts` (`user_id`);--> statement-breakpoint
CREATE TABLE `families` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`threading_threshold_minutes` integer DEFAULT 30 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `family_member_feeds` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`feed_id` text NOT NULL,
	`family_member_id` text NOT NULL,
	`weekday_mask` integer,
	`day_start` text,
	`day_end` text,
	`location` text,
	`default_task_type` text DEFAULT 'transition' NOT NULL,
	`default_dropoff_window_min` integer DEFAULT 15 NOT NULL,
	`default_pickup_window_min` integer DEFAULT 15 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`feed_id`) REFERENCES `feeds`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`family_member_id`) REFERENCES `family_members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fmf_feed_member_uq` ON `family_member_feeds` (`feed_id`,`family_member_id`);--> statement-breakpoint
CREATE INDEX `fmf_family_idx` ON `family_member_feeds` (`family_id`);--> statement-breakpoint
CREATE TABLE `family_members` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`user_id` text,
	`relation_name` text NOT NULL,
	`is_caretaker` integer DEFAULT false NOT NULL,
	`is_admin` integer DEFAULT false NOT NULL,
	`requires_caretaker` integer DEFAULT false NOT NULL,
	`generates_family_tasks` integer DEFAULT true NOT NULL,
	`color` text,
	`unified_default_task_type` text DEFAULT 'attendance' NOT NULL,
	`unified_dropoff_window_min` integer DEFAULT 15 NOT NULL,
	`unified_pickup_window_min` integer DEFAULT 15 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `family_members_family_idx` ON `family_members` (`family_id`);--> statement-breakpoint
CREATE INDEX `family_members_user_idx` ON `family_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `feeds` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`kind` text DEFAULT 'ics' NOT NULL,
	`url` text,
	`external_account_id` text,
	`source_calendar_id` text,
	`source_calendar_name` text,
	`mode` text NOT NULL,
	`timezone` text,
	`refresh_minutes` integer DEFAULT 360 NOT NULL,
	`etag` text,
	`last_synced_at` integer,
	`last_refresh_requested_at` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`external_account_id`) REFERENCES `external_accounts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `feeds_family_idx` ON `feeds` (`family_id`);--> statement-breakpoint
CREATE TABLE `identities` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_ref` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `identities_provider_ref_uq` ON `identities` (`provider`,`provider_ref`);--> statement-breakpoint
CREATE INDEX `identities_user_idx` ON `identities` (`user_id`);--> statement-breakpoint
CREATE TABLE `invites` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`family_id` text,
	`issued_by_member_id` text,
	`member_id` text,
	`email` text,
	`token` text NOT NULL,
	`grant_is_caretaker` integer DEFAULT true NOT NULL,
	`grant_is_admin` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`issued_by_member_id`) REFERENCES `family_members`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`member_id`) REFERENCES `family_members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invites_token_unique` ON `invites` (`token`);--> statement-breakpoint
CREATE INDEX `invites_status_idx` ON `invites` (`status`);--> statement-breakpoint
CREATE TABLE `link_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`link_id` text NOT NULL,
	`position` integer NOT NULL,
	`match_field` text NOT NULL,
	`match_op` text NOT NULL,
	`match_value` text,
	`outcome` text NOT NULL,
	`params` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`link_id`) REFERENCES `family_member_feeds`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `link_rules_link_position_idx` ON `link_rules` (`link_id`,`position`);--> statement-breakpoint
CREATE INDEX `link_rules_family_idx` ON `link_rules` (`family_id`);--> statement-breakpoint
CREATE TABLE `member_calendars` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`family_member_id` text NOT NULL,
	`target_external_account_id` text,
	`target_method` text NOT NULL,
	`target_calendar_id` text NOT NULL,
	`target_calendar_name` text,
	`alert_minutes` text,
	`active` integer DEFAULT true NOT NULL,
	`last_mirrored_at` integer,
	`last_read_back_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`family_member_id`) REFERENCES `family_members`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_external_account_id`) REFERENCES `external_accounts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `member_calendars_member_uq` ON `member_calendars` (`family_member_id`);--> statement-breakpoint
CREATE INDEX `member_calendars_family_idx` ON `member_calendars` (`family_id`);--> statement-breakpoint
CREATE TABLE `pending_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`feed_id` text NOT NULL,
	`link_id` text NOT NULL,
	`family_member_id` text NOT NULL,
	`source_event_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`source_content_hash` text NOT NULL,
	`resolved_types` text,
	`resolved_by_member_id` text,
	`resolved_at` integer,
	`dismissed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`feed_id`) REFERENCES `feeds`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`link_id`) REFERENCES `family_member_feeds`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`family_member_id`) REFERENCES `family_members`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_event_id`) REFERENCES `source_events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resolved_by_member_id`) REFERENCES `family_members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pending_decisions_link_source_uq` ON `pending_decisions` (`link_id`,`source_event_id`);--> statement-breakpoint
CREATE INDEX `pending_decisions_family_status_idx` ON `pending_decisions` (`family_id`,`status`);--> statement-breakpoint
CREATE TABLE `secrets` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text,
	`ciphertext` text NOT NULL,
	`iv` text NOT NULL,
	`wrapped_dek` text NOT NULL,
	`key_version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `source_events` (
	`id` text PRIMARY KEY NOT NULL,
	`feed_id` text NOT NULL,
	`family_id` text NOT NULL,
	`ical_uid` text NOT NULL,
	`recurrence_id` text,
	`dtstart` integer NOT NULL,
	`dtend` integer,
	`all_day` integer DEFAULT false NOT NULL,
	`summary` text,
	`location` text,
	`raw` text,
	`content_hash` text NOT NULL,
	`synthesized_hash` text,
	`dismissed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`feed_id`) REFERENCES `feeds`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_events_occurrence_uq` ON `source_events` (`feed_id`,`ical_uid`,`recurrence_id`);--> statement-breakpoint
CREATE INDEX `source_events_feed_idx` ON `source_events` (`feed_id`);--> statement-breakpoint
CREATE TABLE `task_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`family_member_id` text NOT NULL,
	`link_id` text,
	`scope` text DEFAULT 'this_calendar' NOT NULL,
	`position` integer NOT NULL,
	`match_field` text NOT NULL,
	`match_op` text NOT NULL,
	`match_value` text,
	`result_type` text NOT NULL,
	`dropoff_window_min` integer,
	`pickup_window_min` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`family_member_id`) REFERENCES `family_members`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`link_id`) REFERENCES `family_member_feeds`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `task_rules_member_position_idx` ON `task_rules` (`family_member_id`,`position`);--> statement-breakpoint
CREATE INDEX `task_rules_family_idx` ON `task_rules` (`family_id`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`calendar_event_id` text,
	`family_member_id` text NOT NULL,
	`type` text NOT NULL,
	`attendance_requirement` text,
	`dtstart` integer NOT NULL,
	`dtend` integer,
	`location` text,
	`status` text DEFAULT 'unowned' NOT NULL,
	`owner_member_id` text,
	`created_via` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`family_member_id`) REFERENCES `family_members`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_member_id`) REFERENCES `family_members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `tasks_family_status_idx` ON `tasks` (`family_id`,`status`);--> statement-breakpoint
CREATE INDEX `tasks_calendar_event_idx` ON `tasks` (`calendar_event_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`display_name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);