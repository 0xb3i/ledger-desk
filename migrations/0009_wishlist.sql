CREATE TABLE wishlist_items (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 200),
  amount_cents INTEGER CHECK(amount_cents IS NULL OR (typeof(amount_cents)='integer' AND amount_cents BETWEEN 1 AND 999999999999)),
  url TEXT NOT NULL DEFAULT '' CHECK(length(url)<=2000),
  note TEXT NOT NULL DEFAULT '' CHECK(length(note)<=2000),
  status TEXT NOT NULL DEFAULT 'wanted' CHECK(status IN ('wanted','purchased')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  purchased_at TEXT,
  deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(version)='integer' AND version BETWEEN 1 AND 9007199254740991),
  create_payload_hash TEXT CHECK(create_payload_hash IS NULL OR length(create_payload_hash)=64),
  CHECK((status='wanted' AND purchased_at IS NULL) OR (status='purchased' AND purchased_at IS NOT NULL))
);
CREATE INDEX wishlist_items_status_created ON wishlist_items(status,created_at DESC,id DESC) WHERE deleted_at IS NULL;
CREATE INDEX wishlist_items_purchased ON wishlist_items(purchased_at DESC,id DESC) WHERE deleted_at IS NULL AND status='purchased';
CREATE INDEX wishlist_items_deleted ON wishlist_items(deleted_at DESC,id DESC) WHERE deleted_at IS NOT NULL;
