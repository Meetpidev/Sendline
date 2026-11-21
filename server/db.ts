import pg from 'pg';

const { Pool } = pg;

let pool: pg.Pool | null = null;
let databaseReady = false;
let databaseError: string | null = null;

function getConnectionString(): string {
  return (process.env.DATABASE_URL || process.env.DB_URL || '').trim();
}

export function isDatabaseConfigured(): boolean {
  return Boolean(getConnectionString());
}

export function getDatabaseStatus(): {
  configured: boolean;
  ready: boolean;
  error: string | null;
} {
  return {
    configured: isDatabaseConfigured(),
    ready: databaseReady,
    error: databaseError,
  };
}

export function getPool(): pg.Pool {
  const connectionString = getConnectionString();
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not configured. Add your Neon PostgreSQL connection string in Settings -> Secrets or .env.'
    );
  }
  if (!pool) {
    const isLocal =
      connectionString.includes('localhost') ||
      connectionString.includes('127.0.0.1');
    const hasExplicitSslMode = /sslmode=/i.test(connectionString);

    pool = new Pool({
      connectionString,
      max: 12,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
      ...(!isLocal && !hasExplicitSslMode
        ? { ssl: { rejectUnauthorized: false } }
        : {}),
    });

    pool.on('error', (err) => {
      console.error('Unexpected PostgreSQL pool error:', err.message);
    });
  }
  return pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params);
}

export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function initDatabase(): Promise<boolean> {
  if (!isDatabaseConfigured()) {
    databaseReady = false;
    databaseError = null;
    return false;
  }

  try {
    const p = getPool();

    await p.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await p.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await p.query(`
      CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    `);

    await p.query(`
      CREATE TABLE IF NOT EXISTS campaigns (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        message TEXT NOT NULL DEFAULT '',
        default_country_code TEXT NOT NULL DEFAULT '91',
        settings JSONB NOT NULL,
        poll JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await p.query(`
      CREATE INDEX IF NOT EXISTS idx_campaigns_user_updated
      ON campaigns(user_id, updated_at DESC);
    `);

    await p.query(`
      CREATE TABLE IF NOT EXISTS recipients (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL DEFAULT '',
        raw_phone TEXT NOT NULL DEFAULT '',
        phone TEXT NOT NULL,
        custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
        status TEXT NOT NULL DEFAULT 'queued',
        whatsapp_message_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        dispatched_at TIMESTAMPTZ,
        sent_at TIMESTAMPTZ,
        delivered_at TIMESTAMPTZ,
        read_at TIMESTAMPTZ,
        opened_at TIMESTAMPTZ,
        failed_reason TEXT,
        open_count INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        sort_order BIGSERIAL
      );
    `);
    await p.query(`
      CREATE INDEX IF NOT EXISTS idx_recipients_campaign_sort
      ON recipients(campaign_id, sort_order ASC);
    `);
    await p.query(`
      CREATE INDEX IF NOT EXISTS idx_recipients_user_id
      ON recipients(user_id);
    `);

    await p.query(`
      CREATE TABLE IF NOT EXISTS recipient_message_index (
        message_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        recipient_id TEXT NOT NULL REFERENCES recipients(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await p.query(`
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        original_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        file_data BYTEA NOT NULL,
        download_count INTEGER NOT NULL DEFAULT 0,
        uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await p.query(`
      CREATE INDEX IF NOT EXISTS idx_attachments_campaign
      ON attachments(campaign_id, uploaded_at ASC);
    `);

    await p.query(`
      CREATE TABLE IF NOT EXISTS poll_dispatches (
        poll_msg_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        recipient_id TEXT NOT NULL,
        secret_base64 TEXT NOT NULL,
        creator_jid TEXT NOT NULL,
        creator_lid TEXT,
        target_jid TEXT NOT NULL,
        options JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await p.query(`
      CREATE TABLE IF NOT EXISTS account_usage (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        account_key TEXT NOT NULL,
        period_type TEXT NOT NULL,
        period_key TEXT NOT NULL,
        sent_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, account_key, period_type, period_key)
      );
    `);

    await p.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_auth_state (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key_id TEXT NOT NULL,
        data_json TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, key_id)
      );
    `);

    // Purge expired sessions on startup
    await p.query(`DELETE FROM sessions WHERE expires_at < NOW()`);

    databaseReady = true;
    databaseError = null;
    console.log('PostgreSQL database connected and schema verified.');
    return true;
  } catch (err) {
    databaseReady = false;
    databaseError =
      err instanceof Error ? err.message : 'Failed to initialize database';
    console.error('PostgreSQL initialization error:', databaseError);
    return false;
  }
}
