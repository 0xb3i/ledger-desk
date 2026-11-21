-- Optional brand for wishlist items, shown as its own column in the queue.
ALTER TABLE wishlist_items ADD COLUMN brand TEXT NOT NULL DEFAULT '' CHECK(length(brand) <= 100);
