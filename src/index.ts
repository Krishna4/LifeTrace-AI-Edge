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

interface DailyDigestData {
  todayEvents: any[];
  reminders: any[];
  upcomingEvents: any[];
  todayExpenses: any[];
}

async function getDailyDigestData(
  env: Env,
  username: string,
  targetDate: string
): Promise<DailyDigestData> {
  const [
    { results: todayEvents },
    { results: reminders },
    { results: upcomingEvents },
    { results: todayExpenses },
  ] = await Promise.all([
    // 1. Events on target date
    env.DB.prepare(
      'SELECT * FROM personal_events WHERE username = ? AND event_date = ? ORDER BY id ASC'
    ).bind(username, targetDate).all(),

    // 2. Active reminders (daily habits / persistent reminders)
    env.DB.prepare(
      `SELECT * FROM personal_events 
       WHERE username = ? 
         AND (
           category = 'REMINDER' 
           OR LOWER(title) LIKE '%remind%' 
           OR LOWER(title) LIKE '%daily%' 
           OR LOWER(title) LIKE '%everyday%' 
           OR LOWER(title) LIKE '%every day%'
           OR LOWER(details) LIKE '%remind%' 
           OR LOWER(details) LIKE '%daily%' 
           OR LOWER(details) LIKE '%everyday%' 
           OR LOWER(details) LIKE '%every day%'
           OR LOWER(details) LIKE '%recurring%'
           OR LOWER(details) LIKE '%repeat%'
         )
         AND event_date <= ?
       ORDER BY id DESC LIMIT 10`
    ).bind(username, targetDate).all(),

    // 3. Upcoming events in next 3 days
    env.DB.prepare(
      `SELECT * FROM personal_events 
       WHERE username = ? 
         AND event_date > ? 
         AND event_date <= date(?, '+3 days') 
       ORDER BY event_date ASC, id ASC LIMIT 5`
    ).bind(username, targetDate, targetDate).all(),

    // 4. Transactions for target date
    env.DB.prepare(
      'SELECT * FROM transactions WHERE username = ? AND transaction_date = ? ORDER BY id ASC'
    ).bind(username, targetDate).all(),
  ]);

  // Deduplicate: Don't repeat today's events in active reminders
  const todayIds = new Set((todayEvents || []).map((e: any) => e.id));
  const filteredReminders = (reminders || []).filter((r: any) => !todayIds.has(r.id));

  return {
    todayEvents: todayEvents || [],
    reminders: filteredReminders,
    upcomingEvents: upcomingEvents || [],
    todayExpenses: todayExpenses || [],
  };
}

