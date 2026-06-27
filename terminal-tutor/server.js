require('dotenv').config();
const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50kb' }));

let terminalHistory = [];

const GLOSSARY_FILE = path.join(__dirname, 'glossary.json');
let learnedGlossary = [];
try { learnedGlossary = JSON.parse(fs.readFileSync(GLOSSARY_FILE, 'utf8')); } catch { learnedGlossary = []; }

function saveGlossary() {
  fs.writeFileSync(GLOSSARY_FILE, JSON.stringify(learnedGlossary, null, 2));
}

const PROMPTS_FILE = path.join(__dirname, 'prompts.json');
let savedPrompts = [];
try { savedPrompts = JSON.parse(fs.readFileSync(PROMPTS_FILE, 'utf8')); } catch { savedPrompts = []; }

function savePrompts() {
  fs.writeFileSync(PROMPTS_FILE, JSON.stringify(savedPrompts, null, 2));
}

// ── CACHE ─────────────────────────────────────────────────────────────────────
const CACHE_FILE = path.join(__dirname, 'cache.json');
let cache = { commands: {}, terms: {} };
try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { cache = { commands: {}, terms: {} }; }

const cacheStats = { hits: 0, apiCalls: 0, termHits: 0 };

function saveCache() {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

function cacheKey(cmd) {
  return cmd.trim().toLowerCase().replace(/\s+/g, ' ');
}

function getCachedCommand(cmd) {
  return cache.commands[cacheKey(cmd)] || null;
}

function setCachedCommand(cmd, response) {
  const key = cacheKey(cmd);
  cache.commands[key] = { response, ts: Date.now(), hits: 0 };
  saveCache();
}

function getCachedTerms(cmd) {
  const words = cmd.toLowerCase().split(/\s+/);
  return words
    .filter(w => cache.terms[w])
    .map(w => ({ term: w, def: cache.terms[w] }));
}

function setCachedTerms(text) {
  const regex = /\*\*([^*\n]{2,60})\*\*\s*[—\-–:]\s*([^\n]{10,250})/g;
  let match; let added = false;
  while ((match = regex.exec(text)) !== null) {
    const term = match[1].trim().toLowerCase();
    const def  = match[2].trim().replace(/\.$/, '');
    if (!cache.terms[term]) { cache.terms[term] = def; added = true; }
  }
  if (added) saveCache();
}

// Commands that produce the same result every time — skip Claude on success
const SKIP_ON_SUCCESS = /^(git\s+(status|log|diff|branch|remote|tag|show)|ls|ll|la|pwd|echo|cat|clear|which|whoami|hostname|date|uname|env|printenv|type|alias|history)(\s|$)/i;

function extractAndSaveTerms(text) {
  const regex = /\*\*([^*\n]{2,60})\*\*\s*[—\-–:]\s*([^\n]{10,250})/g;
  let match;
  const newTerms = [];
  while ((match = regex.exec(text)) !== null) {
    const term = match[1].trim();
    const def = match[2].trim().replace(/\.$/, '');
    if (term.length > 1 && !learnedGlossary.some(g => g.term.toLowerCase() === term.toLowerCase())) {
      const entry = { term, def, cat: 'Learned', ts: Date.now() };
      learnedGlossary.push(entry);
      newTerms.push(entry);
    }
  }
  if (newTerms.length > 0) {
    saveGlossary();
    broadcast({ type: 'glossary_add', terms: newTerms });
  }
}

function extractAndSaveNextPrompt(text) {
  // Pull out the "Tell Claude: ..." text from the ➡️ NEXT PROMPT section
  const match = text.match(/➡️\s*NEXT PROMPT[\s\S]*?Tell Claude:\s*([^\n]+)/i);
  if (!match) return;
  const promptText = match[1].trim().replace(/^["']|["']$/g, '');
  if (promptText.length < 10) return;
  // Avoid saving duplicates
  if (savedPrompts.some(p => p.text.toLowerCase() === promptText.toLowerCase())) return;
  const entry = { id: Date.now(), title: promptText.slice(0, 60), text: promptText, tag: 'Auto', done: false, ts: Date.now() };
  savedPrompts.unshift(entry);
  savePrompts();
  broadcast({ type: 'prompt_add', prompt: entry });
}

const PATTERNS = [
  {
    id: 'push-main',
    match: cmd => /git push.*origin\s+(main|master)$/.test(cmd) || cmd === 'git push',
    severity: 'warning',
    flag: '⚠️ Pushing directly to main',
    tip: 'Consider pushing to a feature branch first, then opening a pull request. Main should only receive reviewed, tested code.'
  },
  {
    id: 'hardcoded-secret',
    match: cmd => /api[_-]?key\s*=\s*['"][a-zA-Z0-9]{10,}/i.test(cmd),
    severity: 'danger',
    flag: '🚨 Possible hardcoded secret detected',
    tip: 'Never put API keys in your code. Use environment variables: process.env.MY_API_KEY, stored in a .env file.'
  },
  {
    id: 'no-gitignore',
    match: (cmd, history) => cmd === 'git init' && !history.some(h => h.cmd.includes('.gitignore')),
    severity: 'warning',
    flag: '📄 Remember your .gitignore',
    tip: 'Create a .gitignore to stop Git tracking node_modules/, .env files, and build folders.'
  },
  {
    id: 'force-push',
    match: cmd => /git push.*(-f|--force)/.test(cmd),
    severity: 'danger',
    flag: '🚨 Force push — destructive operation',
    tip: 'Force pushing rewrites history. Only do this on your own feature branches, never on main.'
  },
  {
    id: 'rm-rf',
    match: cmd => /rm\s+-rf?\s+[^-]/.test(cmd),
    severity: 'danger',
    flag: '🚨 Permanent deletion — cannot be undone',
    tip: 'rm -rf deletes files forever with no recycle bin. Double-check the path before running.'
  },
  {
    id: 'env-not-ignored',
    match: cmd => /git add.*\.env(?!\w)/.test(cmd) || cmd === 'git add .',
    severity: 'warning',
    flag: '⚠️ Check .env is not being committed',
    tip: 'Make sure .env is in your .gitignore before staging all files. Secrets must never go to GitHub.'
  },
  {
    id: 'chmod-777',
    match: cmd => /chmod\s+(777|a\+rwx|ugo\+rwx)/.test(cmd),
    severity: 'danger',
    flag: '🚨 chmod 777 — full permissions to everyone',
    tip: 'chmod 777 gives every user on the system read, write, and execute access. Use 755 for directories, 644 for files. Principle of least privilege is tested in CompTIA Security+ and every cloud certification.'
  },
  {
    id: 'curl-insecure',
    match: cmd => /curl\s+.*(-k\b|--insecure)/.test(cmd),
    severity: 'danger',
    flag: '🚨 curl --insecure: SSL verification disabled',
    tip: 'The -k flag ignores certificate errors, making you vulnerable to man-in-the-middle attacks. Fix the certificate issue instead. Bypassing TLS verification is an OWASP-level vulnerability.'
  },
  {
    id: 'pip-no-venv',
    match: (cmd, history) => /^pip\s+install/.test(cmd) && !history.some(h => /venv|virtualenv|conda|pipenv|\.venv/.test(h.cmd)),
    severity: 'warning',
    flag: '⚠️ Python: No virtual environment detected',
    tip: 'Create a virtual environment first: python -m venv .venv && source .venv/bin/activate. Isolating dependencies per project prevents conflicts and is essential Python best practice.'
  },
  {
    id: 'aws-public-s3',
    match: cmd => /aws s3.*--acl\s+public-read/.test(cmd),
    severity: 'danger',
    flag: '🚨 AWS S3: Making object/bucket publicly readable',
    tip: 'Public S3 buckets are a leading cause of major data breaches. Use pre-signed URLs with expiry for temporary access instead. AWS Security Specialty and Solutions Architect exams test this heavily.'
  },
  {
    id: 'kubectl-delete',
    match: cmd => /kubectl\s+delete/.test(cmd),
    severity: 'warning',
    flag: '⚠️ kubectl delete — verify your cluster context first',
    tip: 'Run "kubectl config current-context" before deleting Kubernetes resources. Deleting from the wrong cluster (prod vs staging) is irreversible. Use --dry-run=client to preview what will be removed.'
  },
  {
    id: 'npm-audit-reminder',
    match: cmd => /^npm\s+(install|i)(\s|$)/.test(cmd),
    severity: 'warning',
    flag: '⚠️ Run npm audit after installing packages',
    tip: 'Run "npm audit" to check for known security vulnerabilities in your new dependencies. Software supply chain attacks are covered in CompTIA Security+ and AWS Security domains.'
  },
  {
    id: 'terraform-apply',
    match: cmd => /^terraform\s+apply/.test(cmd),
    severity: 'warning',
    flag: '⚠️ terraform apply — this changes real infrastructure',
    tip: 'Always run "terraform plan" first and read every proposed change. Infrastructure as Code is core to AWS DevOps Engineer, Solutions Architect, and CompTIA Cloud+ certifications.'
  },
  {
    id: 'hardcoded-password',
    match: cmd => /password\s*=\s*['"][^'"]{4,}/i.test(cmd) || /passwd\s*=\s*['"][^'"]{4,}/i.test(cmd),
    severity: 'danger',
    flag: '🚨 Possible hardcoded password detected',
    tip: 'Hardcoded passwords are OWASP A02:2021 (Cryptographic Failures). Use environment variables or AWS Secrets Manager. Hardcoded credentials will fail any security audit or certification assessment.'
  },
  {
    id: 'sudo-pip',
    match: cmd => /sudo\s+pip/.test(cmd),
    severity: 'warning',
    flag: '⚠️ sudo pip — installing Python packages as root',
    tip: 'Installing Python packages with sudo can corrupt system Python and create security vulnerabilities. Use a virtual environment (venv) instead — no sudo needed, no system risk.'
  },
  {
    id: 'git-add-all',
    match: cmd => cmd === 'git add -A',
    severity: 'warning',
    flag: '⚠️ Staging ALL changes — confirm .gitignore is complete',
    tip: 'git add -A stages everything. Ensure .gitignore includes .env, node_modules/, .aws/credentials, __pycache__/, .venv/, and build folders before running this.'
  },
  {
    id: 'docker-no-user',
    match: cmd => /docker run/.test(cmd) && !/--user/.test(cmd),
    severity: 'warning',
    flag: '⚠️ Docker container running as root by default',
    tip: 'Docker containers run as root unless specified. Add --user 1000:1000 or set USER in your Dockerfile. Running containers as non-root is a container security best practice tested in CKA and AWS certifications.'
  },
  {
    id: 'aws-no-profile',
    match: cmd => /^aws /.test(cmd) && !cmd.includes('--profile') && !cmd.includes('help'),
    severity: 'warning',
    flag: '⚠️ AWS CLI: Consider using named profiles',
    tip: 'Use --profile to specify a named IAM profile (never use root account for CLI). Create profiles with "aws configure --profile myapp". IAM least privilege is the #1 AWS certification concept.'
  },
  {
    id: 'supabase-rls-check',
    match: cmd => /^supabase\s+(db\s+push|db\s+reset|migration\s+up|start)/.test(cmd),
    severity: 'warning',
    flag: '⚠️ Supabase schema change — run RLS scan',
    tip: 'After pushing migrations, always verify RLS policies are in place. Click "Scan RLS" in the Security tab to detect exposed tables, missing policies, or USING (true) open access rules.'
  },
  {
    id: 'supabase-disable-rls',
    match: cmd => /disable\s+row\s+level\s+security|alter\s+table.*disable\s+rls/i.test(cmd),
    severity: 'danger',
    flag: '🚨 Disabling Row Level Security',
    tip: 'Disabling RLS exposes the entire table to any authenticated (or anonymous) user. Every Supabase table in production must have RLS enabled with explicit policies. This is a critical data breach risk.'
  },
  {
    id: 'supabase-anon-key',
    match: cmd => /SUPABASE_SERVICE_ROLE|service_role/.test(cmd) && /\.env|export|echo/.test(cmd),
    severity: 'danger',
    flag: '🚨 Supabase service role key detected in command',
    tip: 'The service_role key bypasses RLS completely. It must NEVER be used in frontend code or committed to git. Only use it server-side in environment variables. Treat it like a root database password.'
  },
  {
    id: 'npm-audit-missing',
    match: (cmd, history) => /^npm\s+(install|i|update)\b/.test(cmd) && !history.slice(-3).some(h => h.cmd === 'npm audit'),
    severity: 'warning',
    flag: '⚠️ Run npm audit after installing/updating packages',
    tip: 'Supply chain attacks via npm packages are the #1 way production apps get compromised. Run "npm audit" and "npm audit fix" after every install. CompTIA Security+ covers software supply chain security.'
  },
  {
    id: 'git-commit-no-message',
    match: cmd => /git commit -m ["']\.*["']/.test(cmd) || /git commit -m ["']\s*["']/.test(cmd),
    severity: 'warning',
    flag: '⚠️ Meaningless commit message',
    tip: 'Commit messages are the permanent record of why code changed. Write: what changed and why. Bad: "fix", ".", "wip". Good: "Add email validation to signup form". Future you will thank present you.'
  },
  {
    id: 'node-no-nvm',
    match: (cmd, history) => /^node\s/.test(cmd) && !history.some(h => /nvm use|nvm install/.test(h.cmd)),
    severity: 'warning',
    flag: '⚠️ Node.js running without version manager',
    tip: 'Install nvm (Node Version Manager) to switch Node versions per project. Run: "nvm use" in any project that has a .nvmrc file. Prevents "works on my machine" issues across teams and CI.'
  },
  {
    id: 'console-log-prod',
    match: cmd => /node\s+(server|app|index|main)\.(js|ts)/.test(cmd),
    severity: 'warning',
    flag: '⚠️ Running server — check for console.log statements',
    tip: 'console.log in production leaks sensitive data to server logs and slows performance. Use a proper logger (pino, winston) with log levels. Set LOG_LEVEL=error in production. Remove debug logs before deploying.'
  }
];

function detectPatterns(cmd, history) {
  return PATTERNS.filter(p => { try { return p.match(cmd, history); } catch { return false; } });
}

function buildPrompt(cmd, output, exitCode, patterns, isQuestion) {
  const recentHistory = terminalHistory.slice(-6)
    .map(h => `$ ${h.cmd}${h.output ? '\n' + h.output.slice(0, 200) : ''}`)
    .join('\n');

  const patternContext = patterns.length > 0
    ? `\n\nPATTERNS DETECTED:\n${patterns.map(p => `- ${p.flag}: ${p.tip}`).join('\n')}`
    : '';

  const systemPrompt = `You are an expert coding mentor embedded in a developer's terminal. The user is a non-technical founder building real apps. Teach them coding, security, and best practices in real-time.

FORMAT YOUR RESPONSE EXACTLY LIKE THIS:

⚡ WHAT JUST HAPPENED
[1-2 sentences. Plain English. What did this command actually do?]

📖 KEY TERMS
[Only if jargon was used. Format: **term** — simple one-line explanation. Max 3 terms. Skip if none.]

✅ WHY THIS IS GOOD / ❌ WHAT WENT WRONG
[Was this good practice? Did something fail? Be direct. 1-2 sentences.]

💡 BEST PRACTICE
[What should they do next or differently? Be specific. 1-2 sentences.]

🔐 SECURITY
[Only include if there is a real security consideration. Skip entirely if nothing applies.]

➡️ NEXT PROMPT
[Give the EXACT text to paste into Claude next if something important is missing. Format: "Tell Claude: [exact text]". Skip if nothing urgent.]

RULES:
- Each section emoji MUST be on its own line. Put content on the line BELOW the header, never on the same line.
- Never be long-winded. Digestible beats comprehensive.
- Explain every technical term you use
- Always be encouraging
- If a command failed (exit code not 0), lead with what went wrong and how to fix it
- Proactively flag anything that could cause production problems`;

  const userMsg = isQuestion
    ? `The user is asking: "${cmd}"\n\nRecent terminal context:\n${recentHistory}`
    : `Command: $ ${cmd}\nExit code: ${exitCode} (${exitCode === 0 ? 'SUCCESS' : 'FAILED'})\nOutput:\n${(output || '(no output)').slice(0, 1000)}${patternContext}\n\nRecent context:\n${recentHistory}`;

  return { systemPrompt, userMsg };
}

async function streamClaude(systemPrompt, userMsg, onChunk, onDone) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    onChunk('⚠️ No ANTHROPIC_API_KEY found.\n\nRun this in your terminal:\nexport ANTHROPIC_API_KEY="your-key-here"\n\nGet your key at: console.anthropic.com');
    onDone();
    return;
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': apiKey
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        stream: true,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMsg }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      onChunk(`API Error ${response.status}: ${err}`);
      onDone();
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
            onChunk(parsed.delta.text);
            fullText += parsed.delta.text;
          }
        } catch {}
      }
    }
    extractAndSaveTerms(fullText);
    extractAndSaveNextPrompt(fullText);
    setCachedTerms(fullText);
    onDone(fullText);
  } catch (err) {
    onChunk(`\nConnection error: ${err.message}`);
    onDone();
  }
}

