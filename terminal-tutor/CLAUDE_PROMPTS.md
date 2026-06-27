# Claude Prompts — Terminal Tutor

Paste new suggestions here after each session. 10 seconds now saves hours of scrolling later.

---

## Security

- [ ] Rotate the Stripe `pk_test_` key that was committed to git history — go to dashboard.stripe.com → Developers → API keys
- [ ] Make sure `.env` is in `.gitignore` before ever running `git add .` — secrets must never go to GitHub
- [ ] Set up named AWS CLI profiles (`aws configure --profile myapp`) — never use root account for CLI commands
- [ ] Audit any prompts below that touch API keys, passwords, or auth logic before executing

---

## Feature Prompts

### Teaching / AI Quality
- [ ] Add more warning patterns to `server.js` PATTERNS array:
  - `git commit -m "."` — meaningless commit message
  - Running `node` without a version manager (nvm) detected
  - `console.log` used in a file that looks like production code
- [ ] Raise `max_tokens` from 1500 → 2000 in `server.js` if responses still occasionally get cut off
- [ ] Add domain-specific rules to the system prompt in `buildPrompt()` — e.g. "when you see a Python command, always mention virtual environments"; "when you see AWS CLI, mention IAM least privilege"
- [ ] Add certification-track context to the prompt — detect when a command relates to AWS/Docker/Kubernetes and call out which cert exam covers it

### UI / UX
- [ ] Change scroll threshold from 60px → 100px in the scroll listener (`index.html` line ~1166) for a more forgiving auto-scroll zone
- [ ] Add a "jump to card" input — type `#7` and jump straight to that card number, so you don't have to scroll to find your place
- [ ] Add a search/filter bar to the Learn tab to find old cards by keyword
- [ ] Add a copy button to each card body so you can copy the explanation text easily

### Glossary
- [ ] Add a "Search glossary" input box to the Glossary tab
- [ ] Let user manually add terms from the UI (there's already a `/glossary/add` endpoint — just wire up a form)
- [ ] Export glossary as a PDF or markdown file for offline study

### Career Tab
- [ ] Add links to free resources (roadmap.sh, freeCodeCamp, AWS free tier) under each career track
- [ ] Add a checklist per track so user can mark off skills as they learn them

---

## Already Done

- [x] Add comprehensive teaching coverage — AWS, CompTIA, ISC2, Azure, AI, Cloud, Cybersecurity, Python, Web Dev, security patterns
- [x] Auto-growing persistent glossary — extracts `**term** — definition` from every response, saves to `glossary.json`
- [x] In-depth pre-loaded glossary (160+ terms) across all certification tracks
- [x] Enable text highlighting/selection in the panel (`user-select: text` on card bodies)
- [x] Restore original answer quality — reverted to original 6-section system prompt format
- [x] Move career/certification content to its own dedicated 🎓 Career tab
- [x] New messages do NOT auto-pull you away from reading — shows "▼ N new (#card)" button instead
- [x] "↑ Back to reading" button — saves scroll position when you jump to latest, click to return
- [x] Fix gibberish/truncated text — raised `max_tokens` 1000 → 1500, added `renderMarkdown()` for visual section separation
- [x] Fix auto-scroll bug — removed broken `isAutoScrolling` flag, replaced with simple `following` boolean
- [x] Add card numbers (#1, #2, #3…) to every message so you can track where you were reading
- [x] Set git `user.name` / `user.email` so machine hostname no longer leaks into commit metadata
- [x] Create `.gitignore` (node_modules, .DS_Store, *.log)
- [x] Push to separate feature branches — `feat/teaching-upgrade`, `feat/career-tab`, `feat/scroll-behavior`
