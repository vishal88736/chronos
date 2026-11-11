"""Unit-level checks for the Chronos engine internals.

Run with:  backend/.venv/bin/python -m tests.test_engine
(or `pytest backend/tests/test_engine.py` if pytest is installed)
"""

from __future__ import annotations

import asyncio
import os
import sys
import tempfile
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

os.environ.setdefault("CHRONOS_DB_PATH", str(Path(tempfile.gettempdir()) / "chronos-test.db"))

import db  # noqa: E402
from engine.context_sieve import ContextSieve, NodeSieveResult  # noqa: E402
from engine.dag_planner import DAGPlanner, clean_for_search  # noqa: E402
from engine.promise_daemon import PromiseDaemon  # noqa: E402
from engine.synthesizer import Synthesizer  # noqa: E402
from llm_client import LLMClient, _extract_json  # noqa: E402
from schemas import DAGNode, DAGPlan, SourceChunk, Volatility  # noqa: E402


PASSED: list[str] = []
FAILED: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        PASSED.append(name)
        print(f"  PASS  {name}")
    else:
        FAILED.append(f"{name}: {detail}")
        print(f"  FAIL  {name} — {detail}")


# ── db: volatility-aware cache keys ───────────────────────────────────────────


async def test_cache_volatility_isolation() -> None:
    print("\n[db] epistemic cache separates volatility")
    await db.init_db()
    await db.put_cached_query("shared query", "STATIC", [{"text": "static body"}], 3600)
    await db.put_cached_query("shared query", "VOLATILE", [{"text": "volatile body"}], 3600)

    static_entry = await db.get_cached_query("shared query", "STATIC")
    volatile_entry = await db.get_cached_query("shared query", "VOLATILE")

    check(
        "static and volatile entries do not collide",
        static_entry is not None
        and volatile_entry is not None
        and static_entry["query_hash"] != volatile_entry["query_hash"],
        f"{static_entry and static_entry['query_hash']} vs {volatile_entry and volatile_entry['query_hash']}",
    )
    check(
        "volatile entry returns volatile payload",
        volatile_entry is not None and volatile_entry["chunks"][0]["text"] == "volatile body",
        str(volatile_entry),
    )


async def test_cache_purge() -> None:
    print("\n[db] expired cache rows are purged")
    await db.put_cached_query("purge me", "VOLATILE", [{"text": "x"}], -1)
    deleted = await db.purge_expired_cache()
    check("purge removes expired rows", deleted >= 1, f"deleted={deleted}")
    check(
        "expired entry is not returned as fresh",
        await db.get_cached_query("purge me", "VOLATILE") is None,
    )


async def test_promise_column_guard() -> None:
    print("\n[db] promise updates are restricted to known columns")
    try:
        await db.update_promise("pm_missing", id="hijack")
    except ValueError as exc:
        check("unknown column is rejected", "unknown promise columns" in str(exc), str(exc))
    else:
        check("unknown column is rejected", False, "no ValueError raised")


# ── context sieve: evidence diversity ─────────────────────────────────────────


def _chunk(url: str, text: str, score: float, node: str = "q1") -> dict:
    return {
        "node_id": node,
        "title": f"Title for {url}",
        "url": url,
        "text": text,
        "bm25_score": score,
        "token_count": len(text) // 4,
        "chunk_index": 0,
    }


def test_sieve_diversity() -> None:
    print("\n[sieve] one page cannot monopolise the evidence budget")
    sieve = ContextSieve()
    # Four chunks from the same URL plus two from other URLs.
    same = "latency benchmark tail p99 measurement fastapi results " * 12
    chunks = [
        _chunk("https://a.example/one", same, 9.0),
        _chunk("https://a.example/one", same + " variant one extra words here", 8.5),
        _chunk("https://a.example/one", same + " variant two extra words here", 8.0),
        _chunk("https://a.example/one", same + " variant three extra words here", 7.5),
        _chunk("https://b.example/two", "fiber gin http router performance numbers", 5.0),
        _chunk("https://c.example/three", "release notes changelog version history api", 4.0),
    ]
    result = NodeSieveResult(node_id="q1", query="latency", chunks=chunks)
    metrics = sieve.assemble([result], limit=8)

    urls = [source.url for source in metrics.sources]
    per_url = {url: urls.count(url) for url in set(urls)}
    check(
        "no URL contributes more than 2 chunks",
        all(count <= 2 for count in per_url.values()),
        str(per_url),
    )
    check(
        "at least two distinct hosts survive",
        len({url.split("/")[2] for url in urls}) >= 2,
        str(urls),
    )
    check("selected chunks stay within the limit", len(metrics.sources) <= 8, str(len(metrics.sources)))


