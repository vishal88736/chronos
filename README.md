# Chronos

**Ambient, promise-aware web research with a glass-box inspection surface.**
Built for the minimi Software Engineering Challenge.

Chronos answers a search question _and_ remembers the commitment attached to it. It hydrates
personal context from a local SQLite graph, plans a DAG of speculative searches, hedges and
scrapes the live web under a hard timeout, sieves the evidence with BM25, streams a cited
synthesis — then quietly keeps watching the page that matters. When the watched condition
changes, a pre-staged action draft waits behind a cognitive-load gate.

The evaluator can drive the whole loop deterministically from the UI in under five seconds.

<p align="center">
  <em>Local memory · self-healing DAG · zero-key search fallback · SSE telemetry · attention-gated nudges</em>
</p>

---

## Why this is not a mock

- **Real SQLite persistence** through `aiosqlite`, including WAL mode, seeded entities, TTL
  cache entries, and promise CRUD.
- **Real DAG planning** with strict Pydantic validation, topological waves, and an LLM or
  deterministic fallback planner.
- **Real retrieval**: Tavily/Serper when keys exist, raced against each other, with DuckDuckGo
  and a direct HTML endpoint as the zero-key fallback.
- **Real hedging**: every target URL is fetched concurrently by `httpx` with a **1.8 second**
  hard timeout; failed pages fall back to their search snippets.
- **Real DOM parsing** with BeautifulSoup; `script`, `style`, `nav`, `footer`, `header`, `svg`,
  `noscript`, `form` and `aside` tags are removed.
- **Real BM25** via `rank_bm25` over 120-word chunks with 20-word overlap. The self-healing
  threshold is `τ = 1.5`.
- **Real SSE**, not polling. Chat runs over a streamed `POST` response and background nudges are
  pushed over a long-lived `EventSource` connection.
- **Real background work** via `asyncio.create_task`: memory writeback and commitment extraction
  run outside the token stream.
- **Real page watching**: hashed DOM text, a semantic LLM diff, a staged action artifact, and the
  same attention gate used by the simulator.

With **no LLM key**, the planner and synthesis degrade gracefully to deterministic,
retrieval-grounded behavior. With **no paid search key**, search runs through DuckDuckGo.
No part of the demo depends on a stub endpoint.

---

## Five-stage architecture

