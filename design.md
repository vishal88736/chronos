# Chronos — System Design & Architecture

## 1. Thesis

Standard web-search agents chain linear ReAct loops (`Prompt -> Search -> Scrape -> Summarize`), which introduces high tail latency, single-domain bias, and zero awareness of *why* the user is asking.

Chronos separates web search into two coupled execution paths:

1. **Synchronous Multi-Wave DAG Search (<5s p95):** Resolves ambient context and prior query timestamps, executes Wave 1 exploration in parallel, extracts concrete version/entity anchors to build Wave 2 verification queries, and compresses scraped HTML via an Authority + Freshness BM25 sieve.
2. **Asynchronous Promise & State Daemon (0ms added chat latency):** Extracts commitments tied to unresolved web states, polls target DOM hashes concurrently in the background, cross-checks outbound user activity to avoid redundant nagging, and gates notifications behind a Cognitive-Load Urgency model.

---

## 2. End-to-End Request Pipeline

### Stage 1: Privacy-Scoped Ambient Sensor & Temporal Hydration

* **OS Probes (`osascript` / `xdotool` / clipboard):** Extracts only structural identifiers (active filename, channel name, symbol) with per-probe timeouts and binary clipboard rejection — raw private text never leaves the machine.
* **Temporal & Entity Memory:** Injects matched `memory_entities` and timestamped prior queries from SQLite (`WAL` initialized once at startup) so follow-up questions know *what* was asked and *when*.

### Stage 2: Data-Driven 2-Wave DAG Planner

* **Wave 1 (Parallel Discovery):** Fires independent sub-queries concurrently under a strict 6s branch budget.
* **Wave 2 (Evidence-Driven Verification):** Rather than guessing Wave 2 queries upfront, Wave 2 nodes (`depends_on: [q1, q2]`) are synthesized from dominant version numbers and entities discovered in Wave 1.
* **Provider Fallbacks & Circuit Breakers:** When DuckDuckGo issues `202` bot challenges, a cooldown circuit breaker trips and routes queries across keyless structured APIs (GitHub, Stack Exchange, Wikipedia), cutting multi-branch scrape time from `13.9s` to `~4.9s`. If all upstream providers fail, Chronos degrades honestly rather than fabricating citations.

### Stage 3: Diversity-Capped Authority + Freshness Sieve

Chunks are scored and filtered before entering the LLM context window:

$$
\text{Score} = 0.60 \cdot \text{BM25}_{\text{norm}} + 0.25 \cdot \text{Authority} + 0.15 \cdot \text{Freshness}
$$

* **Diversity Cap:** Enforces a maximum of **2 chunks per URL** and **3 chunks per host** so a single verbose page cannot monopolize `[src_1]..[src_8]` or mask cross-source contradictions.
* **Composite Epistemic Cache:** Keyed on `(query_hash, volatility)` with opportunistic expired-row eviction so 24-hour `STATIC` cache entries never pollute `VOLATILE` live queries.

### Stage 4: Bi-Directional Promise Watcher & Cognitive-Load Gate

* **Concurrent Target Polling:** Background watchers poll tracked URLs concurrently via `asyncio.gather` so one slow host never delays sibling promises.
* **Auto-Verification (`AUTO_VERIFIED_SILENT`):** Cross-references the user's outbound activity log (commits, PRs, messages) before firing a nudge; if the user already fulfilled the promise, the nudge is suppressed automatically.
* **Attention Gate:** Computes $\text{Urgency} = \frac{\text{Priority} \times \text{Sensitivity}}{\text{FocusLevel}}$. Triggers below threshold remain in `QUEUED_QUIET` until the user exits `Deep Focus`.

---

## 3. Production Bugs Caught & Fixed via Runtime Verification

Verified by 137 automated checks (76 engine + 61 API) and headless-Chromium E2E tests:

| Issue Discovered at Runtime | Failure Mode | Architectural Fix |
| :--- | :--- | :--- |
| Cache keyed on query text alone | `STATIC` 24h cache served to explicit live/volatile queries | Keyed cache on `(query_hash, volatility)` + active TTL eviction |
| Uncapped per-URL chunk selection | Single long page filled all top slots (7.9% compression) | Enforced 2-per-URL / 3-per-host diversity cap in sieve |
| `request.is_disconnected()` inside SSE generator | Raced Starlette's ASGI disconnect listener, leaking broker queues | Lock-free pub/sub cleanup via `CancelledError` / `finally` block |
| Serial promise watcher loop | One slow domain stalled all active watchers by full timeout | Bounded concurrent polling per watcher tick |
| Hardcoded `response_format` | Crashed LLM providers without strict JSON-mode support | Provider capability negotiation + structured fallback parser |
| Per-connection `PRAGMA journal_mode=WAL` | Acquired write lock on every read query | Configured `WAL` once during database initialization |

---

## 4. Privacy Model

The ambient sensor is the only component that touches user data outside the
browser, and it is deliberately narrow:

| Surface | Read | Leaves the machine? | Used for |
|---|---|---|---|
| Frontmost app / window title | yes | no | disambiguating a subject |
| Editor selection | yes | no | extracting identifiers |
| Clipboard | yes, binary rejected | no | extracting identifiers |
| `memory_entities` | yes | only to the configured LLM, never to a search provider | disambiguation |
| Prior questions | yes | only to the configured LLM, never to a search provider | resolving references |

