const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const API = 'https://api.mail.tm';

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const sessions = {};

function getSession(userId) {
  if (!sessions[userId]) {
    sessions[userId] = { token: null, address: null, id: null };
  }
  return sessions[userId];
}

async function getDomains() {
  const res = await axios.get(API + '/domains');
  return res.data['hydra:member'][0].domain;
}

async function createAccount() {
  const domain = await getDomains();
  const username = Math.random().toString(36).substring(2, 10);
  const password = Math.random().toString(36).substring(2, 14);
  const address = username + '@' + domain;
  
  await axios.post(API + '/accounts', { address, password });
  
  const tokenRes = await axios.post(API + '/token', { address, password });
  return { address, token: tokenRes.data.token, password };
}

async function getMessages(token) {
  const res = await axios.get(API + '/messages', {
    headers: { Authorization: 'Bearer ' + token }
  });
  return res.data['hydra:member'] || [];
}

app.post('/api/create-email', async (req, res) => {
  try {
    const session = getSession('default');
    const account = await createAccount();
    
    session.token = account.token;
    session.address = account.address;
    session.id = account.address.split('@')[0];
    
    res.json({ success: true, email: account.address, aliasId: session.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/inbox', async (req, res) => {
  try {
    const session = getSession('default');
    if (!session.token) return res.status(400).json({ error: 'No active email' });
    
    const messages = await getMessages(session.token);
    const formatted = messages.map(m => ({
      subject: m.subject || '(No Subject)',
      meta: `${m.from?.name || m.from?.address || 'Unknown'} · ${m.createdAt}`,
      preview: m.intro || m.subject || ''
    }));
    
    res.json({ 
      emails: formatted, 
      subtitle: `${messages.length} message(s)`,
      aliasAddress: session.address
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/message', async (req, res) => {
  try {
    const { id } = req.query;
    const session = getSession('default');
    if (!session.token || !id) return res.status(400).json({ error: 'Missing params' });
    
    const res2 = await axios.get(API + '/messages/' + id, {
      headers: { Authorization: 'Bearer ' + session.token }
    });
    res.json(res2.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/delete', async (req, res) => {
  try {
    const session = getSession('default');
    session.token = null;
    session.address = null;
    session.id = null;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`VincentMail running on port ${PORT}`);
});

app.use(express.static(path.join(__dirname, 'public')));
