-- Up Migration
-- Encrypted columns (architecture Q5) hold an AES-256-GCM envelope as TEXT:
--   v1.<keyId>.<iv_b64url(12B)>.<ciphertext_b64url>.<tag_b64url(16B)>
-- The CHECKs reject a plaintext write even from raw SQL (23514). akahu_merchant_id and gst_number
-- stay plaintext; bank_account_last4 is the display projection written alongside the ciphertext.
CREATE TABLE teams (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 varchar(255) NOT NULL,
  description          text,
  visibility           team_visibility NOT NULL DEFAULT 'PUBLIC',
  invite_code          varchar(100) UNIQUE NOT NULL,
  created_by           uuid REFERENCES users (id),
  bank_account_name    text
    CONSTRAINT teams_bank_account_name_envelope
    CHECK (bank_account_name IS NULL
           OR bank_account_name ~ '^v1\.[a-z0-9-]{1,16}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{22}$'),
  bank_account_number  text
    CONSTRAINT teams_bank_account_number_envelope
    CHECK (bank_account_number IS NULL
           OR bank_account_number ~ '^v1\.[a-z0-9-]{1,16}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{22}$'),
  bank_account_last4   char(4)
    CONSTRAINT teams_bank_account_last4_digits CHECK (bank_account_last4 ~ '^[0-9]{4}$'),
  akahu_merchant_id    varchar(255),
  akahu_app_token      text
    CONSTRAINT teams_akahu_app_token_envelope
    CHECK (akahu_app_token IS NULL
           OR akahu_app_token ~ '^v1\.[a-z0-9-]{1,16}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{22}$'),
  is_payout_configured boolean NOT NULL DEFAULT false,
  gst_registered       boolean NOT NULL DEFAULT false,
  ird_number           text
    CONSTRAINT teams_ird_number_envelope
    CHECK (ird_number IS NULL
           OR ird_number ~ '^v1\.[a-z0-9-]{1,16}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{22}$'),
  gst_number           varchar(20),
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- Down Migration
DROP TABLE teams;
