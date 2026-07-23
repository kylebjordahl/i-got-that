-- DESTRUCTIVE reset for the unified-calendar re-architecture (PRD 1). Drops
-- every application table AND Wrangler's migration bookkeeping table, so
-- `wrangler d1 migrations apply` re-applies the fresh single baseline from
-- scratch. There are no real customers; do NOT run against production. Driven
-- by tools/reset-staging.zsh.
--
-- DROP TABLE performs no foreign-key checks, so table order is irrelevant.

DROP TABLE IF EXISTS event_mirrors;
DROP TABLE IF EXISTS calendar_events;
DROP TABLE IF EXISTS member_calendars;
DROP TABLE IF EXISTS pending_decisions;
DROP TABLE IF EXISTS link_rules;
DROP TABLE IF EXISTS task_rules;
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS source_events;
DROP TABLE IF EXISTS family_member_feeds;
DROP TABLE IF EXISTS feeds;
DROP TABLE IF EXISTS external_accounts;
DROP TABLE IF EXISTS secrets;
DROP TABLE IF EXISTS invites;
DROP TABLE IF EXISTS family_members;
DROP TABLE IF EXISTS families;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS auth_tokens;
DROP TABLE IF EXISTS identities;
DROP TABLE IF EXISTS users;

-- Dropped-by-rename legacy tables from the pre-rework schema (harmless if absent).
DROP TABLE IF EXISTS deliveries;
DROP TABLE IF EXISTS classification_rules;
DROP TABLE IF EXISTS calendar_targets;
DROP TABLE IF EXISTS ownership_rules;

-- Wrangler's applied-migrations ledger, so the baseline re-applies cleanly.
DROP TABLE IF EXISTS d1_migrations;
