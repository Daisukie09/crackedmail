const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cookie = require('cookie');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE = 'https://www.phantommail.shop/public/';

app.use(express.json({ limit: '1mb', strict: false }));
app.use(express.urlencoded({ extended: true }));

// Handle JSON parse errors
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  next(err);
});

const sessions = {};
const CRED_EMAIL = 'testuser_scrape2026@proton.me';
const CRED_PASS = 'TestPass123!';

function getSession(userId) {
  if (!sessions[userId]) {
    sessions[userId] = { cookies: {}, aliasId: null, email: null, loggedIn: false };
  }
  return sessions[userId];
}

function getCookieHeader(session) {
  return Object.entries(session.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

function saveCookies(session, setCookies) {
  if (!setCookies) return;
  for (const c of setCookies) {
    const parsed = cookie.parse(c);
    if (parsed.PHPSESSID) session.cookies.PHPSESSID = parsed.PHPSESSID;
  }
}

async function post(url, body, session) {
  const res = await axios.post(url, new URLSearchParams(body).toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Cookie': getCookieHeader(session),
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    },
    maxRedirects: 0,
    validateStatus: () => true
  });
  saveCookies(session, res.headers['set-cookie']);
  if (res.status === 302 || res.status === 301) {
    const location = res.headers['location'];
    if (location) {
      const nextUrl = location.startsWith('http') ? location : BASE + location.replace(/^\//, '');
      return get(nextUrl, session);
    }
  }
  return { status: res.status, body: res.data || '' };
}

async function get(url, session) {
  const res = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Cookie': getCookieHeader(session),
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    },
    validateStatus: () => true
  });
  saveCookies(session, res.headers['set-cookie']);
  return { status: res.status, body: res.data || '' };
}

async function ensureLoggedIn(session) {
  if (session.loggedIn && session.cookies.PHPSESSID) {
    const check = await get(BASE + 'dashboard.php', session);
    if (check.body && check.body.length > 500) return true;
  }
  const result = await post(BASE, { action: 'login', email: CRED_EMAIL, password: CRED_PASS }, session);
  if (result.status === 200 && result.body && result.body.length > 500) {
    session.loggedIn = true;
    return true;
  }
  return false;
}

function extractEmail(html) {
  const successMatch = html.match(/Email created:\s*([a-f0-9]+@phantommail\.shop)/);
  const emailMatch = html.match(/data-email="([a-f0-9]+@phantommail\.shop)"/);
  const email = successMatch ? successMatch[1] : (emailMatch ? emailMatch[1] : null);
  const allAliasIds = [...html.matchAll(/fetch_emails\.php\?id=(\d+)/g)];
  const aliasId = allAliasIds.length > 0 ? allAliasIds[0][1] : null;
  return { email, aliasId };
}

function extractInbox(html) {
  const $ = cheerio.load(html);
  const emails = [];
  $('.email-card').each((i, el) => {
    const subject = $(el).find('.email-subject').text().trim();
    let meta = $(el).find('.email-meta').text().trim();
    let preview = $(el).find('.preview-text').text().trim();
    const badge = $(el).find('.badge').text().trim();
    const body = $(el).find('.card-body').text().trim();
    if (!preview) preview = body;
    meta = meta.replace(/(\d{2}:\d{2}:\d{2})(\d{5,6})/, '$1');
    preview = preview.replace(/(\d{2}:\d{2}:\d{2})(\d{5,6})/, '$1\n');
    preview = preview.replace(/🔑\s*/g, '');
    preview = preview.replace(/\bCode\b\s*/gi, '');
    const parts = preview.split('Facebook <registration@facebookmail.com>');
    if (parts.length > 1) preview = 'Facebook <registration@facebookmail.com>' + parts[parts.length - 1];
    preview = preview.replace(/[ \t]+/g, ' ').trim();
    emails.push({ subject, meta, preview, badge });
  });
  if (emails.length === 0) {
    $('tr').each((i, el) => {
      const cells = $(el).find('td, th');
      if (cells.length >= 3) {
        const subject = $(cells.eq(0)).text().trim();
        const from = $(cells.eq(1)).text().trim();
        const date = $(cells.eq(2)).text().trim();
        if (subject && subject !== 'Email Address') {
          emails.push({ subject, meta: from + ' - ' + date, preview: '', badge: '' });
        }
      }
    });
  }
  return { emails, subtitle: $('.subtitle').text().trim(), aliasAddress: $('.alias-address').text().trim() };
}

app.post('/api/create-email', async (req, res) => {
  try {
    const session = getSession('default');
    const loggedIn = await ensureLoggedIn(session);
    if (!loggedIn) return res.status(500).json({ error: 'Failed to login' });
    const result = await post(BASE + 'dashboard.php', { action: 'buy_alias' }, session);
    if (!result.body || result.body.length < 100) return res.status(500).json({ error: 'Empty response' });
    const extracted = extractEmail(result.body);
    if (extracted.email) {
      session.aliasId = extracted.aliasId;
      session.email = extracted.email;
      res.json({ success: true, email: extracted.email, aliasId: extracted.aliasId });
    } else {
      res.status(400).json({ error: 'Failed to create email' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/inbox', async (req, res) => {
  try {
    const { aliasId } = req.query;
    const session = getSession('default');
    const id = aliasId || session.aliasId;
    if (!id) return res.status(400).json({ error: 'No alias ID' });
    const result = await get(BASE + 'fetch_emails.php?id=' + id, session);
    res.json(extractInbox(result.body));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/extend', async (req, res) => {
  try {
    const session = getSession('default');
    await ensureLoggedIn(session);
    await post(BASE + 'dashboard.php', { action: 'extend_alias', alias_id: req.body.aliasId, days: req.body.days || 1 }, session);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/delete', async (req, res) => {
  try {
    const session = getSession('default');
    await ensureLoggedIn(session);
    await post(BASE + 'dashboard.php', { action: 'delete_alias', alias_id: req.body.aliasId }, session);
    session.aliasId = null;
    session.email = null;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`VincentMail running on port ${PORT}`);
});

app.use(express.static(path.join(__dirname, 'public')));
