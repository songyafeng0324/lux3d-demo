-- Infrastructure seed only. Never overwrite an existing published gallery.
INSERT INTO gallery_versions (version, slots_json, details_json)
SELECT 0,
       jsonb_agg(jsonb_build_object('slotNo', n, 'candidateId', NULL) ORDER BY n),
       '{}'::jsonb
FROM generate_series(1, 30) AS n
ON CONFLICT (version) DO NOTHING;

INSERT INTO gallery (singleton_id, version) VALUES (1, 0)
ON CONFLICT (singleton_id) DO NOTHING;

INSERT INTO exhibit_slots (slot_no)
SELECT n FROM generate_series(1, 30) AS n
ON CONFLICT (slot_no) DO NOTHING;
