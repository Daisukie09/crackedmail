const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const API = 'https://www.1secmail.com/api/v1/';

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Custom JSON parser that doesn't throw HTML errors
app.use((req, res, next) => {
  let body = '';
  req.on('data', chunk => { body += chunk.toString(); });
  req.on('end', () => {
    try {
      req.body = body ? JSON.parse(body) : {};
    } catch (e) {
      req.body = {};
    }
    next();
  });
});

const sessions = {};

function getSession(userId) {
  if (!sessions[userId]) {
    sessions[userId] = { login: null, domain: null, messages: [] };
  }
  return sessions[userId];
}

async function apiCall(action, params = {}) {
  const res = await axios.get(API, { params: { action, ...params } });
  return res.data;
}

app.post('/api/create-email', async (req, res) => {
  try {
    const session = getSession('default');
    const result = await apiCall('genRandomMailbox', { count: 1 });
    const email = result[0];
    const [login, domain] = email.split('@');
    
    session.login = login;
    session.domain = domain;
    session.messages = [];
    
    res.json({ success: true, email, aliasId: login, domain });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/inbox', async (req, res) => {
  try {
    const { aliasId, login, domain } = req.query;
    const session = getSession('default');
    
    const l = login || session.login;
    const d = domain || session.domain;
    
    if (!l || !d) return res.status(400).json({ error: 'No active email' });
    
    const messages = await apiCall('getMessages', { login: l, domain: d });
    session.messages = messages;
    
    const formatted = messages.map(m => ({
      subject: m.subject,
      meta: `${m.from} · ${m.date}`,
      preview: m.subject // 1secmail doesn't give preview in list, use subject
    }));
    
    res.json({ 
      emails: formatted, 
      subtitle: `${messages.length} message(s)`,
      aliasAddress: `${l}@${d}`
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/message', async (req, res) => {
  try {
    const { id, login, domain } = req.query;
    const session = getSession('default');
    const l = login || session.login;
    const d = domain || session.domain;
    
    if (!id || !l || !d) return res.status(400).json({ error: 'Missing params' });
    
    const msg = await apiCall('readMessage', { login: l, domain: d, id });
    res.json(msg);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/delete', async (req, res) => {
  try {
    const session = getSession('default');
    session.login = null;
    session.domain = null;
    session.messages = [];
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`VincentMail running on port ${PORT}`);
});

app.use(express.static(path.join(__dirname, 'public')));
