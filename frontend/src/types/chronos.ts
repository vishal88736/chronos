export type Volatility = "STATIC" | "VOLATILE";

export type NodeStatus =
  | "PENDING"
  | "SCRAPING"
  | "CACHED"
  | "HEALING"
  | "DONE"
  | "FAILED";

export type PromiseStatus = "WATCHING" | "QUEUED_QUIET" | "NUDGED" | "RESOLVED";

export type FocusLevel = 5 | 4 | 2 | 1;

export interface MemoryEntity {
  key: string;
  value: string;
  category: string;
  updated_at: number;
}

export interface DAGNode {
  id: string;
  query: string;
  depends_on: string[];
  volatility: Volatility;
  retry_of?: string | null;
}

export interface DAGNodeView extends DAGNode {
  status: NodeStatus;
  latency_ms?: number;
  chunks_found?: number;
  cached?: boolean;
  detail?: string | null;
}

export interface SourceChunk {
  id: string;
  node_id: string;
  title: string;
  url: string;
  text: string;
  bm25_score: number;
  token_count: number;
}

export interface Contradiction {
  topic: string;
  source_a: string;
  source_b: string;
  detail: string;
  source_a_url?: string | null;
  source_b_url?: string | null;
}

export interface CaughtPromise {
  id: string;
  actor: string;
  recipient: string;
  promised_action: string;
  trigger_condition: string;
  watch_url: string;
  last_dom_hash: string;
  priority: number;
  time_sensitivity: number;
  status: PromiseStatus;
  draft_artifact: string | null;
  trigger_summary: string | null;
  created_at: number;
}

export interface NudgePayload {
  promise_id: string;
  urgency: number;
  focus_level: number;
  trigger_summary: string;
  draft_artifact: string | null;
  recipient: string;
  promised_action: string;
}

export interface StateResponse {
  memory_entities: MemoryEntity[];
  caught_promises: CaughtPromise[];
  focus_level: FocusLevel;
  focus_label: string;
  active_promises: number;
  queued_promises: number;
  providers: Record<string, boolean>;
}

export interface SpeculateResponse {
  matched_entities: MemoryEntity[];
  predicted_queries: string[];
  warmed: boolean;
  saved_ms: number;
  status: "WARMED" | "WARMING" | "IDLE";
  speculative_query: string | null;
}

export interface FocusResponse {
  focus_level: FocusLevel;
  released: NudgePayload[];
  promises: CaughtPromise[];
}

export interface SimulateMutationResponse {
  promise: CaughtPromise;
  urgency: number;
  gated: boolean;
  focus_level: number;
  nudge: NudgePayload | null;
  message: string;
}

export interface HydrationEvent {
  type: "HYDRATION";
  entities: MemoryEntity[];
  context: string;
  pronouns_resolved: string[];
  speculative_hit: boolean;
  latency_ms: number;
}

export interface DAGPlanEvent {
  type: "DAG_PLAN";
  nodes: DAGNode[];
  planning_ms: number;
  planner: "llm" | "deterministic";
}

export interface NodeUpdateEvent {
  type: "NODE_UPDATE";
  node_id: string;
  status: NodeStatus;
  latency_ms: number;
  chunks_found: number;
  cached: boolean;
  detail?: string | null;
}

export interface NodeAddedEvent {
  type: "NODE_ADDED";
  node: DAGNode;
  reason: string;
}

export interface SieveMetricsEvent {
  type: "SIEVE_METRICS";
  raw_tokens: number;
  sieved_tokens: number;
  compression_pct: number;
  peak_bm25: number;
  sources: SourceChunk[];
}

export interface TokenEvent {
  type: "TOKEN";
  delta: string;
}

export interface ContradictionsEvent {
  type: "CONTRADICTIONS";
  items: Contradiction[];
}

export interface PromiseCaughtEvent {
  type: "PROMISE_CAUGHT";
  promise: CaughtPromise;
}

export interface NudgeEvent {
  type: "NUDGE";
  nudge: NudgePayload;
}

export interface PromiseUpdatedEvent {
  type: "PROMISE_UPDATED";
  promise: CaughtPromise;
}

export interface HelloEvent {
  type: "HELLO";
  focus_level: number;
  active_promises: number;
}

export interface DoneEvent {
  type: "DONE";
  elapsed_ms: number;
}

export interface ErrorEvent {
  type: "ERROR";
  message: string;
}

export type ChronosEvent =
  | HydrationEvent
  | DAGPlanEvent
  | NodeUpdateEvent
  | NodeAddedEvent
  | SieveMetricsEvent
  | TokenEvent
  | ContradictionsEvent
  | PromiseCaughtEvent
  | NudgeEvent
  | PromiseUpdatedEvent
  | HelloEvent
  | DoneEvent
  | ErrorEvent;

export type NudgeStreamEvent = NudgeEvent | PromiseCaughtEvent | PromiseUpdatedEvent | HelloEvent;

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  stopped?: boolean;
}

export interface SpeculationView {
  status: "WARMING" | "WARMED" | "IDLE";
  matchedEntities: MemoryEntity[];
  predictedQueries: string[];
  savedMs: number;
  speculativeQuery: string | null;
}

export interface SimulationView {
  message: string;
  gated: boolean;
  urgency: number;
  focusLevel: number;
  promiseId: string;
}

export interface PlannerMeta {
  label: "llm" | "deterministic";
  planningMs: number;
}

export interface TurnTelemetry {
  hydration: HydrationEvent | null;
  nodes: DAGNodeView[];
  planner: PlannerMeta | null;
  metrics: SieveMetricsEvent | null;
  contradictions: Contradiction[];
}
