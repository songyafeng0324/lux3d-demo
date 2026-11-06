-- Backfill the rooms that the original admin seed did not create.
WITH created AS (
    INSERT INTO rooms(owner_id, name, scene_version)
    SELECT u.id, '个人小屋', 'courtyard-v1'
    FROM users u
    WHERE u.role = 'admin'
      AND u.password_hash <> 'system:no-login'
      AND NOT EXISTS (SELECT 1 FROM rooms r WHERE r.owner_id = u.id)
    ON CONFLICT (owner_id) DO NOTHING
    RETURNING id, name, scene_version
)
INSERT INTO room_versions(room_id, version, name, scene_version, placements_json)
SELECT id, 0, name, scene_version, '[]' FROM created;
