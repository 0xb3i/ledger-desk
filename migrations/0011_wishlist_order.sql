-- Manual priority for the wishlist queue. Smaller position comes first. Existing items keep
-- their visible order (newest first); new items join the end of the queue.
ALTER TABLE wishlist_items ADD COLUMN position INTEGER CHECK(position IS NULL OR (typeof(position)='integer' AND position >= 1));
UPDATE wishlist_items SET position=(SELECT COUNT(*) FROM wishlist_items newer
  WHERE newer.created_at > wishlist_items.created_at OR (newer.created_at = wishlist_items.created_at AND newer.id >= wishlist_items.id));
