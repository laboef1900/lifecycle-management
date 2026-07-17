-- Operator-rename parity for synced hosts (#196, epic #172).
--
-- Purely additive. Mirrors clusters.name_is_custom (added in
-- 20260717160000_add_sync_metadata): defaults to false, so every existing host
-- keeps working with no backfill. Once an operator edits a host's `name`, this
-- flips to true and inventory sync stops clobbering the label — a vCenter-side
-- rename then updates `external_name` and is surfaced as a hint instead. Before
-- this column, reconcileHosts overwrote a synced host's `name` on every pass.

ALTER TABLE "hosts"
    ADD COLUMN "name_is_custom" BOOLEAN NOT NULL DEFAULT false;
