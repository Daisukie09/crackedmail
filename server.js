const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const { CookieJar } = require('tough-cookie');
const path = require('path');

const app = express();
const PORT = 3000;
const BASE = 'https://www.phantommail.shop/public/';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// API Routes (MUST be before static middleware)
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  next();
});

const sessions = {};

const CRED_EMAIL = 'testuser_scrape2026@proton.me';
const CRED_PASS = 'TestPass123!';

function getSession(userId) {
  if (!sessions[userId]) {
    sessions[userId] = { jar: new CookieJar(), aliasId: null, email: null, loggedIn: false };
  }
  return sessions[userId];
}

async function post(url, body, jar, followRedirect = true) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Cookie': jar ? jar.getCookieStringSync(BASE) : '',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    },
    body: new URLSearchParams(body).toString(),
    redirect: 'manual'
  });

  const setCookies = res.headers.raw()['set-cookie'];
  if (setCookies && jar) {
    for (const c of setCookies) {
      try { await jar.setCookie(c, BASE); } catch(e) {}
    }
  }

  if (followRedirect && (res.status === 302 || res.status === 301)) {
    const location = res.headers.get('location');
    if (location) {
      const nextUrl = location.startsWith('http') ? location : BASE + location.replace(/^\//, '');
      return get(nextUrl, jar);
    }
  }

  const text = await res.text();
  return { status: res.status, body: text };
}

async function get(url, jar) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Cookie': jar ? jar.getCookieStringSync(BASE) : '',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    }
  });

  const setCookies = res.headers.raw()['set-cookie'];
  if (setCookies && jar) {
    for (const c of setCookies) {
      try { await jar.setCookie(c, BASE); } catch(e) {}
    }
  }

  const text = await res.text();
  return { status: res.status, body: text };
}

async function ensureLoggedIn(session) {
  if (session.loggedIn) {
    const check = await get(BASE + 'dashboard.php', session.jar);
    if (check.body && check.body.length > 500) {
      return true;
    }
  }

  console.log('[Auth] Logging in...');
  const result = await post(BASE, { action: 'login', email: CRED_EMAIL, password: CRED_PASS }, session.jar);
  
  if (result.status === 200 && result.body && result.body.length > 500) {
    session.loggedIn = true;
    console.log('[Auth] Login successful');
    return true;
  }

  console.log('[Auth] Login failed, status:', result.status);
  return false;
}

function extractEmail(html) {
  const successMatch = html.match(/Email created:\s*([a-f0-9]+@phantommail\.shop)/);
  const emailMatch = html.match(/data-email="([a-f0-9]+@phantommail\.shop)"/);
  
  const email = successMatch ? successMatch[1] : (emailMatch ? emailMatch[1] : null);
  const allAliasIds = [...html.matchAll(/fetch_emails\.php\?id=(\d+)/g)];
  // The newest email is at the TOP of the list = FIRST match in HTML
  const aliasId = allAliasIds.length > 0 ? allAliasIds[0][1] : null;
  
  return { email, aliasId };
}

function cleanPreview(text) {
  // Remove 🔑 emoji and "Code" labels
  text = text.replace(/🔑\s*/g, '');
  text = text.replace(/\bCode\b\s*/gi, '');
  // Fix merged date+code: "01:42:1594025" -> "01:42:15" and extract code
  text = text.replace(/(\d{2}:\d{2}:\d{2})(\d{5,6})/, '$1\n$2');
  // Remove extra whitespace but keep newlines
  text = text.replace(/[ \t]+/g, ' ').trim();
  return text;
}

