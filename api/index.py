from copy import deepcopy

from backend.app.main import app as fastapi_app


def _normalize_path(path: str) -> str:
    normalized = path or "/"

    if normalized.startswith("/api/index.py"):
        normalized = normalized[len("/api/index.py") :] or "/"
    if normalized.startswith("/api"):
        normalized = normalized[len("/api") :] or "/"

    return normalized if normalized.startswith("/") else f"/{normalized}"


async def app(scope, receive, send):
    normalized_scope = deepcopy(scope)
    normalized_scope["path"] = _normalize_path(normalized_scope.get("path", "/"))
    await fastapi_app(normalized_scope, receive, send)
