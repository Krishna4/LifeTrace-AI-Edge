import { Hono } from 'hono';
import { cors } from 'hono/cors';

export interface Env {
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  AI: any;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  TELEGRAM_SECRET_TOKEN?: string;
  API_KEY?: string;
  DEFAULT_USER?: string;
  USER_TIMEZONE?: string;
  ENVIRONMENT?: string;
}

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors());

// --- Auth Guard Middleware for API Endpoints ---
app.use('/api/v1/*', async (c, next) => {
  const configuredKey = c.env.API_KEY;
  if (!configuredKey) {
    // If API_KEY secret is not set, allow requests (open dev mode)
    return await next();
  }

  const authHeader = c.req.header('Authorization');
  const apiKeyHeader = c.req.header('X-API-Key');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : apiKeyHeader;

  if (!token || token !== configuredKey) {
    return c.json({ error: 'Unauthorized: Missing or invalid API key' }, 401);
  }

  await next();
});

// --- Helper Functions ---

function getTodayDateStr(timezone?: string): string {
  try {
    const tz = timezone || 'Asia/Kolkata';
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  } catch {
    return new Date().toISOString().split('T')[0];
  }
}

async function sendTelegramMessage(token: string, chatId: string, text: string, parseMode?: string) {
  const mode = parseMode === undefined ? 'Markdown' : parseMode;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        ...(mode ? { parse_mode: mode } : {}),
        disable_web_page_preview: true,
      }),
    });
    const data: any = await res.json();
    // Resilient fallback: If Telegram rejects Markdown entities (e.g. unclosed underscores), retry in plain text
    if (!data.ok && mode) {
      console.warn(`Telegram markdown parse error: ${data.description}. Retrying without formatting.`);
      const retryRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: text,
          disable_web_page_preview: true,
        }),
      });
      return await retryRes.json();
    }
    return data;
  } catch (err) {
    console.error('Telegram dispatch error:', err);
    return { ok: false, error: String(err) };
  }
}

function formatEventsForDigest(
  events: any[],
  targetDateStr: string,
  username: string,
  expenses: any[] = []
): string {
  const symbolMap: Record<string, string> = { USD: '$', INR: '₹', EUR: '€', GBP: '£' };
  const hasEvents = events && events.length > 0;
  const hasExpenses = expenses && expenses.length > 0;

  if (!hasEvents && !hasExpenses) {
    return (
      `🌱 *LifeTrace AI Daily Agenda*\n` +
      `📅 *${targetDateStr}* (User: \`${username}\`)\n\n` +
      `🎉 _No events, meetings, or expenses logged for today._\n\n` +
      `_Tip: Log events with \`/log <details>\` or expenses with \`/spend <amount> <item>\`._`
    );
  }

  const icons: Record<string, string> = {
    MEETING: '👥',
    TRAVEL: '✈️',
    HEALTH: '🏥',
    DINING: '🍽️',
    MILESTONE: '🏆',
    REMINDER: '⏰',
    DAILY_EVENT: '📌',
    WORK: '💼',
  };

  let output = `🌱 *LifeTrace AI Daily Agenda*\n📅 *${targetDateStr}* (User: \`${username}\`)\n\n`;

  if (hasEvents) {
    const blocks = events.map((ev, i) => {
      const icon = icons[ev.category?.toUpperCase()] || '📌';
      let line = `*${i + 1}.* (ID: \`#${ev.id}\`) ${icon} *[${ev.category}]* *${ev.title}*`;
      if (ev.location) line += `\n   📍 Location: ${ev.location}`;
      if (ev.entity_person) line += `\n   👤 Person: ${ev.entity_person}`;
      if (ev.details) line += `\n   📝 Details: _${ev.details}_`;
      return line;
    });
    output += `🔔 *${events.length} event(s) scheduled:*\n${blocks.join('\n\n')}\n\n`;
  }

  if (hasExpenses) {
    const expenseLines = expenses.map((tx) => {
      const sym = symbolMap[tx.currency] || `${tx.currency} `;
      return `• (ID: \`#${tx.id}\`) *${tx.entity_person}:* ${sym}${tx.amount} (${tx.currency})${tx.notes && tx.notes !== tx.entity_person ? ` — _${tx.notes}_` : ''}`;
    });
    output += `💰 *Today's Expenses (${expenses.length}):*\n${expenseLines.join('\n')}\n\n`;
  }

  output += `_Reply to ask questions, log new activities, or manage entries!_`;
  return output;
}


