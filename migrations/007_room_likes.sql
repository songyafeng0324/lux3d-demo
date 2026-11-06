CREATE TABLE room_likes (
    room_id uuid NOT NULL REFERENCES rooms(id),
    voter_id uuid NOT NULL REFERENCES users(id),
    PRIMARY KEY (room_id, voter_id)
);
