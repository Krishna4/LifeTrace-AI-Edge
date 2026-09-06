-- Cloudflare D1 Relational Schema for LifeTrace AI

-- 1. Documents Table
CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT NOT NULL,
    file_type TEXT NOT NULL,
    file_size_bytes INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'COMPLETED',
    username TEXT NOT NULL DEFAULT 'default_user',
    is_secure INTEGER NOT NULL DEFAULT 0,
    source_name TEXT,
    metadata_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 2. Personal Events & Daily Life Ledger Table
CREATE TABLE IF NOT EXISTS personal_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'DAILY_EVENT',
    event_date TEXT NOT NULL,
    location TEXT,
    entity_person TEXT,
    details TEXT,
    username TEXT NOT NULL DEFAULT 'default_user',
    is_secure INTEGER NOT NULL DEFAULT 0,
    source_document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 3. Financial Transactions Table
CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_person TEXT NOT NULL,
    amount REAL NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    transaction_date TEXT NOT NULL,
    notes TEXT,
    username TEXT NOT NULL DEFAULT 'default_user',
    is_secure INTEGER NOT NULL DEFAULT 0,
    source_document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 4. Conversation History (Multi-turn chat memory)
CREATE TABLE IF NOT EXISTS conversation_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    role TEXT NOT NULL, -- 'user' or 'assistant'
    content TEXT NOT NULL,
    username TEXT NOT NULL DEFAULT 'default_user',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Indices for fast edge querying
CREATE INDEX IF NOT EXISTS idx_personal_events_user ON personal_events(username);
CREATE INDEX IF NOT EXISTS idx_personal_events_date ON personal_events(event_date);
CREATE INDEX IF NOT EXISTS idx_personal_events_cat ON personal_events(category);
CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(username);
CREATE INDEX IF NOT EXISTS idx_transactions_entity ON transactions(entity_person);
CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(transaction_date);
CREATE INDEX IF NOT EXISTS idx_conv_chat ON conversation_history(chat_id, id DESC);

