-- 在庫調整（破損・紛失等）用: inbound_items.exit_type
ALTER TABLE inbound_items ADD COLUMN IF NOT EXISTS exit_type TEXT;
COMMENT ON COLUMN inbound_items.exit_type IS '在庫調整理由: damaged | lost | internal_use | entertainment';