The rule throughout: **private context shapes the question, it never becomes
the question.** Only distinctive structural identifiers — a file name, a
channel, an identifier — are folded into a search query. Raw clipboard text,
window titles and prior questions stay inside the engine process.

---

## 5. Interface

The workspace is a single split screen: a conversational left pane and a
glass-box right pane that shows the engine thinking.

| Surface | Role |
|---|---|
| **Ambient session bar** | Connection state, the live ambient window, the local-context indicator |
| **Composer** | 400ms-debounced speculative prefetch, streaming with a native `EventSource`, copy-answer |
| **Nudge island** | The released nudge: urgency, trigger, pre-staged artifact, copy-and-resolve |
| **Auto-verified banner** | The quiet outcome — "Stayed quiet · auto-verified", no interruption |
| **Stage latency ribbon** | Proportional millisecond budget per stage, plus the flight-recorder export |
| **Ambient OS context card** | The detected window, the matched entities, and the temporal memory of prior questions |
| **Multi-wave DAG card** | Wave 1 and wave 2 branches with live status, latency, provider and self-healing detail |
| **Authority-weighted sieve card** | Compression ratio, the composite formula, and per-source authority / freshness / composite badges |
| **Promise daemon card** | The urgency math, both simulators, the caught promises, and the outbound activity log |

Visual language: deep-ink canvas, an emerald/teal signal colour, airy
surfaces, soft edges, and a dotted grid that recedes into the background. A
humanist serif for the display headline, Inter Variable for UI prose and
JetBrains Mono for latency badges, DAG ids and promise arithmetic. Every
animation honours `prefers-reduced-motion`.

---

## 6. Data Model

```sql
memory_entities(key PRIMARY KEY, value, category, updated_at)
epistemic_cache(query_hash PRIMARY KEY, query_text, volatility, chunks_json, created_at, ttl_seconds)
caught_promises(id PRIMARY KEY, actor, recipient, promised_action, trigger_condition,
                watch_url, last_dom_hash, priority, time_sensitivity, status,
                draft_artifact, trigger_summary, created_at,
                verification_note, urgency_score)
outbound_activity_log(id PRIMARY KEY, summary, kind, created_at)
query_history(id PRIMARY KEY, message, focus_level, created_at)
```

* `STATIC` TTL 86,400s · `VOLATILE` TTL 300s
* Cache keys: lowercase alphanumeric normalisation + SHA-256 **including the
  volatility**, so a day-lived entry can never be served to a live query
* Expired cache rows and surplus query history are evicted opportunistically
  on the watcher tick
* SQLite: WAL mode applied once at init, short-lived async connections, 5s
  busy timeout

---

## 7. API Surface

Every JSON key is `snake_case` on both sides of the wire; the Pydantic
contracts in `backend/schemas.py` and the TypeScript interfaces in
`frontend/src/types/chronos.ts` are 1:1.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/speculate` | 400ms-debounced entity resolution and speculative cache warming |
| `POST` | `/api/chat/stream` | SSE search + planning + scraping + synthesis pipeline |
| `GET` | `/api/chat/stream` | The same turn over query params, for the browser's native `EventSource` |
| `GET` | `/api/nudges/stream` | Long-lived SSE firehose for nudge/promise events |
| `GET` | `/api/ambient` | Current OS window / clipboard context, read locally |
| `POST` | `/api/focus` | Change focus state and flush eligible `QUEUED_QUIET` promises |
| `POST` | `/api/simulate-mutation` | Deterministic page-change simulation and gate evaluation |
| `POST` | `/api/promises/{id}/resolve` | Mark a caught promise resolved |
| `GET` | `/api/state` | Full local memory graph + promise vault + focus state |
| `GET` | `/api/activity` | The outbound activity log used for auto-verification |
| `GET` | `/api/trace/export` | Flight-recorder JSON for the recent turns |
| `GET` | `/api/trace/recent` | Compact trace summaries |
| `GET` | `/api/health` | Engine, provider and subscription health |

### Chat SSE sequence

```text
HYDRATION          → entities, ambient context, prior questions
DAG_PLAN           → wave 1 nodes, planner kind, planning latency
NODE_UPDATE        → per-branch status, latency, chunk count, provider
NODE_ADDED         → a self-heal branch, or the wave 2 dependent node
SIEVE_METRICS      → compression, composite scores, evidence, stage timings
TOKEN ... TOKEN    → the streamed, cited answer
CONTRADICTIONS     → genuine source conflicts
PROMISE_CAUGHT     → a commitment was recognised
DONE               → final elapsed time and the complete stage budget
```

### Nudge SSE sequence

```text
HELLO
PROMISE_UPDATED
AUTO_VERIFIED_SILENT   → the promise was already fulfilled; nothing was shown
NUDGE
...
: keep-alive (every 15s)
```

---

## 8. Running It

```bash
# Terminal 1 — the engine
cd backend
python3.11 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # optional: GROQ_API_KEY or OPENAI_API_KEY
uvicorn main:app --reload --port 8000

# Terminal 2 — the workspace
cd frontend
npm install
cp .env.local.example .env.local
npm run dev
```

No LLM key and no paid search key are required. The planner stays
deterministic, synthesis degrades to extractive cited evidence, and the search
layer falls through to the keyless structured APIs.

### Tests

```bash
cd backend
.venv/bin/python -m tests.test_engine   # 76 checks over the engine internals
.venv/bin/python -m tests.test_api      # 61 checks over the live HTTP surface
```