```text
┌──────────────────────────────── Browser / Next.js 14 ────────────────────────────────┐
│                                                                                      │
│  LEFT: ambient chat + nudge surface             RIGHT: live glass-box inspector       │
│  ─────────────────────────────────             ─────────────────────────────────     │
│  starter traces · citation pills                hydration · DAG · BM25 funnel        │
│  contradiction callouts · nudge draft            promise watcher · simulator          │
│           ▲             │                                ▲              │             │
│           │ SSE TOKENs  │ POST /api/chat/stream          │ SSE NUDGE    │ POST       │
└───────────┴─────────────┴────────────────────────────────┴──────────────┴─────────────┘
                                                                         │
┌──────────────────────────────── FastAPI (async) ───────────────────────┼─────────────┐
│                                                                         │             │
│  1. HYDRATION + SPECULATION                                             │             │
│     memory_entities lookup → pronoun resolution → context envelope     │             │
│     /api/speculate: 400ms debounce → predicted queries → DNS + cache    │             │
│                         │                                               │             │
│  2. DAG PLANNER         ▼                                               │             │
│     LLM JSON (2–4 nodes) or deterministic DAG → Pydantic validation     │             │
│     node fields: id, query, depends_on, volatility                      │             │
│                         │                                               │             │
│  3. HEDGED RETRIEVAL + SELF-HEALING SIEVE                               │             │
│     TTL cache → provider race → 4 URLs × 1800ms → BeautifulSoup         │             │
│     → 120-word chunks → BM25 → `<τ` or all URLs failed? graft retry     │             │
│     SSE: SCRAPING / CACHED / HEALING / DONE, NODE_ADDED, SIEVE_METRICS  │             │
│                         │                                               │             │
│  4. CONTRADICTION-AWARE SYNTHESIS                                       │             │
│     top 8 → [src_1]…[src_8] → SSE TOKEN stream → CONTRADICTIONS         │             │
│                         │                                               │             │
│  5. PROMISE DAEMON + COGNITIVE-LOAD GATE                                │             │
│     create_task commitment extractor → caught_promises                  │             │
│     background hash watcher → semantic diff → action artifact           │             │
│     urgency gate → QUEUED_QUIET or NUDGED ──────────────────────────────┘             │
│                                                                                       │
│  SQLite: memory_entities · epistemic_cache · caught_promises                          │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

### Stage 1 — Zero-prompt hydration & speculation

`engine/hydrator.py` resolves known keys and conservative pronoun references against
`memory_entities`, then injects an authoritative context envelope into the planner. It never
puts that context into a web-search query.

The UI debounces typing by **400ms** and calls `POST /api/speculate`. Chronos predicts candidate
subqueries and warms DNS plus the epistemic cache in the background. The forecast query is
served from SQLite when the eventual DAG node matches it, so `HYDRATION.speculative_hit` and the
right-pane cache badge can be real rather than decorative.

After each turn, a background LLM or regex extractor writes newly stated durable facts back to
the local graph (for example: “my teammate Priya works on payments”).

### Stage 2 — Speculative DAG planner

`engine/dag_planner.py` asks an OpenAI-compatible fast model for strict JSON:

```json
{
  "nodes": [
    {
      "id": "q1",
      "query": "macOS Sequoia 15.4 ScreenCaptureKit memory leak release notes",
      "depends_on": [],
      "volatility": "VOLATILE"
    },
    {
      "id": "q2",
      "query": "ScreenCaptureKit memory leak workaround GitHub Apple developer forums",
      "depends_on": [],
      "volatility": "STATIC"
    }
  ]
}
```

The plan is validated for unique IDs, known dependencies, cycles, and a 2–4 node bound. Invalid
or missing LLM output falls back to a real heuristic planner. Commitment chatter is stripped
before anything reaches a search engine.

Dependencies are executed in topological waves with `asyncio.gather`. Independent branches are
truly concurrent.

### Stage 3 — Hedged retrieval, context sieve & self-healing

`engine/scraper_pool.py`:

1. Checks `epistemic_cache` by normalized query hash.
2. STATIC entries live for **86,400s**; VOLATILE entries live for **300s**.
3. With Tavily/Serper keys, providers are raced; the first useful result wins and the rest are
   cancelled. DuckDuckGo is always the fallback.
4. Fetches up to four URLs concurrently with a **1800ms** per-URL `httpx` timeout.
5. Removes non-content DOM tags and keeps readable blocks.
6. Falls back to the search snippet when a URL 403s, times out, or returns a thin JS shell.

`engine/context_sieve.py` chunks each source into **120 words with 20 words of overlap**,
tokenizes lowercase alphanumerics, and ranks chunks with `BM25Okapi`. Near-duplicate chunks are
discarded before the final eight sources are selected.

If a branch's peak BM25 score is below **1.5**, it has fewer than 40 scraped words, or every URL
failed, Chronos emits a `HEALING` update, generates a broader fallback query, emits `NODE_ADDED`
for `<node>_retry`, and executes exactly one retry branch. The UI renders the grafted branch
indented beneath its parent.

### Stage 4 — Contradiction-aware synthesis

`engine/synthesizer.py` gives the model the top eight chunks labelled `[src_1]` through
`[src_8]` and instructs it to cite every factual claim. Every citation pill in the response is
interactive; hovering one highlights and expands the exact BM25 chunk in the inspector.

After tokens are streamed, a structured contradiction audit compares the sources for
incompatible versions, dates, prices, measurements, or status claims. The result is emitted as a
`CONTRADICTIONS` SSE event and rendered as rose-colored source-discrepancy cards.

When no LLM is configured, a deterministic extractive synthesizer selects sentences from the
retrieved chunks, deduplicates by URL, and streams a cited evidence summary. It is not presented
as generative synthesis.

### Stage 5 — Promise daemon & attention gate

`engine/promise_daemon.py` extracts conditional commitments such as:

> “I promised Rahul I'd send the PR once Apple patches it.”

A promise stores actor, recipient, promised action, trigger condition, watch URL, priority,
time sensitivity, status, a hash of the last observed DOM, and a pre-staged draft artifact.

A background watcher polls each `WATCHING`/`QUEUED_QUIET` promise, hashes readable DOM text, and
mounts a semantic diff only when the content changes. A real change that satisfies the trigger
generates a ready-to-send Slack draft or PR-style action artifact.

The same gate runs in the evaluator simulator, which is network-independent and deterministic.

---

## The cognitive-load urgency formula

```
Urgency = (Priority × TimeSensitivity) / FocusLevel
```

Focus states:

| State | Value | Behaviour |
|---|---:|---|
| DEEP_FOCUS | 5 | Protect concentration aggressively |
| MEETING | 4 | Strong gate |
| NORMAL | 2 | Balanced |
| IDLE | 1 | Most nudges release immediately |

If `Urgency >= 2.5`, the promise moves to **NUDGED** and is pushed over SSE as a macOS-style
nudge pill. If `Urgency < 2.5`, it is held in **QUEUED_QUIET**. Changing focus re-evaluates every
held nudge; dropping to Idle flushes the queue immediately.

The built-in evaluator demo uses `Priority 2 × Sensitivity 2`:

- At **Deep Coding (5)**: `4 / 5 = 0.80` → `QUEUED_QUIET`
- After switching to **Idle (1)**: `4 / 1 = 4.00` → `NUDGED`, pill slides in immediately

Promise states: `WATCHING → QUEUED_QUIET ↔ NUDGED → RESOLVED`.

---

## Repository layout

```text
.
├── README.md
├── backend
│   ├── .env.example
│   ├── main.py                  # FastAPI app, SSE, orchestration, evaluator APIs
│   ├── db.py                    # aiosqlite schema, seed data, CRUD
│   ├── schemas.py               # strict Pydantic v2 contracts
│   ├── llm_client.py            # async OpenAI/Groq-compatible JSON + stream wrapper
│   ├── events.py                # SSE broker and process-local focus state
│   ├── requirements.txt
│   └── engine
│       ├── hydrator.py          # local entity hydration + memory writeback
│       ├── dag_planner.py       # speculative prefetch + DAG planning/rewrite
│       ├── scraper_pool.py      # provider race, hedged URL fetch, TTL cache
│       ├── context_sieve.py     # chunking, BM25, self-healing decision
│       ├── synthesizer.py       # cited streaming + contradiction audit
│       └── promise_daemon.py    # commitment extractor, DOM watcher, urgency gate
└── frontend
    ├── package.json
    ├── src/app                  # layout, page-level SSE controller, design tokens
    ├── src/components
    │   ├── TopMenuBar.tsx       # traffic lights, focus switcher, promise counter
    │   ├── NudgePill.tsx        # pre-staged artifact, copy/resolve/dismiss
    │   ├── ChatPane.tsx         # streaming chat, citation pills, discrepancies
    │   └── InspectorPane.tsx    # DAG, BM25 funnel, promise watcher, simulator
    └── src/types/chronos.ts     # mirrors backend schemas