def test_sieve_no_evidence() -> None:
    print("\n[sieve] empty corpora are flagged for self-healing")
    sieve = ContextSieve()
    result = sieve.sieve_node("q1", "query", [])
    check("empty result needs healing", result.needs_healing, str(result))
    check(
        "empty result explains itself",
        bool(result.healing_reason),
        str(result.healing_reason),
    )


def test_sieve_weak_evidence() -> None:
    print("\n[sieve] weak BM25 confidence triggers healing")
    sieve = ContextSieve()
    docs = [{"url": "https://x.example", "title": "t", "text": "lorem ipsum dolor sit amet " * 40}]
    result = sieve.sieve_node("q1", "quantum chromodynamics calibration", docs)
    check("low-scoring corpus needs healing", result.needs_healing, str(result))


# ── planner ──────────────────────────────────────────────────────────────────


def test_planner_deterministic() -> None:
    print("\n[planner] deterministic planner always yields a valid DAG")
    planner = DAGPlanner(LLMClient())
    plan = planner.deterministic_plan("Compare FastAPI vs Go Fiber tail latency benchmarks")
    check("plan validates", isinstance(plan, DAGPlan), str(plan))
    check("plan has 2+ nodes", len(plan.nodes) >= 2, str(len(plan.nodes)))
    check("node ids are unique", len({n.id for n in plan.nodes}) == len(plan.nodes))
    check(
        "comparison yields one node per side",
        "fastapi" in plan.nodes[0].query.lower() and "fiber" in plan.nodes[1].query.lower(),
        str([n.query for n in plan.nodes]),
    )


def test_planner_rejects_cycles() -> None:
    print("\n[planner] cyclic DAGs are rejected")
    try:
        DAGPlan(
            nodes=[
                DAGNode(id="a", query="alpha query", depends_on=["b"]),
                DAGNode(id="b", query="beta query", depends_on=["a"]),
            ]
        )
    except ValueError as exc:
        check("cycle is rejected", "cycle" in str(exc).lower(), str(exc))
    else:
        check("cycle is rejected", False, "no error raised")


def test_clean_for_search() -> None:
    print("\n[planner] commitment chatter is stripped from search queries")
    cleaned = clean_for_search(
        "Check if macOS 15.4 fixed the leak—I promised Rahul I'd send the PR once Apple patches it"
    )
    check("promise clause removed", "promised" not in cleaned.lower(), cleaned)
    check("research clause kept", "macos" in cleaned.lower(), cleaned)


# ── llm client helpers ───────────────────────────────────────────────────────


def test_extract_json() -> None:
    print("\n[llm] JSON extraction tolerates real model output")
    check("plain object", _extract_json('{"a": 1}') == {"a": 1})
    check("fenced object", _extract_json('```json\n{"a": 1}\n```') == {"a": 1})
    check("object in prose", _extract_json('Sure! {"a": 1} hope that helps') == {"a": 1})
    check(
        "braces inside strings do not truncate",
        _extract_json('{"a": "}"}') == {"a": "}"},
        str(_extract_json('{"a": "}"}')),
    )
    check("garbage returns None", _extract_json("not json at all") is None)


# ── promise daemon ───────────────────────────────────────────────────────────


def test_urgency_formula() -> None:
    print("\n[promises] urgency = (priority × sensitivity) / focus")
    daemon = PromiseDaemon(LLMClient())
    promise = {"priority": 2, "time_sensitivity": 2}
    check("focus 5 → 0.80", daemon.urgency(promise, 5) == 0.8, str(daemon.urgency(promise, 5)))
    check("focus 1 → 4.00", daemon.urgency(promise, 1) == 4.0, str(daemon.urgency(promise, 1)))
    check("never divides by zero", daemon.urgency(promise, 0) == 4.0)


