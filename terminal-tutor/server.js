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
        model: 'claude-sonnet-4-6',
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
    onDone();
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

  broadcast({ type: 'start', cardType: 'command', label: command, exitCode });

  const { systemPrompt, userMsg } = buildPrompt(command, output, exitCode, patterns, false);
  await streamClaude(systemPrompt, userMsg,
    chunk => broadcast({ type: 'chunk', text: chunk }),
    ()    => broadcast({ type: 'done', exitCode })
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

app.get('/health', (req, res) => res.json({ ok: true, clients: clients.size }));

const PORT = process.env.PORT || 3737;
server.listen(PORT, () => {
  console.log(`\n⚡ Terminal Tutor running at http://localhost:${PORT}`);
  console.log(`Open that URL in Chrome, then run: source tutor.sh\n`);
});
