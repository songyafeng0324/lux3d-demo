-- T20: why an administrator upload failed, in words people can act on ({reason, message, ...numbers}).
-- error_code stays the coarse category (MODEL_INVALID / VALIDATOR_ERROR); rows from before T20 keep NULL here.
ALTER TABLE asset_imports ADD COLUMN error_detail jsonb CHECK (error_detail IS NULL OR jsonb_typeof(error_detail) = 'object');