async def test_gate_and_duplicate() -> None:
    print("\n[promises] gate, dedupe and duplicate detection")
    await db.init_db()
    daemon = PromiseDaemon(LLMClient())

    created = await db.create_promise(
        {
            "id": "pm_test_gate",
            "actor": "You",
            "recipient": "Rahul",
            "promised_action": "send the PR",
            "trigger_condition": "Apple patches the leak",
            "watch_url": "https://developer.apple.com/news/releases/",
            "last_dom_hash": daemon._unobserved_hash("pm_test_gate"),
            "priority": 2,
            "time_sensitivity": 2,
            "status": "WATCHING",
            "draft_artifact": None,
            "trigger_summary": None,
            "created_at": 0,
        }
    )
    check("promise persisted", created["id"] == "pm_test_gate")

    gated = await daemon.evaluate_nudge_gate(created, 5)
    check("deep focus gates the nudge", gated["gated"] is True, str(gated))
    check("gated urgency is 0.80", gated["urgency"] == 0.8, str(gated["urgency"]))

    released = await daemon.evaluate_nudge_gate({**created, "status": "WATCHING"}, 1)
    check("idle focus releases the nudge", released["gated"] is False, str(released))
    check("released nudge carries a payload", released["nudge"] is not None)

    duplicate = await db.find_duplicate_promise(
        "Rahul", "send the PR", "https://developer.apple.com/news/releases/"
    )
    check("duplicate promise is detected", duplicate is not None)

    result, is_duplicate = await daemon.extract_promise(
        "I promised Rahul I will send the PR once Apple patches it",
        [{"url": "https://developer.apple.com/news/releases/", "title": "t", "text": "x"}],
    )
    check(
        "an already-known commitment is reported as a duplicate",
        is_duplicate is True and result is not None,
        f"duplicate={is_duplicate} result={result and result['id']}",
    )


# ── synthesizer ──────────────────────────────────────────────────────────────


async def test_extractive_synthesis() -> None:
    print("\n[synth] extractive fallback cites its evidence")
    synthesizer = Synthesizer(LLMClient())
    sources = [
        SourceChunk(
            id="src_1",
            node_id="q1",
            title="Apple release notes",
            url="https://developer.apple.com/x",
            text="macOS 15.4 beta 3 ships a fix for the ScreenCaptureKit memory leak in version 15.4.",
            bm25_score=5.0,
            token_count=24,
        ),
        SourceChunk(
            id="src_2",
            node_id="q2",
            title="Developer report",
            url="https://github.com/x/y",
            text="The ScreenCaptureKit memory leak still persists on macOS 15.4 beta according to this report.",
            bm25_score=3.0,
            token_count=22,
        ),
    ]
    chunks = [chunk async for chunk in synthesizer._extractive_answer("ScreenCaptureKit leak", sources)]
    answer = "".join(chunks)
    check("answer is produced", len(answer) > 40, answer[:80])
    check("answer cites a source", "[src_" in answer, answer[:200])
    check("no hallucinated citation", "src_99" not in answer, answer[:200])


# ── authority + freshness composite ──────────────────────────────────────────


def test_authority_scores() -> None:
    print("\n[sieve] domain authority ranking")
    from engine.context_sieve import authority_score

    check("github is primary", authority_score("https://github.com/a/b") == 0.95)
    check("apple developer docs are primary", authority_score("https://developer.apple.com/x") == 0.95)
    check("unknown domain is neutral", authority_score("https://randomblog.example/x") == 0.50)
    check("aggregators are demoted", authority_score("https://medium.com/@a/b") == 0.35)
    check("edu is institutional", authority_score("https://mit.edu/x") == 0.75)
    check("empty url is safe", authority_score("") == 0.40)


def test_composite_score() -> None:
    print("\n[sieve] composite blends relevance, authority and freshness")
    sieve = ContextSieve()
    primary = "The latest ScreenCaptureKit release notes for version 15.4 confirm the memory leak fix shipped."
    spam = "Buy cheap SEO backlinks now, best ranking service, unlimited traffic guaranteed."
    docs = [
        {"url": "https://developer.apple.com/notes", "title": "notes", "text": primary + " " * 20},
        {"url": "https://seoblog.example/promo", "title": "promo", "text": spam + " " * 20},
    ]
    result = sieve.sieve_node("q1", "ScreenCaptureKit 15.4 release notes fix", docs)
    check("composite is computed", result.peak_composite > 0, str(result))
    check("composite stays on a 0..1 scale", result.peak_composite <= 1.0, str(result.peak_composite))
    check(
        "the authoritative source outranks the promo",
        result.chunks[0]["url"].endswith("developer.apple.com/notes"),
        str([chunk["url"] for chunk in result.chunks]),
    )


def test_freshness_score() -> None:
    print("\n[sieve] freshness reacts to time-sensitive language")
    from engine.context_sieve import freshness_score

    fresh = freshness_score("The latest update fixed it in version 15.4, released this week.")
    stale = freshness_score("This was archived and deprecated in 2019, end-of-life since then.")
    check("current language scores higher", fresh > stale, f"{fresh} vs {stale}")
    check("freshness stays in range", 0.0 <= fresh <= 1.0 and 0.0 <= stale <= 1.0)


# ── multi-wave planning ──────────────────────────────────────────────────────