function extractInbox(html) {
  const $ = cheerio.load(html);
  const emails = [];
  
  // Try multiple parsing strategies
  // Strategy 1: email-card class (modern design)
  $('.email-card').each((i, el) => {
    const subject = $(el).find('.email-subject').text().trim();
    let meta = $(el).find('.email-meta').text().trim();
    let preview = $(el).find('.preview-text').text().trim();
    const badge = $(el).find('.badge').text().trim();
    const body = $(el).find('.card-body').text().trim();
    if (!preview) preview = body;
    
    // Fix merged date+code: "01:42:1594025" -> "01:42:15"
    meta = meta.replace(/(\d{2}:\d{2}:\d{2})(\d{5,6})/, '$1');
    
    // Fix merged date+code in preview too
    preview = preview.replace(/(\d{2}:\d{2}:\d{2})(\d{5,6})/, '$1\n');
    // Remove 🔑 emoji and "Code" labels
    preview = preview.replace(/🔑\s*/g, '');
    preview = preview.replace(/\bCode\b\s*/gi, '');
    // Remove duplicate sender info
    const parts = preview.split('Facebook <registration@facebookmail.com>');
    if (parts.length > 1) {
      preview = 'Facebook <registration@facebookmail.com>' + parts[parts.length - 1];
    }
    // Clean up whitespace
    preview = preview.replace(/[ \t]+/g, ' ').trim();
    
    emails.push({ subject, meta, preview, badge });
  });
  
  // Strategy 2: if no emails found, try generic table/row parsing
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
  
  // Strategy 3: look for any content that looks like email data
  if (emails.length === 0) {
    const bodyText = $('body').text();
    if (bodyText.includes('@') && !bodyText.includes('No emails')) {
      // There might be email content we're not parsing correctly
      console.log('[Inbox] Raw body contains email-like content but parsing failed');
    }
  }
  
  const subtitle = $('.subtitle').text().trim();
  const aliasAddress = $('.alias-address').text().trim();
  
  return { emails, subtitle, aliasAddress };
}

// API Routes
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  next();
});

app.post('/api/create-email', async (req, res) => {
  try {
    const session = getSession('default');
    
    const loggedIn = await ensureLoggedIn(session);
    if (!loggedIn) {
      return res.status(500).json({ error: 'Failed to login to phantommail.shop' });
    }

    console.log('[Create] Creating email...');
    const result = await post(BASE + 'dashboard.php', { action: 'buy_alias' }, session.jar);
    
    if (!result.body || result.body.length < 100) {
      return res.status(500).json({ error: 'Empty response from server' });
    }

    const extracted = extractEmail(result.body);
    
    if (extracted.email) {
      session.aliasId = extracted.aliasId;
      session.email = extracted.email;
      console.log('[Create] Created:', extracted.email, 'ID:', extracted.aliasId);
      res.json({ success: true, email: extracted.email, aliasId: extracted.aliasId });
    } else {
      const errMatch = result.body.match(/bg-red-100[^>]*>(.*?)<\/div>/s);
      const errMsg = errMatch ? errMatch[1].replace(/<[^>]*>/g, '').trim() : 'Unknown error';
      console.log('[Create] Failed:', errMsg);
      res.status(400).json({ error: 'Failed to create email: ' + errMsg });
    }
  } catch (e) {
    console.error('[Create] Error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/inbox', async (req, res) => {
  try {
    const { userId, aliasId } = req.query;
    const session = getSession(userId || 'default');
    const id = aliasId || session.aliasId;
    
    if (!id) {
      return res.status(400).json({ error: 'No alias ID. Create an email first.' });
    }
    
    console.log('[Inbox] Fetching for alias ID:', id);
    const result = await get(BASE + 'fetch_emails.php?id=' + id, session.jar);
    const inbox = extractInbox(result.body);
    console.log('[Inbox] Found', inbox.emails.length, 'emails');
    res.json(inbox);
  } catch (e) {
    console.error('[Inbox] Error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/extend', async (req, res) => {
  try {
    const { userId, aliasId, days } = req.body;
    const session = getSession(userId || 'default');
    await ensureLoggedIn(session);
    
    const result = await post(BASE + 'dashboard.php', {
      action: 'extend_alias',
      alias_id: aliasId,
      days: days || 1
    }, session.jar);
    
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/delete', async (req, res) => {
  try {
    const { userId, aliasId } = req.body;
    const session = getSession(userId || 'default');
    await ensureLoggedIn(session);
    
    const result = await post(BASE + 'dashboard.php', {
      action: 'delete_alias',
      alias_id: aliasId
    }, session.jar);
    
    session.aliasId = null;
    session.email = null;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Static files (must be AFTER API routes)
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, path) => {
    if (path.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
    }
  }
}));

app.listen(PORT, () => {
  console.log(`VincentMail running at http://localhost:${PORT}`);
});