async function extractAndLogEvent(
  env: Env,
  rawText: string,
  username: string
): Promise<{ success: boolean; event: any }> {
  const todayStr = new Date().toISOString().split('T')[0];
  let parsed: any = null;

  try {
    const aiRes = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fp8', {
      messages: [
        {
          role: 'system',
          content: `You are an event extraction engine for a personal life ledger. Today's date is ${todayStr}.
Extract the event details into a single JSON object with this exact schema:
{
  "title": "Concise summary of event (e.g. Attended AI Workshop in Office)",
  "category": "WORK" | "MEETING" | "TRAVEL" | "HEALTH" | "DINING" | "MILESTONE" | "DAILY_EVENT",
  "event_date": "YYYY-MM-DD (resolve words like today, tomorrow, yesterday relative to ${todayStr})",
  "location": "location if mentioned or null",
  "entity_person": "people mentioned or null",
  "details": "extra details, commentary, or duration"
}
Return ONLY the raw JSON object. Do not add markdown code fences, backticks, or extra explanation.`,
        },
        { role: 'user', content: rawText },
      ],
      max_tokens: 300,
      temperature: 0.1,
    });

    let responseText = '';
    if (typeof aiRes === 'string') {
      responseText = aiRes;
    } else if (aiRes && typeof aiRes === 'object') {
      responseText = (aiRes as any).response || (aiRes as any).result?.response || JSON.stringify(aiRes);
    }

    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[0]);
    }
  } catch (err) {
    console.warn('AI event extraction warning:', err);
  }

  const title = parsed?.title || rawText.slice(0, 80);
  const category = (parsed?.category || 'DAILY_EVENT').toUpperCase();
  const eventDate = parsed?.event_date || todayStr;
  const location = parsed?.location || null;
  const entityPerson = parsed?.entity_person || null;
  const details = parsed?.details || rawText;

  const stmt = env.DB.prepare(`
    INSERT INTO personal_events (title, category, event_date, location, entity_person, details, username)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const res = await stmt.bind(title, category, eventDate, location, entityPerson, details, username).run();
  const eventId = res.meta.last_row_id;

  // Embed and index into Vectorize
  try {
    const textToEmbed = `Personal Event (${eventDate}) [${category}]: ${title}${location ? ` at ${location}` : ''}${entityPerson ? ` with ${entityPerson}` : ''}${details ? `. Details: ${details}` : ''}`;
    const embedRes = await env.AI.run('@cf/baai/bge-small-en-v1.5', { text: [textToEmbed] });
    const vector = embedRes.data[0];
    await env.VECTORIZE.upsert([
      {
        id: `event-${eventId}`,
        values: vector,
        metadata: {
          type: 'event',
          id: eventId,
          title,
          category,
          event_date: eventDate,
          username,
          text: textToEmbed,
        },
      },
    ]);
  } catch (err) {
    console.warn('Vectorize index warning on Telegram log:', err);
  }

  return {
    success: true,
    event: { id: eventId, title, category, event_date: eventDate, location, entity_person: entityPerson, details },
  };
}

async function extractAndLogExpense(
  env: Env,
  rawText: string,
  username: string
): Promise<{ success: boolean; tx: any }> {
  const todayStr = getTodayDateStr(env.USER_TIMEZONE);
  let parsed: any = null;

  // 1. Fast deterministic regex extraction
  let regexAmount: number | null = null;
  let regexCurrency = 'USD';
  let regexEntity = 'General Expense';
  let regexNotes = rawText.trim();

  // Check currency symbols / codes anywhere in text
  if (/₹|\bINR\b/i.test(rawText)) regexCurrency = 'INR';
  else if (/€|\bEUR\b/i.test(rawText)) regexCurrency = 'EUR';
  else if (/£|\bGBP\b/i.test(rawText)) regexCurrency = 'GBP';

  // Match amount anywhere in string: e.g. "50 groceries", "$50 dinner", "lunch 20.50", "petrol 500 INR"
  const numberMatch = rawText.match(/(?:([$₹€£])\s*)?(\d+(?:\.\d{1,2})?)(?:\s*([A-Za-z]{3}))?/);
  if (numberMatch && numberMatch[2]) {
    regexAmount = parseFloat(numberMatch[2]);
    if (numberMatch[1]) {
      if (numberMatch[1] === '₹') regexCurrency = 'INR';
      else if (numberMatch[1] === '€') regexCurrency = 'EUR';
      else if (numberMatch[1] === '£') regexCurrency = 'GBP';
    }
    if (numberMatch[3]) {
      const code = numberMatch[3].toUpperCase();
      if (['USD', 'INR', 'EUR', 'GBP', 'CAD', 'AUD', 'SGD'].includes(code)) {
        regexCurrency = code;
      }
    }

    // Derive entity by stripping the amount and common prepositions
    const stripped = rawText
      .replace(numberMatch[0], '')
      .replace(/[$₹€£]/g, '')
      .replace(/\b(for|on|at|to|spent|bought|paid|INR|USD|EUR|GBP)\b/gi, '')
      .trim();
    if (stripped) {
      regexEntity = stripped;
      regexNotes = stripped;
    }
  }

  // 2. AI Extraction for deeper context and classification
  try {
    const aiRes = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fp8', {
      messages: [
        {
          role: 'system',
          content: `You are a financial transaction extraction assistant. Today's date is ${todayStr}.
Extract the transaction into a single JSON object with this schema:
{
  "entity_person": "Vendor, item, or category (e.g. Starbucks, Groceries, Uber, Petrol)",
  "amount": number,
  "currency": "USD" | "INR" | "EUR" | "GBP",
  "transaction_date": "YYYY-MM-DD (resolve words like yesterday relative to ${todayStr})",
  "notes": "additional notes or description"
}
Return ONLY valid JSON without markdown code fences:`,
        },
        { role: 'user', content: rawText },
      ],
      max_tokens: 300,
      temperature: 0.1,
    });

    let responseText = '';
    if (typeof aiRes === 'string') {
      responseText = aiRes;
    } else if (aiRes && typeof aiRes === 'object') {
      responseText = (aiRes as any).response || (aiRes as any).result?.response || JSON.stringify(aiRes);
    }

    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[0]);
    }
  } catch (err) {
    console.warn('AI expense extraction warning:', err);
  }

  // Deterministic values always take precedence or fallback seamlessly
  const finalAmount = (regexAmount !== null && regexAmount > 0)
    ? regexAmount
    : (Number(parsed?.amount) || 0);

  const entity = (parsed?.entity_person && parsed.entity_person !== 'General Expense')
    ? parsed.entity_person
    : regexEntity;

  const currency = (parsed?.currency || regexCurrency || 'USD').toUpperCase();
  const txDate = parsed?.transaction_date || todayStr;
  const notes = parsed?.notes || regexNotes || rawText;

  const stmt = env.DB.prepare(`
    INSERT INTO transactions (entity_person, amount, currency, transaction_date, notes, username)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const res = await stmt.bind(entity, finalAmount, currency, txDate, notes, username).run();
  const txId = res.meta.last_row_id;

  try {
    const textToEmbed = `Financial Transaction: Paid/received ${currency} ${finalAmount} for ${entity} on ${txDate}.${notes ? ` Notes: ${notes}` : ''}`;
    const embedRes = await env.AI.run('@cf/baai/bge-small-en-v1.5', { text: [textToEmbed] });
    const vector = embedRes.data[0];
    await env.VECTORIZE.upsert([
      {
        id: `tx-${txId}`,
        values: vector,
        metadata: {
          type: 'transaction',
          id: txId,
          entity_person: entity,
          amount: finalAmount,
          currency,
          transaction_date: txDate,
          username,
          text: textToEmbed,
        },
      },
    ]);
  } catch (err) {
    console.warn('Vectorize transaction index warning on Telegram log:', err);
  }

  return {
    success: true,
    tx: { id: txId, entity_person: entity, amount: finalAmount, currency, transaction_date: txDate, notes },
  };
}

