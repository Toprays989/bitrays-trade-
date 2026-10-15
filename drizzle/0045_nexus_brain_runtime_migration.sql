-- New signals are owned by the unified NEXUS market brain. Existing
-- execution traces and live positions keep their immutable config_version
-- and config_snapshot_json, so this migration does not alter protection for
-- positions opened by the compatibility runtime.
UPDATE `strategies`
SET
  `brain_template` = 'NEXUS_MARKET_BRAIN',
  `strategy_type` = 'LIQ_CHASE'
WHERE `strategy_type` IN ('LIQ_CHASE', 'SENTINEL', 'SHORT_CONTINUATION');

INSERT INTO `audit_events` (
  `owner_email`,
  `account_id`,
  `action`,
  `resource_type`,
  `resource_id`,
  `detail_json`,
  `created_at`
)
SELECT
  `owner_email`,
  `account_id`,
  'MIGRATE_NEXUS_BRAIN_RUNTIME',
  'strategy',
  CAST(`id` AS TEXT),
  json_object(
    'brainKey', `brain_key`,
    'brainTemplate', `brain_template`,
    'configVersion', `config_version`,
    'oldPositionsKeepBoundVersion', json('true')
  ),
  unixepoch('now') * 1000
FROM `strategies`
WHERE `brain_template` = 'NEXUS_MARKET_BRAIN';