```

---

## Quick start — exactly two terminals

### Prerequisites

- Python **3.11+** (3.12 also verified)
- Node.js **18.17+**
- Network access for live search
- Optional: one OpenAI-compatible LLM key
- Paid search keys are **not** required

### Terminal 1 — FastAPI + SQLite engine

```bash
cd backend
python3.11 -m venv .venv        # 3.11 or 3.12; the pinned 2024 stack predates 3.14 wheels
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env               # add GROQ_API_KEY or OPENAI_API_KEY if you have one
uvicorn main:app --reload --port 8000
```

`backend/chronos.db` is created automatically on first startup and seeded with:

- `rahul` → Rahul Sharma, Lead Systems Engineer on ScreenKit-Mac
- `my stack` → macOS Sequoia 15.4 Beta, Swift 6, Python FastAPI, Next.js
- `our target latency` → Sub-2000ms p95 end-to-end web search synthesis

API docs: <http://localhost:8000/docs> · Health: <http://localhost:8000/api/health>

### Terminal 2 — Next.js 14 workspace

```bash
cd frontend
npm install
cp .env.local.example .env.local
npm run dev
```

Open <http://localhost:3000>.

If your API is not on port 8000, edit `NEXT_PUBLIC_API_BASE` in `frontend/.env.local` and rebuild
or restart the dev server. The backend already allows localhost origins and configurable CORS.

### Port overrides

If port 8000 or 3000 is already occupied:

```bash
# Terminal 1
cd backend && source .venv/bin/activate
uvicorn main:app --reload --port 8787

