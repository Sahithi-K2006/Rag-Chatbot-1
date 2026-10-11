"""Optional shared access key and simple per-IP rate limits.

This is demo-grade protection for a single-tenant deployment, not user authentication.
"""
import secrets
import threading
import time
from collections import defaultdict, deque

from fastapi import HTTPException, Request

from .config import Settings


def api_error(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


def require_access_key(settings: Settings):
    def check(request: Request) -> None:
        expected = settings.api_access_key
        if not expected:
            return
        given = request.headers.get("x-access-key", "")
        if not secrets.compare_digest(given.encode(), expected.encode()):
            raise api_error(401, "access_denied", "An access key is required to use this KnowledgeBridge deployment.")

    return check


class RateLimiter:
    """Sliding one-minute window per client IP.
    ponytail: in-memory and per-process; use a shared store (e.g. Redis) when running several replicas."""

    def __init__(self, per_minute: int):
        self.per_minute = per_minute
        self._hits: dict[str, deque] = defaultdict(deque)
        self._lock = threading.Lock()

    def __call__(self, request: Request) -> None:
        ip = request.client.host if request.client else "unknown"
        now = time.monotonic()
        with self._lock:
            q = self._hits[ip]
            while q and now - q[0] > 60:
                q.popleft()
            if len(q) >= self.per_minute:
                raise api_error(429, "too_many_requests", "Too many requests. Please wait a minute and try again.")
            q.append(now)
