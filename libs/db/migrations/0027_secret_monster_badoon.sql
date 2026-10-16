-- Idempotent pipeline writes (#264): one generated task per (event, type), and a
-- per-family lease column for the cron tick.
--
-- The pipeline runs concurrently from several entry points with no lock, so
-- overlapping task-gen runs could each insert the same drop-off/pickup for an
-- event. Existing duplicates have to be resolved before the unique index can be
-- built. Index-only on purpose: NO table rebuild (see migration 0019 — DROP TABLE
-- `tasks` on D1 would cascade every claimed_task calendar event away).
--
-- Per (calendar_event_id, type) group of generated, event-derived tasks, keep
-- one winner: prefer an owned one (somebody has claimed it, and its claimed_task
-- event + travel-time override hang off it), then a dismissed one (a dismissal
-- is sticky, deleting the row would let task-gen resurrect the task), then the
-- oldest, tie-broken by id. The rest are non-winners, and no claim is
-- ever deleted:
--   1. an OWNED non-winner is DETACHED (calendar_event_id = NULL). A task with
--      no event is outside the partial index, keeps its task_owners rows and its
--      claimed calendar event, and task-gen treats it as free-standing.
--   2. every other non-winner (unowned or dismissed) is DELETED. A winner that
--      is not owned means the group had no owned row, so these carry no claim.
-- Correlated subquery rather than a window function. The winner is the minimum
-- under the ordering, so detaching or deleting other rows cannot change which
-- row it is. Step 1 runs first so step 2 only ever sees unclaimed losers.
UPDATE `tasks` SET `calendar_event_id` = NULL
WHERE `created_via` = 'generated'
  AND `calendar_event_id` IS NOT NULL
  AND `status` = 'owned'
  AND `id` <> (
    SELECT `k`.`id` FROM `tasks` AS `k`
    WHERE `k`.`created_via` = 'generated'
      AND `k`.`calendar_event_id` = `tasks`.`calendar_event_id`
      AND `k`.`type` = `tasks`.`type`
    ORDER BY
      CASE `k`.`status` WHEN 'owned' THEN 0 WHEN 'dismissed' THEN 1 ELSE 2 END,
      `k`.`created_at`,
      `k`.`id`
    LIMIT 1
  );--> statement-breakpoint
DELETE FROM `tasks`
WHERE `created_via` = 'generated'
  AND `calendar_event_id` IS NOT NULL
  AND `id` <> (
    SELECT `k`.`id` FROM `tasks` AS `k`
    WHERE `k`.`created_via` = 'generated'
      AND `k`.`calendar_event_id` = `tasks`.`calendar_event_id`
      AND `k`.`type` = `tasks`.`type`
    ORDER BY
      CASE `k`.`status` WHEN 'owned' THEN 0 WHEN 'dismissed' THEN 1 ELSE 2 END,
      `k`.`created_at`,
      `k`.`id`
    LIMIT 1
  );--> statement-breakpoint
ALTER TABLE `families` ADD `pipeline_lease_until` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_generated_event_type_uq` ON `tasks` (`calendar_event_id`,`type`) WHERE "tasks"."created_via" = 'generated' AND "tasks"."calendar_event_id" IS NOT NULL;