const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log('Panel connected');
  ws.send(JSON.stringify({ type: 'ready' }));

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'question') {
        const { systemPrompt, userMsg } = buildPrompt(msg.text, '', 0, [], true);
        broadcast({ type: 'start', cardType: 'question', label: msg.text });
        await streamClaude(systemPrompt, userMsg,
          chunk => broadcast({ type: 'chunk', text: chunk }),
          ()    => broadcast({ type: 'done' })
        );
      }
    } catch(e) { console.error(e); }
  });

  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const c of clients) { if (c.readyState === 1) c.send(msg); }
}

app.post('/explain', async (req, res) => {
  res.json({ ok: true });
  const { command, output, exitCode = 0 } = req.body;
  if (!command || clients.size === 0) return;

  const patterns = detectPatterns(command, terminalHistory);
  terminalHistory.push({ cmd: command, output: (output||'').slice(0,300), exitCode, ts: Date.now() });
  if (terminalHistory.length > 30) terminalHistory.shift();

  if (patterns.length > 0) broadcast({ type: 'patterns', patterns });

  // Skip Claude entirely for boring successful commands
  if (exitCode === 0 && SKIP_ON_SUCCESS.test(command) && patterns.length === 0) return;

  broadcast({ type: 'start', cardType: 'command', label: command, exitCode });

  // ── Cache: exact command hit ──────────────────────────────────────────────
  const cached = getCachedCommand(command);
  if (cached && exitCode === 0) {
    cacheStats.hits++;
    cache.commands[cacheKey(command)].hits++;
    console.log(`[cache hit] ${command}`);
    broadcast({ type: 'chunk', text: cached.response });
    broadcast({ type: 'done', exitCode, fromCache: true });
    return;
  }

  // ── Cache: inject known terms to avoid re-explaining them ────────────────
  const knownTerms = getCachedTerms(command);
  let { systemPrompt, userMsg } = buildPrompt(command, output, exitCode, patterns, false);
  if (knownTerms.length > 0) {
    cacheStats.termHits += knownTerms.length;
    const termNote = knownTerms.map(t => `**${t.term}** — ${t.def}`).join('\n');
    systemPrompt += `\n\nThe user already knows these terms — do NOT re-explain them in KEY TERMS:\n${termNote}`;
  }

  // ── Call Claude ───────────────────────────────────────────────────────────
  cacheStats.apiCalls++;
  let fullResponse = '';
  await streamClaude(systemPrompt, userMsg,
    chunk => { broadcast({ type: 'chunk', text: chunk }); fullResponse += chunk; },
    ()    => {
      broadcast({ type: 'done', exitCode });
      if (exitCode === 0 && fullResponse.length > 50) setCachedCommand(command, fullResponse);
    }
  );
});

