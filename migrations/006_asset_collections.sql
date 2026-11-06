CREATE TABLE asset_collections (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    collector_id uuid NOT NULL REFERENCES users(id),
    asset_id uuid NOT NULL REFERENCES assets(id),
    first_room_version bigint NOT NULL CHECK (first_room_version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (collector_id, asset_id)
);

CREATE INDEX asset_collections_page_idx ON asset_collections(collector_id, created_at DESC, id DESC);
CREATE INDEX asset_collections_asset_idx ON asset_collections(asset_id);