// --- API Routes ---

// Health & System Info
app.get('/', (c) => {
  return c.json({
    status: 'healthy',
    system: 'LifeTrace AI Serverless Edge',
    runtime: 'Cloudflare Workers (V8 Edge)',
    database: 'Cloudflare D1 (SQLite)',
    vector_store: 'Cloudflare Vectorize',
    ai_engine: 'Cloudflare Workers AI (Llama 3.3 70B & BGE-Small)',
    telegram_configured: Boolean(c.env.TELEGRAM_BOT_TOKEN && c.env.TELEGRAM_CHAT_ID),
  });
});

// 1. Events Endpoints
app.get('/api/v1/events', async (c) => {
  const username = c.req.query('username') || c.env.DEFAULT_USER || 'default_user';
  const category = c.req.query('category');
  const eventDate = c.req.query('event_date');
  const query = c.req.query('query');
  const limit = Number(c.req.query('limit')) || 50;

  let sql = 'SELECT * FROM personal_events WHERE username = ?';
  const params: any[] = [username];

  if (category && category !== 'ALL') {
    sql += ' AND category = ?';
    params.push(category.toUpperCase());
  }
  if (eventDate) {
    sql += ' AND event_date = ?';
    params.push(eventDate);
  }
  if (query && query.trim()) {
    const q = `%${query.trim().toLowerCase()}%`;
    sql += ' AND (LOWER(title) LIKE ? OR LOWER(details) LIKE ? OR LOWER(location) LIKE ? OR LOWER(entity_person) LIKE ?)';
    params.push(q, q, q, q);
  }

  sql += ' ORDER BY event_date DESC, id DESC LIMIT ?';
  params.push(limit);

  const { results } = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json(results);
});

app.post('/api/v1/events', async (c) => {
  const body = await c.req.json();
  const username = body.username || c.env.DEFAULT_USER || 'default_user';
  const title = body.title;
  const category = (body.category || 'DAILY_EVENT').toUpperCase();
  const eventDate = body.event_date || new Date().toISOString().split('T')[0];
  const location = body.location || null;
  const entityPerson = body.entity_person || null;
  const details = body.details || null;
  const isSecure = body.is_secure ? 1 : 0;

  if (!title) {
    return c.json({ error: 'Title is required' }, 400);
  }

  // 1. Insert into D1 SQLite
  const stmt = c.env.DB.prepare(`
    INSERT INTO personal_events (title, category, event_date, location, entity_person, details, username, is_secure)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const res = await stmt.bind(title, category, eventDate, location, entityPerson, details, username, isSecure).run();
  const eventId = res.meta.last_row_id;

  // 2. Generate Dense Embedding & Index into Cloudflare Vectorize
  try {
    const textToEmbed = `Personal Event (${eventDate}) [${category}]: ${title}${location ? ` at ${location}` : ''}${entityPerson ? ` with ${entityPerson}` : ''}${details ? `. Details: ${details}` : ''}`;
    const embeddingRes = await c.env.AI.run('@cf/baai/bge-small-en-v1.5', {
      text: [textToEmbed],
    });
    const vector = embeddingRes.data[0];

    await c.env.VECTORIZE.upsert([
      {
        id: `event-${eventId}`,
        values: vector,
        metadata: {
          type: 'event',
          id: eventId,
          title,
          category,
          event_date: eventDate,
          username,
          text: textToEmbed,
        },
      },
    ]);
  } catch (err) {
    console.warn('Vectorize embedding index warning:', err);
  }

  // 3. Optional Telegram Notification
  if (c.env.TELEGRAM_BOT_TOKEN && c.env.TELEGRAM_CHAT_ID) {
    const notifyText = `🌱 *New Event Logged:*\n*${title}* (${category})\n📅 Date: \`${eventDate}\``;
    c.executionCtx.waitUntil(
      sendTelegramMessage(c.env.TELEGRAM_BOT_TOKEN, c.env.TELEGRAM_CHAT_ID, notifyText)
    );
  }

  return c.json({ id: eventId, message: 'Event created and indexed at edge.' }, 201);
});