# Terminal 2
cd frontend
echo 'NEXT_PUBLIC_API_BASE=http://127.0.0.1:8787' > .env.local
npm run dev -- -p 3002
```

Open <http://localhost:3002>. For a production build, rebuild after changing the env value:
`NEXT_PUBLIC_API_BASE=http://127.0.0.1:8787 npm run build`.

### Production build check

```bash
cd frontend && npm run build && npm start
```

The `chat/stream` endpoint is a POST stream, so the browser reads it with `fetch()` and a
`ReadableStream`; nudges use the native `EventSource` API on `GET /api/nudges/stream`.

---

## Evaluator demo path (≈5 seconds after the first answer)

1. Set focus to **Deep Coding 5** in the top bar.
2. Click the first starter chip:
   > Check if macOS Sequoia 15.4 fixed the ScreenCaptureKit memory leak—I promised Rahul I'd send the PR once Apple patches it.
3. Watch the left stream and the right glass-box simultaneously:
   - A matched `rahul` entity is injected from SQLite.
   - The DAG nodes move through pending/scraping/cached/healing/done.
   - Weak branches graft `_retry` nodes.
   - The BM25 funnel shows raw vs. sieved token counts.
   - Citation pills `[src_n]` highlight a chunk when hovered.
   - Source disagreement appears as a rose discrepancy card.
   - A promise is caught and `Active` increments.
4. Scroll to **Promise daemon**, click **Simulate target webpage update**.
   The action artifact is generated and held:
   **QUEUED_QUIET · urgency 0.80 < 2.50**.
5. Click **Idle 1** in the top bar. The nudge flushes instantly. Expand the accordion,
   click **Copy draft & resolve**, and watch the counter return to zero.

To test speculation:

- Begin typing one of the starter prompts and pause for 400ms.
- The composer shows **“Speculative cache warming…”**.
- Once the background candidate is cached, the inspector flips to **WARMED** and shows saved
  milliseconds.

To test the real background DOM watcher (not the simulator):

- Include a promise in a query, let Chronos choose a watch URL, and leave the backend running.
- The daemon polls every `WATCHER_INTERVAL_SECONDS` (default 45s). When the hash changes, it runs
  a semantic diff and emits a promise/nudge update over SSE.

---

## API surface

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/speculate` | 400ms-debounced entity resolution and speculative cache warming |
| `POST` | `/api/chat/stream` | SSE search + planning + scraping + synthesis pipeline |
| `GET` | `/api/nudges/stream` | Long-lived SSE firehose for nudge/promise events |
| `POST` | `/api/focus` | Change focus state and flush eligible `QUEUED_QUIET` promises |
| `POST` | `/api/simulate-mutation` | Deterministic page-change simulation and gate evaluation |
| `POST` | `/api/promises/{id}/resolve` | Mark a caught promise resolved |
| `GET` | `/api/state` | Full local memory graph + promise vault + focus state |
| `GET` | `/api/health` | Engine, provider, and subscription health |

### Chat SSE sequence

```text
HYDRATION
DAG_PLAN
NODE_UPDATE (SCRAPING / CACHED / HEALING / DONE / FAILED) ...
NODE_ADDED (only when self-healing)
SIEVE_METRICS
TOKEN ... TOKEN
CONTRADICTIONS
PROMISE_CAUGHT (when a commitment exists)
DONE
```

Both SSE endpoints send JSON inside `data:` lines. Chat is header-flushed with
`Cache-Control: no-cache`, `Connection: keep-alive`, and `X-Accel-Buffering: no`.

### Nudge SSE sequence

```text
HELLO
PROMISE_UPDATED
NUDGE
...
: keep-alive (every 15s)
```

---

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `GROQ_API_KEY` | — | Preferred low-latency Llama 3.3 70B key |
| `OPENAI_API_KEY` | — | Alternative OpenAI key |
| `LLM_API_KEY` | — | Any OpenAI-compatible key; highest priority |
| `LLM_BASE_URL` | auto | Custom provider base URL |
| `LLM_MODEL` | provider default | Synthesis model |
| `LLM_FAST_MODEL` | same as model | Planner/extraction/diff model |
| `TAVILY_API_KEY` | — | Optional premium search provider |
| `SERPER_API_KEY` | — | Optional premium search provider |
| `CHRONOS_DB_PATH` | `chronos.db` relative to `backend/` | SQLite location |
| `CORS_ORIGINS` | localhost:3000 / 127.0.0.1:3000 | Extra allowed browser origins |
| `WATCHER_INTERVAL_SECONDS` | `45` | Background DOM poll cadence |
| `SEARCH_TIMEOUT_MS` | `1800` | Hard per-URL fetch budget |

Provider selection:

1. `LLM_API_KEY` + optional `LLM_BASE_URL`
2. `GROQ_API_KEY` → Groq's OpenAI-compatible endpoint
3. `OPENAI_API_KEY` → OpenAI
4. No key → deterministic planner + extractive cited synthesis

Search selection:

1. Tavily and Serper are raced when both keys exist.
2. The first non-empty result wins; other premium calls are cancelled.
3. DuckDuckGo package, then direct DuckDuckGo HTML, then snippet fallback.

### No-key operation

No LLM key is required to see the complete architecture:

- DAG planning remains real and deterministic.
- Search still runs with zero paid keys.
- Synthesis streams extractive, cited evidence instead of generative prose.
- Promise extraction uses conservative regexes and still gates nudges.
- The simulator always works without network.

For the densest answer and full semantic contradiction detection, configure a fast LLM.

---

## Design system

Native macOS dark workspace with Linear/Raycast-style precision telemetry.

| Token | Value |
|---|---|
| Canvas | `#090A0F` |
| Elevated surface | `#11131A` |
| Inspector panel | `#0C0E14` |
| Glass popover | `rgba(22, 25, 36, 0.78)` + 16px backdrop blur |
| Hairline | `1px solid rgba(255, 255, 255, 0.08)` |
| Accent / primary | `#6366F1` |
| Cache / fast hit | `#06B6D4` |
| Self-healing / warning | `#F59E0B` |
| Healthy / resolved | `#10B981` |
| Contradiction / error | `#F43F5E` |