app.get('/glossary', (req, res) => res.json(learnedGlossary));

app.post('/glossary/add', (req, res) => {
  const { term, def, cat } = req.body;
  if (!term || !def) return res.status(400).json({ error: 'term and def required' });
  if (!learnedGlossary.some(g => g.term.toLowerCase() === term.toLowerCase())) {
    const entry = { term, def, cat: cat || 'Learned', ts: Date.now() };
    learnedGlossary.push(entry);
    saveGlossary();
    broadcast({ type: 'glossary_add', terms: [entry] });
  }
  res.json({ ok: true });
});

app.get('/prompts', (req, res) => res.json(savedPrompts));

app.post('/prompts/add', (req, res) => {
  const { title, text, tag } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  const entry = { id: Date.now(), title: title || text.slice(0, 50), text, tag: tag || 'General', ts: Date.now() };
  savedPrompts.unshift(entry);
  savePrompts();
  broadcast({ type: 'prompt_add', prompt: entry });
  res.json({ ok: true, prompt: entry });
});

app.patch('/prompts/:id', (req, res) => {
  const id = Number(req.params.id);
  const p = savedPrompts.find(x => x.id === id);
  if (!p) return res.status(404).json({ error: 'not found' });
  Object.assign(p, req.body);
  savePrompts();
  broadcast({ type: 'prompt_update', prompt: p });
  res.json({ ok: true, prompt: p });
});

