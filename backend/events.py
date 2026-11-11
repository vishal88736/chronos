"""In-process pub/sub primitives for the promise daemon and the SSE firehose.

The daemon runs out-of-band from the chat request. It publishes nudge events to
every connected telemetry client through lightweight asyncio queues. A bounded
queue protects the server from a slow browser without blocking the daemon.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

logger = logging.getLogger("chronos.events")


class EventBroker:
    """Fan-out broker with one bounded queue per connected SSE client.

    Subscription bookkeeping is deliberately lock-free. Every mutation happens
    inside a single event-loop step with no `await` in between, so it is
    already atomic — and a lock would make `unsubscribe` a cancellation point,
    which is exactly where it runs when a browser tab closes mid-stream.
    """

    def __init__(self, queue_size: int = 64) -> None:
        self._subscribers: set[asyncio.Queue[dict[str, Any]]] = set()
        self._queue_size = queue_size

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)

    async def subscribe(self) -> asyncio.Queue[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=self._queue_size)
        self._subscribers.add(queue)
        logger.debug("nudge subscriber connected (%d total)", len(self._subscribers))
        return queue

    async def unsubscribe(self, queue: asyncio.Queue[dict[str, Any]]) -> None:
        self._subscribers.discard(queue)
        logger.debug("nudge subscriber disconnected (%d total)", len(self._subscribers))

    async def publish(self, event: dict[str, Any]) -> None:
        """Deliver without ever blocking the producer.

        If a client's queue is full, its oldest event is discarded. The latest
        state is more useful than a stale backlog for an ambient UI.
        """
        for queue in list(self._subscribers):
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                try:
                    queue.get_nowait()
                    queue.put_nowait(event)
                except (asyncio.QueueEmpty, asyncio.QueueFull):
                    logger.warning("dropping event for saturated SSE subscriber")


class RuntimeState:
    """Small amount of process-local state shared by API and daemon."""

    def __init__(self) -> None:
        self.focus_level: int = 5
        self.started_at: int = 0


broker = EventBroker()
runtime = RuntimeState()