async def test_wave_two_followup() -> None:
    print("\n[planner] wave 2 interpolates wave 1 findings")
    planner = DAGPlanner(LLMClient())
    wave_one = [
        DAGNode(id="q1", query="macOS 15.4 ScreenCaptureKit memory leak status", wave=1),
        DAGNode(id="q2", query="ScreenCaptureKit memory leak workaround discussion", wave=1),
    ]
    chunks = [
        {
            "text": "macOS 15.4 beta 3 ships ScreenCaptureKit version 15.4 fix release notes "
            + "the leak was patched in 15.4. " * 3,
            "url": "https://developer.apple.com/news/releases/",
            "domain": "developer.apple.com",
        }
    ]
    followup = await planner.build_followup(
        "Is the ScreenCaptureKit memory leak fixed?", wave_one, chunks
    )
    check("a wave 2 node is produced", followup is not None, "None")
    if followup is not None:
        check("wave 2 is tagged wave 2", followup.wave == 2, str(followup))
        check("wave 2 depends on wave 1", set(followup.depends_on) == {"q1", "q2"}, str(followup))
        check("wave 2 interpolates the version", "15.4" in followup.query, followup.query)


async def test_ambient_sensor() -> None:
    print("\n[ambient] OS sensor degrades safely")
    from engine.ambient import AmbientSensor, extract_terms, fold_into_query

    probe = AmbientSensor()
    context = await probe.detect()
    check("detection never raises", context is not None)
    check("context has a source", context.source in {"none", "manual", "macos", "linux"}, context.source)

    manual = await probe.detect("VS Code — screen_capture_manager.swift")
    check("manual override wins", manual.app.startswith("VS Code"), manual.app)
    check("manual override is marked available", manual.available is True)

    terms = extract_terms(manual)
    check("terms are extracted from the title", any("screen_capture" in term for term in terms), str(terms))

    folded = fold_into_query("macOS memory leak status", terms)
    check("terms fold into the query", "screen_capture" in folded, folded)
    check("folded query stays bounded", len(folded) <= 600, str(len(folded)))


async def test_auto_verification() -> None:
    print("\n[promises] outbound activity suppresses the nudge")
    await db.init_db()
    daemon = PromiseDaemon(LLMClient())

    created = await db.create_promise(
        {
            "id": "pm_test_verify",
            "actor": "You",
            "recipient": "Rahul",
            "promised_action": "push the ScreenCaptureKit hotfix PR",
            "trigger_condition": "Apple 15.4 Beta 3 patches the leak",
            "watch_url": "https://developer.apple.com/macos-release-notes",
            "last_dom_hash": daemon._unobserved_hash("pm_test_verify"),
            "priority": 4,
            "time_sensitivity": 4,
            "status": "WATCHING",
            "draft_artifact": None,
            "trigger_summary": None,
            "created_at": 0,
        }
    )
    # Without any outbound activity the gate behaves normally.
    gate = await daemon.evaluate_nudge_gate(created, 1)
    check("no activity means a normal nudge", gate["auto_verified"] is False, str(gate))

    await db.log_outbound_activity(
        "Pushed commit fixing ScreenCaptureKit and messaged Rahul about the PR", kind="commit"
    )
    verified = await daemon.evaluate_nudge_gate(created, 1)
    check("outbound activity auto-verifies", verified["auto_verified"] is True, str(verified))
    check("auto-verified promises release no nudge", verified["nudge"] is None, str(verified))
    check(
        "the promise is closed silently",
        verified["promise"]["status"] == "AUTO_VERIFIED_SILENT",
        verified["promise"]["status"],
    )
    check(
        "a verification note explains the silence",
        bool(verified["promise"]["verification_note"]),
        str(verified["promise"].get("verification_note")),
    )


async def main() -> int:
    await test_cache_volatility_isolation()
    await test_cache_purge()
    await test_promise_column_guard()
    test_sieve_diversity()
    test_sieve_no_evidence()
    test_sieve_weak_evidence()
    test_planner_deterministic()
    test_planner_rejects_cycles()
    test_clean_for_search()
    test_extract_json()
    test_urgency_formula()
    await test_gate_and_duplicate()
    await test_extractive_synthesis()
    test_authority_scores()
    test_composite_score()
    test_freshness_score()
    await test_wave_two_followup()
    await test_ambient_sensor()
    await test_auto_verification()

    print(f"\n{'=' * 60}")
    print(f"passed: {len(PASSED)}   failed: {len(FAILED)}")
    for failure in FAILED:
        print(f"  ✗ {failure}")
    return 1 if FAILED else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