// 2. Transactions Endpoints
app.get('/api/v1/transactions', async (c) => {
  const username = c.req.query('username') || c.env.DEFAULT_USER || 'default_user';
  const entity = c.req.query('entity_person');
  const limit = Number(c.req.query('limit')) || 50;

  let sql = 'SELECT * FROM transactions WHERE username = ?';
  const params: any[] = [username];

  if (entity) {
    sql += ' AND LOWER(entity_person) LIKE ?';
    params.push(`%${entity.toLowerCase()}%`);
  }

  sql += ' ORDER BY transaction_date DESC, id DESC LIMIT ?';
  params.push(limit);

  const { results } = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json(results);
});

app.post('/api/v1/transactions', async (c) => {
  const body = await c.req.json();
  const username = body.username || c.env.DEFAULT_USER || 'default_user';
  const entity = body.entity_person;
  const amount = Number(body.amount);
  const currency = (body.currency || 'USD').toUpperCase();
  const txDate = body.transaction_date || new Date().toISOString().split('T')[0];
  const notes = body.notes || null;
  const isSecure = body.is_secure ? 1 : 0;

  if (!entity || isNaN(amount)) {
    return c.json({ error: 'entity_person and amount are required' }, 400);
  }

  const stmt = c.env.DB.prepare(`
    INSERT INTO transactions (entity_person, amount, currency, transaction_date, notes, username, is_secure)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const res = await stmt.bind(entity, amount, currency, txDate, notes, username, isSecure).run();
  const txId = res.meta.last_row_id;

  // Dense Embedding & Index into Vectorize
  try {
    const textToEmbed = `Financial Transaction: Paid/received $${amount} ${currency} with ${entity} on ${txDate}.${notes ? ` Notes: ${notes}` : ''}`;
    const embeddingRes = await c.env.AI.run('@cf/baai/bge-small-en-v1.5', { text: [textToEmbed] });
    const vector = embeddingRes.data[0];
    await c.env.VECTORIZE.upsert([
      {
        id: `tx-${txId}`,
        values: vector,
        metadata: {
          type: 'transaction',
          id: txId,
          entity_person: entity,
          amount,
          currency,
          transaction_date: txDate,
          username,
          text: textToEmbed,
        },
      },
    ]);
  } catch (err) {
    console.warn('Vectorize transaction index warning:', err);
  }

  return c.json({ id: txId, message: 'Transaction saved and indexed.' }, 201);
});

// 3. Document / Notes Ingestion Endpoint
app.post('/api/v1/documents', async (c) => {
  const body = await c.req.json();
  const username = body.username || c.env.DEFAULT_USER || 'default_user';
  const title = body.title || 'Untitled Note';
  const content = body.content;
  if (!content) {
    return c.json({ error: 'content is required' }, 400);
  }

  const stmt = c.env.DB.prepare(`
    INSERT INTO documents (file_path, file_type, file_size_bytes, username, source_name)
    VALUES (?, ?, ?, ?, ?)
  `);
  const res = await stmt.bind(`notes/${title}`, 'text/plain', content.length, username, title).run();
  const docId = res.meta.last_row_id;

  // Embed and index document into Vectorize
  try {
    const embeddingRes = await c.env.AI.run('@cf/baai/bge-small-en-v1.5', { text: [content] });
    const vector = embeddingRes.data[0];
    await c.env.VECTORIZE.upsert([
      {
        id: `doc-${docId}`,
        values: vector,
        metadata: {
          type: 'document',
          id: docId,
          title,
          username,
          text: content.slice(0, 1000),
        },
      },
    ]);
  } catch (err) {
    console.warn('Vectorize document index warning:', err);
  }

  return c.json({ id: docId, message: 'Document saved and indexed.' }, 201);
});

// 4. Multimodal RAG Query Engine Helper (with Conversation Memory)
async function executeRagQuery(
  env: Env,
  query: string,
  username: string,
  chatId?: string
): Promise<{ query: string; answer: string; events: any[]; transactions: any[]; vector_matches: number }> {
  // A. Semantic Search in Vectorize (Dense Vector Similarity)
  let vectorHits: any[] = [];
  try {
    const embedRes = await env.AI.run('@cf/baai/bge-small-en-v1.5', { text: [query] });
    const queryVector = embedRes.data[0];
    const vecResults = await env.VECTORIZE.query(queryVector, { topK: 5, returnMetadata: 'all' });
    vectorHits = vecResults.matches || [];
  } catch (err) {
    console.warn('Vector search warning:', err);
  }

  // B. Relational Matching in D1
  const todayStr = getTodayDateStr(env.USER_TIMEZONE);
  const qLower = query.toLowerCase();

  // Date check
  let targetDate = '';
  if (qLower.includes('today')) {
    targetDate = todayStr;
  } else {
    const dateMatch = query.match(/\b\d{4}-\d{2}-\d{2}\b/);
    if (dateMatch) {
      targetDate = dateMatch[0];
    }
  }

  // Search personal events via keyword / date
  let matchingEvents: any[] = [];
  try {
    let eventSql = 'SELECT * FROM personal_events WHERE username = ?';
    const eventParams: any[] = [username];

    if (targetDate) {
      eventSql += ' AND event_date = ?';
      eventParams.push(targetDate);
    } else {
      eventSql += ' AND (LOWER(title) LIKE ? OR LOWER(details) LIKE ? OR LOWER(entity_person) LIKE ? OR LOWER(location) LIKE ?)';
      const term = `%${qLower}%`;
      eventParams.push(term, term, term, term);
    }
    eventSql += ' ORDER BY event_date DESC LIMIT 5';
    const { results } = await env.DB.prepare(eventSql).bind(...eventParams).all();
    matchingEvents = results || [];
  } catch (e) {
    console.warn('D1 events query error:', e);
  }

  // Search transactions via entity or general money query
  let matchingTx: any[] = [];
  const isFinancial = qLower.includes('pay') || qLower.includes('spent') || qLower.includes('cost') || qLower.includes('$') || qLower.includes('money') || qLower.includes('transaction');
  try {
    if (isFinancial) {
      const { results } = await env.DB.prepare(
        'SELECT * FROM transactions WHERE username = ? ORDER BY transaction_date DESC LIMIT 5'
      ).bind(username).all();
      matchingTx = results || [];
    } else {
      const { results } = await env.DB.prepare(
        'SELECT * FROM transactions WHERE username = ? AND (LOWER(entity_person) LIKE ? OR LOWER(notes) LIKE ?) ORDER BY transaction_date DESC LIMIT 5'
      ).bind(username, `%${qLower}%`, `%${qLower}%`).all();
      matchingTx = results || [];
    }
  } catch (e) {
    console.warn('D1 transactions query error:', e);
  }

  // C. Assemble Grounded Context for LLM Synthesis
  const contextParts: string[] = [];

  // 1. Vector Semantic Snippets
  if (vectorHits.length > 0) {
    const vectorTexts = vectorHits
      .filter((hit: any) => hit.metadata?.text)
      .map((hit: any) => `- [Score ${(hit.score || 0).toFixed(2)}] ${hit.metadata.text}`);
    if (vectorTexts.length > 0) {
      contextParts.push(`Relevant Semantic Records:\n${vectorTexts.join('\n')}`);
    }
  }

  // 2. Structured D1 Events
  if (matchingEvents.length > 0) {
    contextParts.push(`Events in Ledger:\n${matchingEvents.map(e => `- [${e.category}] ${e.title} on ${e.event_date} at ${e.location || 'N/A'} with ${e.entity_person || 'N/A'}${e.details ? `. Note: ${e.details}` : ''}`).join('\n')}`);
  }

  // 3. Structured D1 Transactions
  if (matchingTx.length > 0) {
    contextParts.push(`Financial Records:\n${matchingTx.map(t => `- Paid/received $${t.amount} ${t.currency} with ${t.entity_person} on ${t.transaction_date}${t.notes ? ` (${t.notes})` : ''}`).join('\n')}`);
  }

  // 4. Conversation History (Multi-turn chat memory)
  const recentHistory: { role: string; content: string }[] = [];
  if (chatId) {
    try {
      const { results } = await env.DB.prepare(
        'SELECT role, content FROM conversation_history WHERE chat_id = ? ORDER BY id DESC LIMIT 6'
      ).bind(chatId).all();
      if (results && results.length > 0) {
        for (let i = results.length - 1; i >= 0; i--) {
          const row: any = results[i];
          recentHistory.push({
            role: row.role === 'assistant' ? 'assistant' : 'user',
            content: row.content,
          });
        }
      }
    } catch (err) {
      console.warn('Failed to load conversation history:', err);
    }
  }

  let finalAnswer = '';
  if (contextParts.length > 0 || recentHistory.length > 0) {
    const systemPrompt = `You are an accurate, grounded personal assistant. Answer questions concisely using the provided context and conversation history. If the answer is found in the context or past messages, be clear and direct. Do NOT hallucinate.\n\nContext:\n${contextParts.join('\n\n')}`;
    const messages = [
      { role: 'system', content: systemPrompt },
      ...recentHistory,
      { role: 'user', content: query },
    ];

    try {
      const aiRes = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
        messages,
        max_tokens: 500,
        temperature: 0.1,
      });
      finalAnswer = (aiRes as any)?.response || '';
    } catch (err) {
      console.warn('Llama 3.3 failed, falling back to Llama 3.1:', err);
      try {
        const fallbackRes = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fp8', {
          messages,
          max_tokens: 500,
        });
        finalAnswer = (fallbackRes as any)?.response || '';
      } catch (e) {
        console.warn('Workers AI answer generation warning:', e);
      }
    }
  }

  // Fallback if LLM gives empty output or is offline
  if (!finalAnswer && (matchingEvents.length > 0 || vectorHits.length > 0 || matchingTx.length > 0)) {
    const fallbackLines: string[] = [];
    if (matchingEvents.length > 0) {
      fallbackLines.push(`📅 **Events:**\n` + matchingEvents.map(e => `- **[${e.category}] ${e.title}** on ${e.event_date}${e.location ? ` at ${e.location}` : ''}`).join('\n'));
    }
    if (matchingTx.length > 0) {
      fallbackLines.push(`💰 **Transactions:**\n` + matchingTx.map(t => `- **${t.entity_person}:** $${t.amount} ${t.currency} on ${t.transaction_date}`).join('\n'));
    }
    if (fallbackLines.length === 0 && vectorHits.length > 0) {
      const validSnippets = vectorHits.filter((h: any) => h.metadata?.text).map((h: any) => `• ${h.metadata.text}`);
      if (validSnippets.length > 0) fallbackLines.push(`🔍 **Relevant Notes:**\n` + validSnippets.join('\n'));
    }
    finalAnswer = fallbackLines.join('\n\n');
  } else if (!finalAnswer) {
    finalAnswer = `No records found matching '${query}' in your ledger or notes.`;
  }

  // Persist conversation history turn into D1
  if (chatId && finalAnswer) {
    try {
      await env.DB.prepare(
        'INSERT INTO conversation_history (chat_id, role, content, username) VALUES (?, ?, ?, ?)'
      ).bind(chatId, 'user', query, username).run();

      await env.DB.prepare(
        'INSERT INTO conversation_history (chat_id, role, content, username) VALUES (?, ?, ?, ?)'
      ).bind(chatId, 'assistant', finalAnswer, username).run();

      // Prune history to last 20 messages per chat
      await env.DB.prepare(`
        DELETE FROM conversation_history 
        WHERE chat_id = ? AND id NOT IN (
          SELECT id FROM conversation_history WHERE chat_id = ? ORDER BY id DESC LIMIT 20
        )
      `).bind(chatId, chatId).run();
    } catch (err) {
      console.warn('Failed to save conversation history:', err);
    }
  }

  return {
    query,
    answer: finalAnswer,
    events: matchingEvents,
    transactions: matchingTx,
    vector_matches: vectorHits.length,
  };
}

app.post('/api/v1/query', async (c) => {
  const body = await c.req.json();
  const query = body.query;
  const username = body.username || c.env.DEFAULT_USER || 'default_user';

  if (!query) {
    return c.json({ error: 'Query is required' }, 400);
  }

  const result = await executeRagQuery(c.env, query, username);
  return c.json(result);
});

// 5. Telegram Webhook Receiver (Listens to DM & Channel Posts)
app.post('/telegram/webhook', async (c) => {
  const update = await c.req.json();
  const token = c.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return c.json({ ok: false, error: 'TELEGRAM_BOT_TOKEN not configured in Worker' });
  }

  const message = update.message || update.edited_message || update.channel_post || update.edited_channel_post;
  if (!message || !message.text) {
    return c.json({ ok: true, note: 'No text message' });
  }

  // 1. Optional Secret Token check from Telegram
  if (c.env.TELEGRAM_SECRET_TOKEN) {
    const incomingSecret = c.req.header('X-Telegram-Bot-Api-Secret-Token');
    if (incomingSecret !== c.env.TELEGRAM_SECRET_TOKEN) {
      return c.json({ ok: false, error: 'Unauthorized webhook source' }, 401);
    }
  }

  const chatId = String(message.chat.id);
  const text = message.text.trim();
  const username = c.env.DEFAULT_USER || message.from?.username || message.from?.first_name || 'default_user';

  // 2. Chat ID Guard: Only permit interaction from the configured owner chat or channel
  const authorizedChatId = c.env.TELEGRAM_CHAT_ID;
  if (authorizedChatId && chatId !== authorizedChatId) {
    console.warn(`Blocked unauthorized access attempt from Telegram Chat ID: ${chatId}`);
    await sendTelegramMessage(token, chatId, '⛔ *Access Denied:* You are not authorized to interact with this Personal RAG.');
    return c.json({ ok: false, error: 'Unauthorized chat ID' }, 403);
  }

  // 1. Normalize and parse Telegram command
  const normalizedText = text.replace(/^\/([a-zA-Z0-9_]+)@[a-zA-Z0-9_]+/i, '/$1').trim();
  const parts = normalizedText.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = normalizedText.slice(parts[0].length).trim();

  // /start or /help: Display clean command guide
  if (cmd === '/start' || cmd === '/help') {
    const helpMsg = 
      `🌱 *LifeTrace AI — Command Directory*\n\n` +
      `📅 *View Your Agenda & History:*\n` +
      `• \`/today\` or \`/digest\` — View today's agenda & expenses\n` +
      `• \`/today YYYY-MM-DD\` — View agenda for a specific date\n` +
      `• \`/events\` — List recent life events\n` +
      `• \`/expenses\` — List recent financial transactions\n\n` +
      `✍️ *Log Events & Transactions:*\n` +
      `• \`/log <details>\` — Log an event (e.g. \`/log AI workshop at office 10am\`)\n` +
      `• \`/spend <amount> <description>\` — Log an expense (e.g. \`/spend 50 groceries\`, \`/spend $20 lunch\`, \`/spend 500 INR petrol\`)\n\n` +
      `🗑️ *Manage Entries:*\n` +
      `• \`/delete <id>\` — Delete an event by ID (e.g. \`/delete 5\`)\n` +
      `• \`/delete_expense <id>\` — Delete a transaction by ID (e.g. \`/delete_expense 2\`)\n` +
      `• \`/clear\` or \`/reset\` — Clear conversational memory\n\n` +
      `💬 *Or talk naturally!* Ask questions like _"What did I do yesterday?"_ or _"How much did I spend on groceries?"_ with multi-turn memory.`;
    await sendTelegramMessage(token, chatId, helpMsg);
    return c.json({ ok: true });
  }

  // 1. Pure View Commands: strictly /today or /digest
  if (cmd === '/today' || cmd === '/digest') {
    const isExplicitDate = args && /^\d{4}-\d{2}-\d{2}$/.test(args);
    const targetDate = isExplicitDate ? args : getTodayDateStr(c.env.USER_TIMEZONE);

    const [{ results: eventResults }, { results: txResults }] = await Promise.all([
      c.env.DB.prepare(
        'SELECT * FROM personal_events WHERE username = ? AND event_date = ? ORDER BY id DESC'
      ).bind(username, targetDate).all(),
      c.env.DB.prepare(
        'SELECT * FROM transactions WHERE username = ? AND transaction_date = ? ORDER BY id DESC'
      ).bind(username, targetDate).all(),
    ]);

    let digestText = formatEventsForDigest(eventResults || [], targetDate, username, txResults || []);

    if (args && !isExplicitDate) {
      digestText += `\n\n💡 *Tip:* \`/digest\` displays your agenda. If you meant to log an event, use:\n\`/log ${args}\``;
    }

    await sendTelegramMessage(token, chatId, digestText);
    return c.json({ ok: true });
  }

  // /clear or /reset: Wipe conversational memory
  if (cmd === '/clear' || cmd === '/reset') {
    await c.env.DB.prepare('DELETE FROM conversation_history WHERE chat_id = ?').bind(chatId).run();
    await sendTelegramMessage(token, chatId, '🧹 *Conversation memory cleared!* We can start a fresh topic.');
    return c.json({ ok: true });
  }

  // /events: View recent events
  if (cmd === '/events') {
    const { results } = await c.env.DB.prepare(
      'SELECT * FROM personal_events WHERE username = ? ORDER BY event_date DESC LIMIT 5'
    ).bind(username).all();
    const lines = (results || []).map((e: any) => `• (ID: \`#${e.id}\`) *[${e.category}]* ${e.title} (${e.event_date})`);
    const reply = lines.length ? `📅 *Recent Events:*\n${lines.join('\n')}\n\n_Tip: Type /delete <id> to remove an entry._` : 'No events found.';
    await sendTelegramMessage(token, chatId, reply);
    return c.json({ ok: true });
  }

  // /expenses: View recent expenses
  if (cmd === '/expenses') {
    const { results } = await c.env.DB.prepare(
      'SELECT * FROM transactions WHERE username = ? ORDER BY transaction_date DESC, id DESC LIMIT 5'
    ).bind(username).all();
    const symbolMap: Record<string, string> = { USD: '$', INR: '₹', EUR: '€', GBP: '£' };
    const lines = (results || []).map((t: any) => {
      const sym = symbolMap[t.currency] || `${t.currency} `;
      return `• (ID: \`#${t.id}\`) *${t.entity_person}:* ${sym}${t.amount} (${t.currency}) on \`${t.transaction_date}\``;
    });
    const reply = lines.length ? `💰 *Recent Transactions:*\n${lines.join('\n')}\n\n_Tip: Type /delete_expense <id> to remove an entry._` : 'No transactions found.';
    await sendTelegramMessage(token, chatId, reply);
    return c.json({ ok: true });
  }

  // /delete: Delete event
  if (cmd === '/delete' || cmd === '/delete_event') {
    const eventId = Number(args);
    if (!eventId || isNaN(eventId)) {
      await sendTelegramMessage(token, chatId, '⚠️ Please provide a valid event ID. Example: `/delete 5`');
      return c.json({ ok: true });
    }
    await c.env.DB.prepare('DELETE FROM personal_events WHERE id = ? AND username = ?').bind(eventId, username).run();
    try {
      await c.env.VECTORIZE.deleteByIds([`event-${eventId}`]);
    } catch {}
    await sendTelegramMessage(token, chatId, `🗑️ Event #${eventId} deleted from your ledger.`);
    return c.json({ ok: true });
  }

  // /delete_expense: Delete expense
  if (cmd === '/delete_expense') {
    const txId = Number(args);
    if (!txId || isNaN(txId)) {
      await sendTelegramMessage(token, chatId, '⚠️ Please provide a valid transaction ID. Example: `/delete_expense 2`');
      return c.json({ ok: true });
    }
    await c.env.DB.prepare('DELETE FROM transactions WHERE id = ? AND username = ?').bind(txId, username).run();
    try {
      await c.env.VECTORIZE.deleteByIds([`tx-${txId}`]);
    } catch {}
    await sendTelegramMessage(token, chatId, `🗑️ Transaction #${txId} deleted from your ledger.`);
    return c.json({ ok: true });
  }

  // /spend or /expense: Log financial transaction
  if (cmd === '/spend' || cmd === '/expense') {
    if (!args) {
      await sendTelegramMessage(
        token,
        chatId,
        '⚠️ *Please specify the amount and item.*\n\nExamples:\n• `/spend 50 groceries`\n• `/spend $20 lunch with Sarah`\n• `/spend 500 INR petrol`\n• `/spend coffee 4.50`'
      );
      return c.json({ ok: true });
    }
    const { tx } = await extractAndLogExpense(c.env, args, username);
    const symbolMap: Record<string, string> = { USD: '$', INR: '₹', EUR: '€', GBP: '£' };
    const sym = symbolMap[tx.currency] || `${tx.currency} `;
    const reply = 
      `💰 *Expense Logged:*\n` +
      `• *Item / Vendor:* ${tx.entity_person} (ID: \`#${tx.id}\`)\n` +
      `• *Amount:* ${sym}${tx.amount} (${tx.currency})\n` +
      `• *Date:* \`${tx.transaction_date}\`\n` +
      (tx.notes && tx.notes !== tx.entity_person ? `• *Notes:* _${tx.notes}_\n` : '') +
      `\n_Tip: Type /expenses to view recent transactions or /today for agenda._`;
    await sendTelegramMessage(token, chatId, reply);
    return c.json({ ok: true });
  }

  // /log or /event or /add: Explicit event logging
  if (cmd === '/log' || cmd === '/event' || cmd === '/add') {
    if (!args) {
      await sendTelegramMessage(token, chatId, '⚠️ Please specify the event details.\nExample: `/log attended AI workshop in office today`');
      return c.json({ ok: true });
    }
    const { event } = await extractAndLogEvent(c.env, args, username);
    const reply = 
      `✅ *Event Logged:*\n` +
      `📌 *${event.title}* (ID: \`#${event.id}\`)\n` +
      `🏷️ *Category:* \`${event.category}\`\n` +
      `📅 *Date:* \`${event.event_date}\`\n` +
      (event.location ? `📍 *Location:* ${event.location}\n` : '') +
      (event.entity_person ? `👤 *With:* ${event.entity_person}\n` : '') +
      (event.details ? `📝 *Notes:* _${event.details}_\n` : '') +
      `\n_Type /today to view your updated agenda!_`;
    await sendTelegramMessage(token, chatId, reply);
    return c.json({ ok: true });
  }

  // Heuristic for natural language event logging (only if clearly expressing an action or diary entry)
  const isQuestion = text.endsWith('?') || /^(what|who|when|where|why|how|is|are|did|can|could|do|show|list)\b/i.test(text);
  const isEventStatement = !isQuestion && (
    /^(i attended|attended|went to|visited|had lunch with|had dinner with|had a meeting with|met with|flying to|flight to|booked|participated in)/i.test(text) ||
    /^(today|yesterday|tomorrow)\s+(i|we|there is|there was|i'm|i am)\b/i.test(text)
  );

  if (isEventStatement) {
    const { event } = await extractAndLogEvent(c.env, text, username);
    const reply = 
      `✅ *Event Logged:*\n` +
      `📌 *${event.title}* (ID: \`#${event.id}\`)\n` +
      `🏷️ *Category:* \`${event.category}\`\n` +
      `📅 *Date:* \`${event.event_date}\`\n` +
      (event.location ? `📍 *Location:* ${event.location}\n` : '') +
      (event.entity_person ? `👤 *With:* ${event.entity_person}\n` : '') +
      (event.details ? `📝 *Notes:* _${event.details}_\n` : '') +
      `\n_Type /today to view your agenda, or ask any question!_`;
    await sendTelegramMessage(token, chatId, reply);
    return c.json({ ok: true });
  }

  // Natural Language Question via Edge RAG with conversational multi-turn memory
  try {
    const result = await executeRagQuery(c.env, text, username, chatId);
    await sendTelegramMessage(token, chatId, `🌱 *LifeTrace AI:*\n\n${result.answer}`);
  } catch (err) {
    await sendTelegramMessage(token, chatId, `⚠️ Error processing request: ${err}`);
  }

  return c.json({ ok: true });
});

// Manual Telegram Digest Trigger
app.post('/api/v1/telegram/publish-digest', async (c) => {
  const token = c.env.TELEGRAM_BOT_TOKEN;
  const chatId = c.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    return c.json({ error: 'TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be configured' }, 400);
  }

  const username = c.req.query('username') || c.env.DEFAULT_USER || 'default_user';
  const todayStr = getTodayDateStr(c.env.USER_TIMEZONE);

  const { results } = await c.env.DB.prepare(
    'SELECT * FROM personal_events WHERE username = ? AND event_date = ? ORDER BY id DESC'
  ).bind(username, todayStr).all();

  const msg = formatEventsForDigest(results || [], todayStr, username);
  const delivery = await sendTelegramMessage(token, chatId, msg);

  return c.json({
    events_count: results?.length || 0,
    delivery,
  });
});

// --- Scheduled Cron Handler (Automated Daily Morning Telegram Briefing) ---
export default {
  fetch: app.fetch,

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    console.log('⏰ Cloudflare Scheduled Cron triggered at:', new Date().toISOString());
    const token = env.TELEGRAM_BOT_TOKEN;
    const chatId = env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
      console.warn('Skipping scheduled briefing: Telegram credentials not bound.');
      return;
    }

    const username = env.DEFAULT_USER || 'default_user';
    const todayStr = getTodayDateStr(env.USER_TIMEZONE);

    const { results } = await env.DB.prepare(
      'SELECT * FROM personal_events WHERE username = ? AND event_date = ? ORDER BY id DESC'
    ).bind(username, todayStr).all();

    const msg = formatEventsForDigest(results || [], todayStr, username);
    ctx.waitUntil(sendTelegramMessage(token, chatId, msg));
  },
};