function formatEventsForDigest(
  targetDateStr: string,
  username: string,
  data: DailyDigestData
): string {
  const symbolMap: Record<string, string> = { USD: '$', INR: '₹', EUR: '€', GBP: '£' };
  const { todayEvents, reminders, upcomingEvents, todayExpenses } = data;

  const totalItems = todayEvents.length + reminders.length + upcomingEvents.length + todayExpenses.length;

  if (totalItems === 0) {
    return (
      `🌱 *LifeTrace AI Daily Agenda*\n` +
      `📅 *${targetDateStr}* (User: \`${username}\`)\n\n` +
      `🎉 _No events, reminders, or expenses scheduled for today._\n\n` +
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

  let output = `🌱 *LifeTrace AI Daily Briefing*\n📅 *${targetDateStr}* (User: \`${username}\`)\n\n`;

  // 1. Today's Events
  if (todayEvents.length > 0) {
    const blocks = todayEvents.map((ev, i) => {
      const icon = icons[ev.category?.toUpperCase()] || '📌';
      let line = `*${i + 1}.* (ID: \`#${ev.id}\`) ${icon} *[${ev.category}]* *${ev.title}*`;
      if (ev.location) line += `\n   📍 Location: ${ev.location}`;
      if (ev.entity_person) line += `\n   👤 Person: ${ev.entity_person}`;
      const cleanDetails = ev.details?.trim();
      if (cleanDetails) {
        const titleNorm = ev.title.toLowerCase().replace(/[^a-z0-9]/g, '');
        const detailsNorm = cleanDetails.toLowerCase().replace(/\b(due\s+tomorrow|due\s+today|due|tomorrow|today|yesterday)\b/g, '').replace(/[^a-z0-9]/g, '');
        const isRedundant = !detailsNorm || detailsNorm === titleNorm || cleanDetails.toLowerCase() === ev.title.toLowerCase();
        if (!isRedundant) {
          const sanitizedDetails = cleanDetails.replace(/\bdue\s+tomorrow\b/gi, 'due today');
          line += `\n   📝 Details: _${sanitizedDetails}_`;
        }
      }
      return line;
    });
    output += `🔔 *Today's Schedule (${todayEvents.length}):*\n${blocks.join('\n\n')}\n\n`;
  }

  // 2. Active Reminders & Daily Habits
  if (reminders.length > 0) {
    const remBlocks = reminders.map((r) => {
      let line = `• (ID: \`#${r.id}\`) ⏰ *${r.title}*`;
      if (r.details && r.details !== r.title) line += ` — _${r.details}_`;
      return line;
    });
    output += `⏰ *Active Reminders & Daily Habits (${reminders.length}):*\n${remBlocks.join('\n')}\n\n`;
  }

  // 3. Upcoming in Next 3 Days
  if (upcomingEvents.length > 0) {
    const upBlocks = upcomingEvents.map((up) => {
      const icon = icons[up.category?.toUpperCase()] || '🗓️';
      return `• \`${up.event_date}\`: ${icon} *${up.title}*${up.location ? ` (${up.location})` : ''}`;
    });
    output += `🗓️ *Upcoming in Next 3 Days:*\n${upBlocks.join('\n')}\n\n`;
  }

  // 4. Today's Expenses
  if (todayExpenses.length > 0) {
    const expenseLines = todayExpenses.map((tx) => {
      const sym = symbolMap[tx.currency] || `${tx.currency} `;
      return `• (ID: \`#${tx.id}\`) *${tx.entity_person}:* ${sym}${tx.amount} (${tx.currency})${tx.notes && tx.notes !== tx.entity_person ? ` — _${tx.notes}_` : ''}`;
    });
    output += `💰 *Today's Expenses (${todayExpenses.length}):*\n${expenseLines.join('\n')}\n\n`;
  }

  output += `_Reply to ask questions, log new activities, or manage entries!_`;
  return output;
}

async function extractAndLogEvent(
  env: Env,
  rawText: string,
  username: string
): Promise<{ success: boolean; events: any[]; event: any }> {
  const todayStr = getTodayDateStr(env.USER_TIMEZONE);
  let parsed: any = null;

  try {
    const aiRes = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fp8', {
      messages: [
        {
          role: 'system',
          content: `You are an event extraction engine for a personal life ledger. Today's date is ${todayStr}.
Analyze the user's message. If it contains ONE OR MORE events, reminders, or tasks, extract ALL of them into a JSON object with this exact schema:
{
  "events": [
    {
      "title": "Concise summary of event (e.g. Attended AI Workshop in Office)",
      "category": "WORK" | "MEETING" | "TRAVEL" | "HEALTH" | "DINING" | "MILESTONE" | "REMINDER" | "DAILY_EVENT",
      "event_date": "YYYY-MM-DD (resolve words like today, tomorrow, yesterday relative to ${todayStr})",
      "location": "location if mentioned or null",
      "entity_person": "people mentioned or null",
      "details": "extra details, commentary, or duration"
    }
  ]
}
Rules:
1. If the message contains multiple activities, distinct items, or a numbered/bulleted list, extract EACH item as a separate object in the "events" array.
2. If an item is a daily reminder or recurring task (e.g., "daily reminder", "remember every day", "daily habit"), set category to "REMINDER".
3. In "details", include extra context, commentary, notes, or agenda if provided. DO NOT repeat the title, and DO NOT leave relative temporal phrases like "due tomorrow", "tomorrow", or "yesterday" in details because the exact date is already captured in "event_date". If there are no extra details beyond the title, set "details": null.
4. Return ONLY the raw JSON object. Do not add markdown code fences, backticks, or extra explanation.`,
        },
        { role: 'user', content: rawText },
      ],
      max_tokens: 600,
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

  // Normalize parsed output into an array of events
  let rawList: any[] = [];
  if (Array.isArray(parsed?.events) && parsed.events.length > 0) {
    rawList = parsed.events;
  } else if (parsed?.title) {
    rawList = [parsed];
  } else {
    // Fallback: split on newlines if multiple lines, else single event
    const lines = rawText.split('\n').map(l => l.trim().replace(/^[-*•\d.]+\s*/, '')).filter(l => l.length > 0);
    if (lines.length > 1) {
      rawList = lines.map(line => ({
        title: line.slice(0, 80),
        category: /reminder|daily/i.test(line) ? 'REMINDER' : 'DAILY_EVENT',
        event_date: todayStr,
        details: line,
      }));
    } else {
      rawList = [{
        title: rawText.slice(0, 80),
        category: /reminder|daily/i.test(rawText) ? 'REMINDER' : 'DAILY_EVENT',
        event_date: todayStr,
        details: rawText,
      }];
    }
  }

  const savedEvents: any[] = [];

  for (const item of rawList) {
    const title = item.title || rawText.slice(0, 80);
    let category = (item.category || 'DAILY_EVENT').toUpperCase();
    if (
      /reminder|remind|daily|everyday|every day|recurring|repeat/i.test(title) ||
      /reminder|remind|daily|everyday|every day|recurring|repeat/i.test(item.details || '') ||
      /reminder|remind|daily|everyday|every day|recurring|repeat/i.test(rawText)
    ) {
      category = 'REMINDER';
    }
    const eventDate = item.event_date || todayStr;
    const location = item.location || null;
    const entityPerson = item.entity_person || null;
    const details = item.details || null;

    try {
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

      savedEvents.push({
        id: eventId,
        title,
        category,
        event_date: eventDate,
        location,
        entity_person: entityPerson,
        details,
      });
    } catch (dbErr) {
      console.error('Failed to insert event into D1:', dbErr);
    }
  }

  return {
    success: savedEvents.length > 0,
    events: savedEvents,
    event: savedEvents[0] || null,
  };
}

function formatAmount(amount: number, currency: string): string {
  try {
    const locale = currency === 'INR' ? 'en-IN' : 'en-US';
    return Number(amount).toLocaleString(locale, { maximumFractionDigits: 2 });
  } catch {
    return String(amount);
  }
}

function parseAmountAndCurrency(rawText: string): { amount: number | null; currency: string; isCurrencyAnchored: boolean } {
  let currency = 'USD';
  if (/₹|\bINR\b|\bRS\.?\b/i.test(rawText)) currency = 'INR';
  else if (/€|\bEUR\b/i.test(rawText)) currency = 'EUR';
  else if (/£|\bGBP\b/i.test(rawText)) currency = 'GBP';
  else if (/\$|\bUSD\b/i.test(rawText)) currency = 'USD';

  // 1. Currency prefix + amount: e.g. "INR 2,00,000.00", "Rs. 2,71,690", "Rs. 190", "₹1,500", "$50.25"
  const prefixMatch = rawText.match(
    /(?:(INR|RS\.?|₹|\$|€|£)\s*)([0-9]{1,3}(?:,[0-9]{2,3})*(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)/i
  );
  if (prefixMatch && prefixMatch[2]) {
    const sym = prefixMatch[1].toUpperCase();
    if (sym === '₹' || sym.startsWith('RS') || sym === 'INR') currency = 'INR';
    else if (sym === '€' || sym === 'EUR') currency = 'EUR';
    else if (sym === '£' || sym === 'GBP') currency = 'GBP';
    else if (sym === '$' || sym === 'USD') currency = 'USD';

    const num = parseFloat(prefixMatch[2].replace(/,/g, ''));
    if (!isNaN(num) && num > 0) {
      return { amount: num, currency, isCurrencyAnchored: true };
    }
  }

  // 2. Amount + currency suffix: e.g. "2,71,690 INR", "50 USD", "2000 EUR", "190 Rs"
  const suffixMatch = rawText.match(
    /([0-9]{1,3}(?:,[0-9]{2,3})*(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)\s*(INR|USD|EUR|GBP|₹|\$|€|£|RS\.?)\b/i
  );
  if (suffixMatch && suffixMatch[1]) {
    const sym = suffixMatch[2].toUpperCase();
    if (sym === '₹' || sym.startsWith('RS') || sym === 'INR') currency = 'INR';
    else if (sym === '€' || sym === 'EUR') currency = 'EUR';
    else if (sym === '£' || sym === 'GBP') currency = 'GBP';
    else if (sym === '$' || sym === 'USD') currency = 'USD';

    const num = parseFloat(suffixMatch[1].replace(/,/g, ''));
    if (!isNaN(num) && num > 0) {
      return { amount: num, currency, isCurrencyAnchored: true };
    }
  }

  // 3. Standalone number formatted with commas: e.g. "2,00,000.00", "2,71,690"
  const commaMatch = rawText.match(/\b([0-9]{1,3}(?:,[0-9]{2,3})+(?:\.[0-9]{1,2})?)\b/);
  if (commaMatch && commaMatch[1]) {
    const num = parseFloat(commaMatch[1].replace(/,/g, ''));
    if (!isNaN(num) && num > 0) {
      return { amount: num, currency, isCurrencyAnchored: true };
    }
  }

  // 4. Standalone simple number in short spend commands: e.g. "/spend 50 groceries", "lunch 20.50"
  const standaloneMatch = rawText.match(/(?:^|\s)([0-9]{1,6}(?:\.[0-9]{1,2})?)(?:\s|$)/);
  if (standaloneMatch && standaloneMatch[1]) {
    const num = parseFloat(standaloneMatch[1]);
    if (!isNaN(num) && num > 0) {
      return { amount: num, currency, isCurrencyAnchored: false };
    }
  }

  return { amount: null, currency, isCurrencyAnchored: false };
}

async function extractAndLogExpense(
  env: Env,
  rawText: string,
  username: string
): Promise<{ success: boolean; tx: any }> {
  const todayStr = getTodayDateStr(env.USER_TIMEZONE);
  let parsed: any = null;

  // 1. Fast deterministic regex extraction
  const regexResult = parseAmountAndCurrency(rawText);
  let regexEntity = 'General Expense';
  let regexNotes = rawText.trim();

  // Strip common bank SMS noise, currency symbols, and amount to get fallback entity
  const stripped = rawText
    .replace(/\bAlert:?\b/gi, '')
    .replace(/(?:INR|RS\.?|₹|\$|€|£)\s*[0-9]{1,3}(?:,[0-9]{2,3})*(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?/gi, '')
    .replace(/\b(for|on|at|to|spent|bought|paid|INR|USD|EUR|GBP)\b/gi, '')
    .replace(/[$₹€£]/g, '')
    .replace(/[-*#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (stripped) {
    regexEntity = stripped.slice(0, 80);
    regexNotes = stripped;
  }

  // 2. AI Extraction for deeper context, merchant detection and SMS parsing
  try {
    const aiRes = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fp8', {
      messages: [
        {
          role: 'system',
          content: `You are a financial transaction extraction assistant. Today's date is ${todayStr}.
Analyze the user message (which may be a bank SMS alert, credit card notification, or simple spend note) and extract into a single JSON object with this schema:
{
  "entity_person": "Vendor, merchant, store, or category (e.g. Ramreddy chicken market, G R T JEWELL, Starbucks, Amazon, Groceries)",
  "amount": number (The actual currency amount in RUPEES or DOLLARS, NOT in paise or cents! E.g. For 'Rs. 190', amount MUST BE 190, NEVER 19000. Do NOT multiply by 100. Do NOT use card numbers, account numbers, UPI reference numbers, phone numbers, or dates as amount),
  "currency": "USD" | "INR" | "EUR" | "GBP",
  "transaction_date": "YYYY-MM-DD (resolve words like yesterday, or dates in SMS like 21-Sep-26 into YYYY-MM-DD. Never return relative strings like '-1 month')",
  "notes": "card info, bank name, reference or short description"
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

  // Parse AI amount cleanly: handle numbers or string with commas (e.g. "2,00,000.00" or 200000)
  let aiAmount: number | null = null;
  if (parsed?.amount !== undefined && parsed?.amount !== null) {
    const cleanAiStr = String(parsed.amount).replace(/,/g, '').trim();
    const val = parseFloat(cleanAiStr);
    if (!isNaN(val) && val > 0) {
      aiAmount = val;
    }
  }

  // Determine final amount:
  // If regex found an explicit currency-anchored amount (e.g. "Rs. 190", "INR 2,00,000.00", "₹1,500", "$50.25"),
  // that directly attached number is our ground truth.
  // This completely eliminates LLM hallucinations (such as converting rupees to paise: 190 -> 19000).
  let finalAmount = 0;
  if (regexResult.isCurrencyAnchored && regexResult.amount !== null && regexResult.amount > 0) {
    finalAmount = regexResult.amount;
  } else if (aiAmount !== null && aiAmount > 0) {
    if (regexResult.amount !== null && Math.abs(aiAmount - regexResult.amount * 100) < 0.01) {
      finalAmount = regexResult.amount;
    } else {
      finalAmount = aiAmount;
    }
  } else if (regexResult.amount !== null && regexResult.amount > 0) {
    finalAmount = regexResult.amount;
  }

  const entity = (parsed?.entity_person && typeof parsed.entity_person === 'string' && parsed.entity_person !== 'General Expense' && parsed.entity_person.trim().length > 0)
    ? parsed.entity_person.trim()
    : regexEntity;

  let currency = (parsed?.currency || regexResult.currency || 'USD').toUpperCase();
  if (currency === 'RS' || currency === 'RS.') currency = 'INR';
  if (!['USD', 'INR', 'EUR', 'GBP', 'CAD', 'AUD', 'SGD'].includes(currency)) {
    currency = regexResult.currency || 'USD';
  }

  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  const txDate = (parsed?.transaction_date && typeof parsed.transaction_date === 'string' && dateRegex.test(parsed.transaction_date))
    ? parsed.transaction_date
    : todayStr;

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
  const rawAmount = body.amount;
  const amount = typeof rawAmount === 'number'
    ? rawAmount
    : parseFloat(String(rawAmount || '').replace(/,/g, ''));
  const currency = (body.currency || 'USD').toUpperCase();
  const txDate = body.transaction_date || new Date().toISOString().split('T')[0];
  const notes = body.notes || null;
  const isSecure = body.is_secure ? 1 : 0;

  if (!entity || isNaN(amount) || amount <= 0) {
    return c.json({ error: 'entity_person and a valid positive amount are required' }, 400);
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

// Admin Vector Sync Endpoint
app.all('/api/v1/sync-vectors', async (c) => {
  const { results: transactions } = await c.env.DB.prepare('SELECT * FROM transactions').all();
  const { results: events } = await c.env.DB.prepare('SELECT * FROM personal_events').all();

  let txCount = 0;
  for (const t of (transactions || []) as any[]) {
    try {
      const textToEmbed = `Financial Transaction: Paid/received ${t.currency} ${t.amount} with ${t.entity_person} on ${t.transaction_date}.${t.notes ? ` Notes: ${t.notes}` : ''}`;
      const embedRes = await c.env.AI.run('@cf/baai/bge-small-en-v1.5', { text: [textToEmbed] });
      await c.env.VECTORIZE.upsert([
        {
          id: `tx-${t.id}`,
          values: embedRes.data[0],
          metadata: {
            type: 'transaction',
            id: t.id,
            entity_person: t.entity_person,
            amount: t.amount,
            currency: t.currency,
            transaction_date: t.transaction_date,
            username: t.username,
            text: textToEmbed,
          },
        },
      ]);
      txCount++;
    } catch (e) {
      console.warn(`Failed to re-index tx-${t.id}:`, e);
    }
  }

  let eventCount = 0;
  for (const e of (events || []) as any[]) {
    try {
      const textToEmbed = `Event: [${e.category}] ${e.title} on ${e.event_date}.${e.location ? ` Location: ${e.location}.` : ''}${e.entity_person ? ` With: ${e.entity_person}.` : ''}${e.details ? ` Details: ${e.details}` : ''}`;
      const embedRes = await c.env.AI.run('@cf/baai/bge-small-en-v1.5', { text: [textToEmbed] });
      await c.env.VECTORIZE.upsert([
        {
          id: `event-${e.id}`,
          values: embedRes.data[0],
          metadata: {
            type: 'event',
            id: e.id,
            title: e.title,
            category: e.category,
            event_date: e.event_date,
            username: e.username,
            text: textToEmbed,
          },
        },
      ]);
      eventCount++;
    } catch (err) {
      console.warn(`Failed to re-index event-${e.id}:`, err);
    }
  }

  return c.json({ ok: true, reindexed_transactions: txCount, reindexed_events: eventCount });
});

// 4. Multimodal RAG Query Engine Helper (with Conversation Memory & Similarity Threshold)
async function executeRagQuery(
  env: Env,
  rawQuery: string,
  username: string,
  chatId?: string
): Promise<{ query: string; answer: string; events: any[]; transactions: any[]; vector_matches: number; sources: string[] }> {
  // Input sanitization: trim and cap length to 500 chars to avoid CPU/neuron exhaustion
  const query = (rawQuery || '').trim().slice(0, 500);
  if (!query) {
    return {
      query: '',
      answer: 'Please provide a non-empty question.',
      events: [],
      transactions: [],
      vector_matches: 0,
      sources: [],
    };
  }

  // A. Semantic Search in Vectorize (Dense Vector Similarity)
  let vectorHits: any[] = [];
  try {
    const embedRes = await env.AI.run('@cf/baai/bge-small-en-v1.5', { text: [query] });
    const queryVector = embedRes.data[0];
    const vecResults = await env.VECTORIZE.query(queryVector, { topK: 5, returnMetadata: 'all' });
    // Similarity threshold filtering (score >= 0.55): discard low-relevance noise to prevent hallucination
    vectorHits = (vecResults.matches || []).filter((hit: any) => (hit.score ?? 0) >= 0.55);
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
      eventSql += ' AND (event_date = ? OR category = "REMINDER" OR LOWER(title) LIKE "%remind%" OR LOWER(title) LIKE "%daily%" OR LOWER(title) LIKE "%everyday%" OR LOWER(details) LIKE "%daily%" OR LOWER(details) LIKE "%everyday%")';
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

  // Search transactions via entity or general money/expense query
  let matchingTx: any[] = [];
  const isFinancial = /\b(expense|expenses|spend|spent|spending|bought|buy|purchase|purchases|bill|bills|paid|pay|payment|cost|costs|money|transaction|transactions|finance|financial|ledger|inr|usd|eur|gbp|rs|₹|\$)\b/i.test(query);
  try {
    if (isFinancial) {
      const { results } = await env.DB.prepare(
        'SELECT * FROM transactions WHERE username = ? ORDER BY transaction_date DESC, id DESC LIMIT 15'
      ).bind(username).all();
      matchingTx = results || [];
    } else {
      const { results } = await env.DB.prepare(
        'SELECT * FROM transactions WHERE username = ? AND (LOWER(entity_person) LIKE ? OR LOWER(notes) LIKE ?) ORDER BY transaction_date DESC, id DESC LIMIT 10'
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
    contextParts.push(`Events in Ledger:\n${matchingEvents.map(e => `- [Event #${e.id}] [${e.category}] ${e.title} on ${e.event_date} at ${e.location || 'N/A'} with ${e.entity_person || 'N/A'}${e.details ? `. Note: ${e.details}` : ''}`).join('\n')}`);
  }

  // 3. Structured D1 Transactions
  if (matchingTx.length > 0) {
    contextParts.push(`Financial Records:\n${matchingTx.map(t => `- [Tx #${t.id}] Paid/received ${t.currency} ${formatAmount(t.amount, t.currency)} (${t.currency}) for/with ${t.entity_person} on ${t.transaction_date}${t.notes ? ` (Notes: ${t.notes})` : ''}`).join('\n')}`);
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
  const hasPersonalContext = contextParts.length > 0;
  const systemPrompt = `You are LifeTrace AI, a knowledgeable, concise, and helpful personal AI assistant and second brain. Today's date is ${todayStr}.
${hasPersonalContext ? `\nPersonal Ledger, Notes & Records:\n${contextParts.join('\n\n')}\n` : ''}
Instructions:
1. If the user's query asks about their personal life, schedule, expenses, notes, or history:
   - Use the provided personal context to answer accurately and concisely.
   - If no relevant records exist in their personal context, clearly inform them that you couldn't find any matching records in their ledger or notes.
2. If the user's query is a GENERAL or GENERIC question (e.g., world knowledge, science, coding, recipes, writing, general advice, explanations, math):
   - Answer helpfully, accurately, and concisely using your broad general knowledge.
3. Be conversational, polite, and direct.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...recentHistory,
    { role: 'user', content: query },
  ];

  try {
    const aiRes = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages,
      max_tokens: 600,
      temperature: 0.2,
    });
    finalAnswer = (aiRes as any)?.response || '';
  } catch (err) {
    console.warn('Llama 3.3 failed, falling back to Llama 3.1:', err);
    try {
      const fallbackRes = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fp8', {
        messages,
        max_tokens: 600,
      });
      finalAnswer = (fallbackRes as any)?.response || '';
    } catch (e) {
      console.warn('Workers AI answer generation warning:', e);
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
    finalAnswer = `I'm having trouble processing that right now. Please try asking again.`;
  }

  // Collect traceable source citations from retrieved context
  const sourceTags: string[] = [];
  for (const e of matchingEvents) {
    sourceTags.push(`Event #${e.id} (${e.title})`);
  }
  for (const t of matchingTx) {
    sourceTags.push(`Tx #${t.id} (${t.entity_person})`);
  }
  for (const hit of vectorHits) {
    if (hit.metadata?.type === 'document' && hit.metadata?.title) {
      sourceTags.push(`Doc: ${hit.metadata.title}`);
    } else if (hit.metadata?.id) {
      const typeLabel = hit.metadata?.type === 'transaction' ? 'Tx' : 'Event';
      sourceTags.push(`${typeLabel} #${hit.metadata.id}`);
    }
  }
  const uniqueSources = [...new Set(sourceTags)];

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
    sources: uniqueSources,
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

    const digestData = await getDailyDigestData(c.env, username, targetDate);
    let digestText = formatEventsForDigest(targetDate, username, digestData);

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
      return `• (ID: \`#${t.id}\`) *${t.entity_person}:* ${sym}${formatAmount(t.amount, t.currency)} (${t.currency}) on \`${t.transaction_date}\``;
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
      `• *Amount:* ${sym}${formatAmount(tx.amount, tx.currency)} (${tx.currency})\n` +
      `• *Date:* \`${tx.transaction_date}\`\n` +
      (tx.notes && tx.notes !== tx.entity_person ? `• *Notes:* _${tx.notes}_\n` : '') +
      `\n_Tip: Type /expenses to view recent transactions or /today for agenda._`;
    await sendTelegramMessage(token, chatId, reply);
    return c.json({ ok: true });
  }

  // /sync: Re-index all ledger records into Vectorize
  if (cmd === '/sync') {
    const { results: transactions } = await c.env.DB.prepare('SELECT * FROM transactions WHERE username = ?').bind(username).all();
    const { results: events } = await c.env.DB.prepare('SELECT * FROM personal_events WHERE username = ?').bind(username).all();
    let txCount = 0;
    for (const t of (transactions || []) as any[]) {
      try {
        const textToEmbed = `Financial Transaction: Paid/received ${t.currency} ${t.amount} with ${t.entity_person} on ${t.transaction_date}.${t.notes ? ` Notes: ${t.notes}` : ''}`;
        const embedRes = await c.env.AI.run('@cf/baai/bge-small-en-v1.5', { text: [textToEmbed] });
        await c.env.VECTORIZE.upsert([
          {
            id: `tx-${t.id}`,
            values: embedRes.data[0],
            metadata: {
              type: 'transaction',
              id: t.id,
              entity_person: t.entity_person,
              amount: t.amount,
              currency: t.currency,
              transaction_date: t.transaction_date,
              username: t.username,
              text: textToEmbed,
            },
          },
        ]);
        txCount++;
      } catch (e) {
        console.warn('Sync vector tx error:', e);
      }
    }
    await sendTelegramMessage(token, chatId, `🔄 *Ledger Synced:*\n• Re-indexed ${txCount} transactions and ${(events || []).length} events into Vectorize.`);
    return c.json({ ok: true });
  }

  // /log or /event or /add or /remind: Explicit event & reminder logging
  if (cmd === '/log' || cmd === '/event' || cmd === '/add' || cmd === '/remind') {
    if (!args) {
      await sendTelegramMessage(token, chatId, '⚠️ Please specify the event or reminder details.\nExample: `/log attended AI workshop in office today`\nOr reminder: `/remind check application status everyday`\nOr multiple: `/log 1. Team sync at 10am 2. Dentist at 3pm`');
      return c.json({ ok: true });
    }
    const { events } = await extractAndLogEvent(c.env, args, username);
    if (!events || events.length === 0) {
      await sendTelegramMessage(token, chatId, '⚠️ Could not save event. Please try again.');
      return c.json({ ok: true });
    }

    let reply = '';
    if (events.length === 1) {
      const event = events[0];
      const isRem = event.category === 'REMINDER';
      reply = 
        `${isRem ? '⏰ *Reminder Logged:*' : '✅ *Event Logged:*'}\n` +
        `📌 *${event.title}* (ID: \`#${event.id}\`)\n` +
        `🏷️ *Category:* \`${event.category}\`\n` +
        `📅 *Date:* \`${event.event_date}\`\n` +
        (event.location ? `📍 *Location:* ${event.location}\n` : '') +
        (event.entity_person ? `👤 *With:* ${event.entity_person}\n` : '') +
        (event.details ? `📝 *Notes:* _${event.details}_\n` : '') +
        `\n_Type /today to view your updated agenda!_`;
    } else {
      const items = events.map((ev, i) => `*${i + 1}.* 📌 *${ev.title}* (ID: \`#${ev.id}\`) — \`${ev.event_date}\` [${ev.category}]`).join('\n');
      reply = `✅ *Logged ${events.length} Items:*\n\n${items}\n\n_Type /today to view your updated agenda!_`;
    }
    await sendTelegramMessage(token, chatId, reply);
    return c.json({ ok: true });
  }

  // Intelligent Natural Language Message Classifier & Router:
  // Decides whether a message is:
  // 1. A Financial Transaction / Expense (bank SMS, spend notes)
  // 2. An Event / Reminder / Life Log
  // 3. A Question / Search query (routes to RAG)

  const trimmedText = text.trim();
  const isQuestion = trimmedText.endsWith('?') || /^(what|who|when|where|why|how|is|are|did|can|could|do|does|will|show|list|summarize|tell me|give me|check|find)\b/i.test(trimmedText);

  // 1. Automatic Financial Transaction / Bank SMS Detection
  const hasCurrencyOrAmount = /(?:(INR|RS\.?|₹|\$|€|£)\s*[0-9]|[0-9]+\s*(?:inr|rs|usd|\$))/i.test(trimmedText);
  const isBankSms = !isQuestion && (
    // Bank & Card SMS keywords: spent/debited/charged/transferred along with bank/card/account/ref/UPI markers
    (/\b(spent|debited|debited by|charged|paid to|sent to|withdrawn|transaction of)\b/i.test(trimmedText) &&
     (/\b(card|credit card|debit card|a\/c|acct|account|upi|vpa|ref|slice|amex|hdfc|sbi|icici|axis|kotak|pnb|paytm|gpay|phonepe)\b/i.test(trimmedText) || hasCurrencyOrAmount)) ||
    // Starts with "Spent", "Paid", "Bought", "Purchased" followed by currency/amount
    /^(spent|paid|bought|purchased)\s+([$₹€£]?[0-9]+)/i.test(trimmedText) ||
    // Raw spend format e.g. "coffee 4.50", "petrol 2000 inr", "groceries $50"
    /^(?:coffee|groceries|petrol|fuel|uber|ola|swiggy|zomato|dinner|lunch|breakfast|milk|vegetables|medicine)\s+[$₹€£]?[0-9]+/i.test(trimmedText)
  );

  if (isBankSms) {
    const { tx } = await extractAndLogExpense(c.env, trimmedText, username);
    const symbolMap: Record<string, string> = { USD: '$', INR: '₹', EUR: '€', GBP: '£' };
    const sym = symbolMap[tx.currency] || `${tx.currency} `;
    const reply = 
      `💰 *Expense Logged Automatically:*\n` +
      `• *Item / Vendor:* ${tx.entity_person} (ID: \`#${tx.id}\`)\n` +
      `• *Amount:* ${sym}${formatAmount(tx.amount, tx.currency)} (${tx.currency})\n` +
      `• *Date:* \`${tx.transaction_date}\`\n` +
      (tx.notes && tx.notes !== tx.entity_person ? `• *Notes:* _${tx.notes}_\n` : '') +
      `\n_Tip: Type /expenses to view recent transactions or /today for agenda._`;
    await sendTelegramMessage(token, chatId, reply);
    return c.json({ ok: true });
  }

  // 2. Automatic Event / Reminder / Life Log Detection
  const isEventStatement = !isQuestion && (
    /^(i attended|attended|went to|visited|had lunch with|had dinner with|had a meeting with|met with|flying to|flight to|booked|participated in)/i.test(trimmedText) ||
    /^(today|yesterday|tomorrow)\s+(i|we|there is|there was|i'm|i am)\b/i.test(trimmedText) ||
    /^(remind me|reminder|set a reminder|remember to|don't forget|dont forget)\b/i.test(trimmedText) ||
    /\b(everyday|every day|daily reminder)\b/i.test(trimmedText) ||
    /\b(doctor appointment|dentist appointment|meeting at|sync at|call with)\b/i.test(trimmedText)
  );

  if (isEventStatement) {
    const { events } = await extractAndLogEvent(c.env, trimmedText, username);
    if (events && events.length > 0) {
      let reply = '';
      if (events.length === 1) {
        const event = events[0];
        const isRem = event.category === 'REMINDER';
        reply = 
          `${isRem ? '⏰ *Reminder Logged:*' : '✅ *Event Logged:*'}\n` +
          `📌 *${event.title}* (ID: \`#${event.id}\`)\n` +
          `🏷️ *Category:* \`${event.category}\`\n` +
          `📅 *Date:* \`${event.event_date}\`\n` +
          (event.location ? `📍 *Location:* ${event.location}\n` : '') +
          (event.entity_person ? `👤 *With:* ${event.entity_person}\n` : '') +
          (event.details ? `📝 *Notes:* _${event.details}_\n` : '') +
          `\n_Type /today to view your agenda, or ask any question!_`;
      } else {
        const items = events.map((ev, i) => `*${i + 1}.* 📌 *${ev.title}* (ID: \`#${ev.id}\`) — \`${ev.event_date}\` [${ev.category}]`).join('\n');
        reply = `✅ *Logged ${events.length} Items:*\n\n${items}\n\n_Type /today to view your agenda, or ask any question!_`;
      }
      await sendTelegramMessage(token, chatId, reply);
      return c.json({ ok: true });
    }
  }

  // Natural Language Question via Edge RAG with conversational multi-turn memory
  try {
    const result = await executeRagQuery(c.env, text, username, chatId);
    let reply = `🌱 *LifeTrace AI:*\n\n${result.answer}`;
    if (result.sources && result.sources.length > 0) {
      reply += `\n\n📌 _Sources: ${result.sources.join(', ')}_`;
    }
    await sendTelegramMessage(token, chatId, reply);
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

  const digestData = await getDailyDigestData(c.env, username, todayStr);
  const msg = formatEventsForDigest(todayStr, username, digestData);
  const delivery = await sendTelegramMessage(token, chatId, msg);

  return c.json({
    today_events_count: digestData.todayEvents.length,
    reminders_count: digestData.reminders.length,
    upcoming_events_count: digestData.upcomingEvents.length,
    today_expenses_count: digestData.todayExpenses.length,
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

    const digestData = await getDailyDigestData(env, username, todayStr);
    const msg = formatEventsForDigest(todayStr, username, digestData);
    ctx.waitUntil(sendTelegramMessage(token, chatId, msg));
  },
};