Typography uses self-hosted Inter Variable for UI prose and JetBrains Mono for latency badges,
token metrics, DAG IDs, and promise calculations. Every animation honours
`prefers-reduced-motion`.

---

## Data & caching model

```sql
memory_entities(key PRIMARY KEY, value, category, updated_at)
epistemic_cache(query_hash PRIMARY KEY, query_text, volatility, chunks_json, created_at, ttl_seconds)
caught_promises(id PRIMARY KEY, actor, recipient, promised_action, trigger_condition,
                watch_url, last_dom_hash, priority, time_sensitivity, status,
                draft_artifact, trigger_summary, created_at)
```

- STATIC TTL: **86,400s**
- VOLATILE TTL: **300s**
- Cache keys: lowercase alphanumeric normalization + SHA-256
- SQLite: WAL mode, short-lived async connections, 5s busy timeout
- Promise watcher state: persisted hash + in-memory previous text for semantic diffs

### Reset evaluator state

```bash
rm backend/chronos.db
# restart the backend; seeds are recreated automatically
```

---

## Verification performed

- Backend modules compile under Python 3.12 with all pinned dependencies installed.
- Next.js production build and strict TypeScript check pass.
- Live DuckDuckGo/HTML retrieval, BM25 scoring, caching, and streamed SSE exercised end-to-end.
- LLM planner, streamed synthesis, contradiction audit, and promise watch-URL selection exercised
  against an OpenAI-compatible local test double.
- Real promise extraction, focus gating, SSE nudge publication, and copy/resolve flow exercised
  through a headless Chromium session.
- Background watcher mutation → semantic diff → action artifact → queue → focus-release → nudge
  event verified against a changing local page.
- Zero-LLM fallback, self-healing retry branch, and deterministic simulator verified without keys.

---

## Operational notes

- Some JavaScript-heavy documentation pages expose little text to a 1.8s scraper. Chronos then
  uses the search snippet and marks the branch for healing if confidence is still low; this is
  visible rather than hidden.
- DuckDuckGo may rate-limit a network. Add Tavily or Serper keys for production-grade search.
- A promise can only be watched after at least one usable source URL has been retrieved. The
  simulator creates a safe seeded demo promise when the vault is empty.
- The local memory graph is only sent to the configured LLM provider for planning and writeback.
  It is never injected into a web-search query.
- All live navigation outputs are treated as untrusted data in synthesis prompts; source text is
  never executed.

## License

No license file is included; this repository is a challenge submission.
