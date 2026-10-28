#!/usr/bin/env python3
"""Cloudflare Access verification for the dashboard's public hostname.

The optional public origin is a Cloudflare Tunnel hostname with an Access
application in front of it. cloudflared validates the Access token at the edge,
but the dashboard still verifies the signed JWT itself: a proxy listener is
reachable by other local containers, so any of them could otherwise hand-craft
`Cf-Access-Authenticated-User-Email`. Only a JWT signed by the configured
team's published keys counts as an identity.

Nothing here is used for the loopback/SSH path, which keeps the existing
capability-token model. Both the team domain and the audience must be supplied
by the operator; there is no built-in tenant or audience.
"""

from __future__ import annotations

import threading
import time
from typing import Any

CERTS_PATH = "/cdn-cgi/access/certs"
ISSUER = "https://{team}"


class AccessVerifier:
    """Verify `Cf-Access-Jwt-Assertion` against the team's JWKS."""

    def __init__(self, team_domain: str, audience: str, timeout: float = 5.0) -> None:
        self.team = team_domain.strip().removeprefix("https://").strip("/")
        self.audience = audience.strip()
        self.timeout = timeout
        self._client: Any = None
        self._lock = threading.Lock()
        self._last_error: str | None = None
        self._checked_at: float = 0.0

    # -- diagnostics -------------------------------------------------------

    @property
    def enabled(self) -> bool:
        return bool(self.team and self.audience)

    def status(self) -> dict:
        return {"enabled": self.enabled, "team": self.team, "audience_configured": bool(self.audience),
                "last_error": self._last_error, "checked_at": int(self._checked_at) or None}

    # -- verification ------------------------------------------------------

    def _jwks(self):
        if self._client is not None:
            return self._client
        with self._lock:
            if self._client is not None:
                return self._client
            import jwt  # imported lazily: the dashboard runs without it on the loopback path

            self._client = jwt.PyJWKClient(
                f"https://{self.team}{CERTS_PATH}",
                cache_keys=True,
                lifespan=3600,
                timeout=self.timeout,
            )
            return self._client

    def identity(self, assertion: str | None) -> dict | None:
        """Return {'email': ..., 'sub': ...} for a valid token, else None."""
        if not self.enabled or not assertion:
            return None
        self._checked_at = time.time()
        try:
            import jwt  # noqa: PLC0415 - optional dependency, see _jwks

            key = self._jwks().get_signing_key_from_jwt(assertion)
            claims = jwt.decode(
                assertion,
                key.key,
                algorithms=["RS256", "ES256"],
                audience=self.audience,
                issuer=ISSUER.format(team=self.team),
                options={"require": ["exp", "iat", "aud", "iss"]},
            )
        except Exception as exc:  # noqa: BLE001 - any failure means "not authenticated"
            self._last_error = f"{type(exc).__name__}: {str(exc)[:160]}"
            return None
        self._last_error = None
        email = claims.get("email") or ""
        return {"email": email, "sub": claims.get("sub"), "aud": claims.get("aud")}