app.delete('/prompts/:id', (req, res) => {
  const id = Number(req.params.id);
  savedPrompts = savedPrompts.filter(p => p.id !== id);
  savePrompts();
  broadcast({ type: 'prompt_delete', id });
  res.json({ ok: true });
});

// ── CONFIG (exposes non-secret env info to frontend) ─────────────────────────
app.get('/config', (req, res) => {
  res.json({
    supabaseUrl:    process.env.SUPABASE_URL    || null,
    hasServiceKey:  !!process.env.SUPABASE_SERVICE_KEY,
    projectPath:    process.env.PROJECT_PATH    || null,
  });
});

// ── RLS SCANNER ──────────────────────────────────────────────────────────────
app.post('/scan-rls', async (req, res) => {
  const url   = req.body.supabaseUrl  || process.env.SUPABASE_URL;
  const key   = req.body.serviceKey   || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return res.status(400).json({ error: 'SUPABASE_URL and SUPABASE_SERVICE_KEY required. Add to your .env or pass in the request.' });

  try {
    const headers = { 'apikey': key, 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' };

    // Get all public tables
    const tablesRes = await fetch(`${url}/rest/v1/rpc/get_tables`, { method: 'POST', headers, body: '{}' }).catch(() => null);

    // Fall back to information_schema query via SQL endpoint
    const sqlRes = await fetch(`${url}/rest/v1/rpc/exec_sql`, {
      method: 'POST', headers,
      body: JSON.stringify({ query: `
        SELECT t.table_name,
               COALESCE(array_agg(p.policyname) FILTER (WHERE p.policyname IS NOT NULL), '{}') AS policies,
               obj_description(c.oid) AS rls_enabled
        FROM information_schema.tables t
        LEFT JOIN pg_policies p ON p.tablename = t.table_name AND p.schemaname = 'public'
        LEFT JOIN pg_class c ON c.relname = t.table_name
        WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
        GROUP BY t.table_name, c.oid, c.relrowsecurity
        ORDER BY t.table_name
      ` })
    }).catch(() => null);

    // Direct pg_catalog query — most reliable
    const pgRes = await fetch(`${url}/rest/v1/`, { headers });
    const catalogRes = await fetch(`${url}/rest/v1/rpc/`, { method: 'GET', headers });

    // Use Supabase pg meta API (available on all projects)
    const [tabRes, polRes] = await Promise.all([
      fetch(`${url}/pg/tables?schema=public`, { headers: { 'apikey': key, 'Authorization': `Bearer ${key}` } }),
      fetch(`${url}/pg/policies?schema=public`, { headers: { 'apikey': key, 'Authorization': `Bearer ${key}` } })
    ]);

    const issues = [];
    let tables = [], policies = [];

    if (tabRes.ok && polRes.ok) {
      tables   = await tabRes.json();
      policies = await polRes.json();

      tables.forEach(t => {
        const tPolicies = policies.filter(p => p.table === t.name);
        if (!t.rls_enabled) {
          issues.push({ table: t.name, severity: 'critical', issue: 'RLS is DISABLED', detail: `Table "${t.name}" has no Row Level Security. Every authenticated user can read, write, and delete all rows.` });
        } else if (tPolicies.length === 0) {
          issues.push({ table: t.name, severity: 'high', issue: 'RLS enabled but NO policies', detail: `Table "${t.name}" has RLS enabled but zero policies — this blocks ALL access including your own app.` });
        } else {
          tPolicies.forEach(p => {
            if (p.definition && /using\s*\(\s*true\s*\)/i.test(p.definition)) {
              issues.push({ table: t.name, severity: 'critical', issue: `Open policy: "${p.name}"`, detail: `Policy uses USING (true) — allows any authenticated user to access all rows in "${t.name}". Add auth.uid() = user_id check.` });
            }
          });
        }
      });
    } else {
      return res.status(502).json({ error: 'Could not connect to Supabase. Check your URL and service key.' });
    }

    const result = { tables: tables.length, policies: policies.length, issues, scannedAt: new Date().toISOString() };
    broadcast({ type: 'rls_scan', result });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SECRET FILE SCANNER ───────────────────────────────────────────────────────
app.post('/scan-secrets', (req, res) => {
  const projectPath = req.body.path || process.env.PROJECT_PATH || process.cwd();
  const findings = [];
  const dangerPatterns = [
    // Secrets
    { re: /sk-[a-zA-Z0-9]{40,}/g,                        label: 'OpenAI API key',            severity: 'critical' },
    { re: /sk-ant-[a-zA-Z0-9\-_]{90,}/g,                 label: 'Anthropic API key',         severity: 'critical' },
    { re: /eyJ[a-zA-Z0-9_-]{50,}\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, label: 'Hardcoded JWT token', severity: 'critical' },
    { re: /AKIA[A-Z0-9]{16}/g,                            label: 'AWS Access Key ID',         severity: 'critical' },
    { re: /service_role[^a-z].*eyJ/g,                     label: 'Supabase service role key', severity: 'critical' },
    { re: /password\s*=\s*["'][^"']{6,}/gi,               label: 'Hardcoded password',        severity: 'critical' },
    { re: /api.?key\s*[=:]\s*["'][a-zA-Z0-9_\-]{16,}/gi, label: 'Hardcoded API key',         severity: 'critical' },
    // JWT misconfig
    { re: /jwt\.sign\s*\([^)]*\)\s*(?!.*expiresIn)/gs,   label: 'JWT signed without expiry (expiresIn missing)', severity: 'high' },
    { re: /algorithm\s*:\s*["']none["']/gi,               label: 'JWT algorithm set to "none" — verification bypassed', severity: 'critical' },
    { re: /jwt\.verify\s*\([^,)]+,[^,)]+\)/g,            label: 'JWT verify missing options (check expiry enforcement)', severity: 'high' },
    // CORS misconfig
    { re: /origin\s*:\s*["']\*["']/g,                     label: 'CORS wildcard origin (*) — allows any site to call your API', severity: 'high' },
    { re: /Access-Control-Allow-Origin['":\s]+\*/g,        label: 'CORS wildcard header set in code', severity: 'high' },
    { re: /cors\(\s*\)/g,                                  label: 'cors() called with no options — defaults to wildcard', severity: 'high' },
    // SQL injection
    { re: /`\s*(SELECT|INSERT|UPDATE|DELETE|DROP)[^`]*\$\{/gi, label: 'SQL injection risk — template literal in SQL query', severity: 'critical' },
    { re: /query\s*\(\s*[`"']?\s*(SELECT|INSERT|UPDATE|DELETE)[^`"']*\+\s*[a-zA-Z]/gi, label: 'SQL injection risk — string concatenation in query', severity: 'critical' },
    { re: /\.raw\s*\([^)]*\$\{/g,                         label: 'SQL injection risk — raw query with interpolation', severity: 'critical' },
    // OAuth redirect URI
    { re: /redirect_uri\s*[:=]\s*req\.(query|body|params)/gi, label: 'OAuth redirect_uri taken directly from user input — open redirect risk', severity: 'critical' },
    { re: /callback.*url.*=.*req\.(query|body)/gi,         label: 'OAuth callback URL from user input without validation', severity: 'high' },
  ];
  const ignoreDirs = new Set(['node_modules', '.git', '.next', 'dist', 'build', '__pycache__']);
  const ignoreFiles = new Set(['.env', '.env.local', '.env.example']);

  function scanDir(dir, depth = 0) {
    if (depth > 5) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (ignoreDirs.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { scanDir(full, depth + 1); continue; }
      if (ignoreFiles.has(entry.name)) continue;
      if (!/\.(js|ts|tsx|jsx|py|rb|go|env\.|json|yaml|yml|sh|md)$/.test(entry.name)) continue;
      let content;
      try { content = fs.readFileSync(full, 'utf8'); } catch { continue; }
      dangerPatterns.forEach(({ re, label }) => {
        re.lastIndex = 0;
        if (re.test(content)) {
          const relPath = path.relative(projectPath, full);
          if (!findings.some(f => f.file === relPath && f.label === label)) {
            findings.push({ file: relPath, label, severity: severity || 'critical' });
          }
        }
      });
    }
  }

  scanDir(projectPath);
  broadcast({ type: 'secret_scan', findings });
  res.json({ findings, scannedAt: new Date().toISOString() });
});

// ── FILE WATCHER ──────────────────────────────────────────────────────────────
let watcherActive = false;
const AUTH_FILE_PATTERNS = /\/(auth|middleware|supabase|client|session|token|jwt|login|signup|protect)\.(ts|js|tsx|jsx)$/i;

app.post('/watch/start', (req, res) => {
  const watchPath = req.body.path || process.env.PROJECT_PATH;
  if (!watchPath) return res.status(400).json({ error: 'path required' });
  if (watcherActive) return res.json({ ok: true, message: 'already watching' });

  try {
    fs.watch(watchPath, { recursive: true }, (event, filename) => {
      if (!filename || !AUTH_FILE_PATTERNS.test(filename)) return;
      const fullPath = path.join(watchPath, filename);
      let content;
      try { content = fs.readFileSync(fullPath, 'utf8'); } catch { return; }
      if (content.length > 8000) content = content.slice(0, 8000) + '\n... (truncated)';

      broadcast({
        type: 'file_change',
        filename,
        preview: content.slice(0, 300)
      });

      // Auto-send to Claude for security review
      const { systemPrompt } = buildPrompt(`[file changed] ${filename}`, content, 0, [], false);
      const secPrompt = systemPrompt + '\n\nFocus specifically on: auth flows, RLS bypass risks, missing session checks, exposed service keys, and broken access control. Flag every concern, no matter how small.';
      streamClaude(secPrompt,
        `Security review of changed file: ${filename}\n\nContent:\n${content}`,
        chunk => broadcast({ type: 'chunk', text: chunk }),
        ()    => broadcast({ type: 'done', exitCode: 0 })
      );
      broadcast({ type: 'start', cardType: 'command', label: `🔍 Security review: ${filename}`, exitCode: 0 });
    });
    watcherActive = true;
    res.json({ ok: true, watching: watchPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/watch/stop', (req, res) => {
  watcherActive = false;
  res.json({ ok: true });
});

app.get('/cache-stats', (req, res) => {
  const total = cacheStats.hits + cacheStats.apiCalls;
  const savedCalls = cacheStats.hits;
  const pct = total > 0 ? Math.round((savedCalls / total) * 100) : 0;
  res.json({
    ...cacheStats,
    total,
    hitRate: `${pct}%`,
    cachedCommands: Object.keys(cache.commands).length,
    cachedTerms:    Object.keys(cache.terms).length,
    estimatedSaved: `~$${(savedCalls * 0.0008).toFixed(4)}`
  });
});

app.get('/health', (req, res) => res.json({ ok: true, clients: clients.size, watching: watcherActive }));

const PORT = process.env.PORT || 3737;
server.listen(PORT, () => {
  console.log(`\n⚡ Terminal Tutor running at http://localhost:${PORT}`);
  console.log(`Open that URL in Chrome, then run: source tutor.sh\n`);
});
