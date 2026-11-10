"""Dashboard-session embeds for the existing Tencent and Office applications.

Backend keys stay server-side. Each fixed upstream is reachable only after an
authenticated handshake; cookie-authenticated writes and WS handshakes also
require the dashboard Origin. No arbitrary upstream URLs are accepted.
"""
import http.client
import json
import os
from pathlib import Path
import re
import select
import socket
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit, urljoin, parse_qsl

from repoql_native_auth import COOKIE_NAME, create_launch_cookie, valid_launch_cookie


def _upstream(kind, default_port):
    """Fixed loopback upstream; only these three names exist, never a URL from a request."""
    prefix = 'SINGULARITY_' + kind.upper() + '_HOST'
    port_key = 'SINGULARITY_' + kind.upper() + '_PORT'
    host = os.environ.get(prefix, '127.0.0.1').strip()
    try:
        port = int(os.environ.get(port_key, default_port))
    except (TypeError, ValueError):
        port = default_port
    if not 1 <= port <= 65535:
        raise ValueError('invalid fixed panel port')
    if os.environ.get('SINGULARITY_WINDOWS_NATIVE') == '1' and host.lower() not in ('localhost', '127.0.0.1', '::1'):
        # A public dashboard must never proxy an arbitrary network host with
        # its private credentials. Fix configuration before starting a panel.
        raise ValueError('native Windows panel upstream must be loopback')
    return (host, port)


UPSTREAM = {'tencent': _upstream('tencent', 18126 if os.environ.get('SINGULARITY_WINDOWS_NATIVE') == '1' else 8125), 'office': _upstream('office', 8001),
            'kanzo': _upstream('kanzo', 4242)}
MAX_BODY = 8 * 1024 * 1024


def prefix(kind):
    if kind not in UPSTREAM:
        raise FileNotFoundError('unknown panel')
    return '/embed/' + kind


def upstream_path(kind, path):
    base = prefix(kind)
    rest = path[len(base):] if path.startswith(base + '/') else ''
    if not rest.startswith('/') or any(c in rest for c in ('..', '\\', '%', '\r', '\n')) or len(rest) > 4096:
        raise PermissionError('invalid panel path')
    return rest


def backend_key(kind):
    if kind == 'office':
        if os.environ.get('SINGULARITY_WINDOWS_NATIVE') == '1':
            mode = os.environ.get('SINGULARITY_OFFICE_NATIVE_AUTH_MODE', 'legacy_url').strip()
            if mode in ('key_file', 'service_keys'):
                # The installers restrict these files to the owner/service.
                key_file = os.environ.get('SINGULARITY_OFFICE_PANEL_KEY_FILE', '').strip()
                if not key_file:
                    raise PermissionError('panel credential unavailable')
                try:
                    raw = Path(key_file).read_text(encoding='utf-8-sig')
                    key = json.loads(raw)['apiKey'] if mode == 'service_keys' else raw.strip()
                except (OSError, UnicodeError, ValueError, TypeError, KeyError):
                    raise PermissionError('panel credential unavailable') from None
            elif mode == 'legacy_url':
                # Production-compatible default. Token stays server-side.
                # The token is extracted server-side; never redirect the
                # browser to the original capability-bearing URL.
                from office_bridge import validated_legacy_embed_token
                key = validated_legacy_embed_token() or ''
            else:
                raise PermissionError('unsupported Office authentication mode')
        else:
            # Preserve the old Linux configuration and authenticated proxy.
            key = parse_qs(urlsplit(os.environ.get('SINGULARITY_OFFICE_EMBED_URL',
                os.environ.get('CLAUDE_OFFICE_EMBED_URL', ''))).query).get('token', [''])[0]
    else:
        key_file = os.environ.get('SINGULARITY_TENCENT_OWNER_KEY_FILE',
                                  os.environ.get('TENCENT_OWNER_KEY_FILE', '')).strip()
        if not key_file:
            raise PermissionError('panel credential unavailable')
        key = Path(key_file).read_text().strip()
    if not isinstance(key, str) or not key or len(key) > 4096 or '\r' in key or '\n' in key:
        raise PermissionError('panel credential unavailable')
    return key


def authenticated(handler, kind):
    return handler.authorized() or valid_launch_cookie(handler.headers.get('Cookie', ''), handler.app.token, max_age=3600, audience=kind)


def handshake(handler, kind):
    prefix(kind)
    if kind != 'kanzo':
        try:
            backend_key(kind)  # fail before issuing a cookie if configuration is absent
        except (OSError, PermissionError):
            handler.send_json(503, {'error': kind + '_panel_unconfigured'})
            return
    if kind == 'tencent':
        # A present key file is not proof that the owner is valid. Verify the
        # genuine local identity before granting a browser navigation cookie.
        try:
            tencent_session()
        except (OSError, ValueError, PermissionError, json.JSONDecodeError):
            handler.send_json(503, {'error': 'tencent_owner_session_unavailable'})
            return
    if kind == 'kanzo':
        # Kanzo has no built-in user authentication. Prove it is the expected
        # loopback service before granting a dashboard-scoped browser session.
        try:
            conn = http.client.HTTPConnection(*UPSTREAM['kanzo'], timeout=3)
            try:
                conn.request('GET', '/api/ping')
                response = conn.getresponse()
                ready = response.status == 200 and response.read(64) == b'kanzo'
            finally:
                conn.close()
        except OSError:
            ready = False
        if not ready:
            handler.send_json(503, {'error': 'local_kanzo_unavailable'})
            return
    cookie = create_launch_cookie(handler.app.token, audience=kind)
    secure = '; Secure' if handler.access_identity() is not None or handler.request_is_https() else ''
    body = b'{"ready":true}'
    handler.send_response(200)
    handler.send_header('Content-Type', 'application/json')
    handler.send_header('Cache-Control', 'no-store')
    handler.send_header('Set-Cookie', f'{COOKIE_NAME}={cookie}; HttpOnly; SameSite=Strict; Path={prefix(kind)}/; Max-Age=3600{secure}')
    handler.send_header('Content-Length', str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def transport(kind):
    # Fixed same-origin routing only. No credentials or auth material in JS.
    return ("""(()=>{const prefix=PREFIX;
      const remap=(raw)=>{const u=new URL(raw,location.href);
        if(u.host!==location.host&&['127.0.0.1','localhost','[::1]'].includes(u.hostname)){u.protocol=u.protocol.startsWith('ws')?(location.protocol==='https:'?'wss:':'ws:'):location.protocol;u.host=location.host;}
        if(u.host===location.host&&['http:','https:','ws:','wss:'].includes(u.protocol)&&!u.pathname.startsWith(prefix+'/'))u.pathname=prefix+u.pathname;
        return u.href;};
      const original=window.fetch.bind(window);
      window.fetch=(input,options)=>original(input instanceof Request?new Request(remap(input.url),input):remap(input),options);
      const WS=window.WebSocket;window.WebSocket=class extends WS{constructor(url,protocols){super(remap(url),protocols)}};
    })();""").replace('PREFIX', json.dumps(prefix(kind))).encode()


def rewrite(kind, text, content_type):
    base = prefix(kind)
    text = re.sub(r'([\"\x27`(=])(/(?:assets/|sprites/|_next/|logo\.png|app\.js|images/|favicon\.ico|downloads/))',
                  lambda m: m[1] + base + m[2], text)
    if 'text/html' in content_type:
        text = text.replace('<head>', '<head><script src="' + base + '/_transport.js"></script>', 1)
    return text



def _panel_redirect(kind, current_path, location, *, public_root=False):
    """Translate an upstream redirect onto the already authenticated origin.

    Never send an Office capability-bearing URL, a remote origin, a network-path
    redirect, or an upstream loopback URL to the browser. Backend credentials
    stay exclusively in the dashboard-to-service request headers.
    """
    if not isinstance(location, str) or not location or len(location) > 4096 or any(c in location for c in ('\r', '\n', '\x00', '\\')):
        raise PermissionError('unsafe panel redirect')
    dest = urlsplit(location)
    if dest.fragment or dest.username or dest.password:
        raise PermissionError('unsafe panel redirect')
    if dest.scheme or dest.netloc:
        # Backend-generated absolute redirects may refer to its own fixed
        # listener, but never to any other host/port (including LAN hosts).
        upstream_host, upstream_port = UPSTREAM[kind]
        if dest.scheme != 'http' or dest.hostname != upstream_host or dest.port != upstream_port:
            raise PermissionError('remote panel redirect refused')
    if not dest.path and not dest.query:
        raise PermissionError('empty panel redirect')
    if any(segment in ('.', '..') for segment in dest.path.split('/')) or '%' in dest.path:
        raise PermissionError('unsafe panel redirect path')
    target = urljoin(current_path, dest.path) if dest.path else current_path
    if not target.startswith('/') or target.startswith('//') or any(c in target for c in ('\\', '\r', '\n')):
        raise PermissionError('unsafe panel redirect path')
    # Never expose any upstream credentials included in a Location query.
    sensitive = {'token', 'key', 'api_key', 'access_token', 'secret', 'password', 'authorization'}
    query = parse_qsl(dest.query, keep_blank_values=True)
    if any(key.lower() in sensitive for key, _ in query):
        query = [(key, value) for key, value in query if key.lower() not in sensitive]
    browser_path = target if public_root else prefix(kind) + target
    return urlunsplit(('', '', browser_path, urlencode(query), ''))

def tencent_service_id():
    service_id = os.environ.get('SINGULARITY_TENCENT_SERVICE_ID', 'default').strip()
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', service_id):
        raise PermissionError('Tencent instance configuration invalid')
    return service_id


def tencent_session():
    """Verify the real configured user, returning only public session fields."""
    conn = http.client.HTTPConnection(*UPSTREAM['tencent'], timeout=15)
    try:
        conn.request('POST', '/api/v1/meta/auth/verify',
            body=json.dumps({'user_key': backend_key('tencent')}),
            headers={'Content-Type': 'application/json', 'X-Tdai-Service-Id': tencent_service_id()})
        response = conn.getresponse()
        raw = response.read(1024 * 1024 + 1)
        if response.status != 200 or len(raw) > 1024 * 1024:
            raise PermissionError('Tencent verification failed')
        data = json.loads(raw)
        if not isinstance(data, dict) or not isinstance(data.get('data'), dict):
            raise PermissionError('Tencent verification response invalid')
        verified = data['data']
        if data.get('code') != 0 or verified.get('valid') is not True or not isinstance(verified.get('user'), dict):
            raise PermissionError('Tencent credential invalid')
        user = {k: v for k, v in verified['user'].items()
                if k in ('user_id', 'username', 'display_name', 'user_type', 'created_at')}
        return {'authenticated': True, 'instance_id': tencent_service_id(), 'user': user}
    finally:
        conn.close()


def serve(handler, kind, method, parsed, *, public_root=False):
    if public_root:
        # A dashboard bearer/cookie or a spoofed email cannot authorize this host.
        if kind != 'office' or handler.office_access_identity() is None:
            handler.send_json(401, {'error': 'office_access_required'})
            return
        path = upstream_path(kind, prefix(kind) + parsed.path)
        if path == '/' and method in ('GET', 'HEAD'):
            # Match the Homepage embed without putting the backend key in a URL.
            params = parse_qs(parsed.query)
            query = [('embed', '1')]
            room = params.get('room', [''])[0]
            if room in ('modern', 'dm'):
                query.append(('room', room))
            canonical = urlencode(query)
            if parsed.query != canonical:
                handler.send_response(302)
                handler.send_header('Location', '/?' + canonical)
                handler.send_header('Cache-Control', 'no-store')
                handler.send_header('Content-Length', '0')
                handler.end_headers()
                return
    else:
        if not authenticated(handler, kind):
            handler.send_json(401, {'error': 'dashboard_session_required'})
            return
        path = upstream_path(kind, parsed.path)
    if kind == 'kanzo' and (path == '/mcp' or path.startswith('/mcp/')):
        # Agents use Kanzo's host-local MCP endpoint, not a cookie-authenticated
        # browser proxy. Never publish the unauthenticated MCP surface here.
        handler.send_json(403, {'error': 'kanzo_mcp_is_local_only'})
        return
    is_ws = handler.headers.get('Upgrade', '').lower() == 'websocket'
    if is_ws or method not in ('GET', 'HEAD'):
        if not handler.request_origin_allowed(require_origin=public_root or not handler.bearer_authorized()):
            handler.send_json(403, {'error': 'cross_origin_refused'})
            return
    if is_ws:
        if kind != 'office' or not path.startswith('/ws/'):
            handler.send_json(403, {'error': 'websocket_path_refused'})
            return
        websocket(handler, kind, path)
        return
    if method not in ('GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'):
        raise PermissionError('unsupported panel method')
    redirect_location = None
    if path == '/_transport.js' and not public_root:
        content, code, content_type = transport(kind), 200, 'text/javascript; charset=utf-8'
    elif kind == 'tencent' and path == '/api/v1/auth/session' and method == 'GET':
        content, code, content_type = json.dumps(tencent_session()).encode(), 200, 'application/json'
    else:
        length = int(handler.headers.get('Content-Length') or 0)
        body_limit = 27 * 1024 * 1024 if kind == 'kanzo' else MAX_BODY
        if length < 0 or length > body_limit:
            raise ValueError('panel request too large')
        body = handler.rfile.read(length) if length else None
        headers = {'Accept-Encoding': 'identity', 'Content-Type': handler.headers.get('Content-Type', 'application/json')}
        if kind == 'office':
            headers['X-API-Key'] = backend_key(kind)
        elif kind == 'kanzo':
            # Kanzo's DNS rebinding/origin guard expects its own loopback host.
            # Incoming browser writes were verified against the public dashboard
            # origin above; only then is Origin rewritten for the fixed upstream.
            if method not in ('GET', 'HEAD'):
                # Use the configured upstream port: an RC board listens on its own
                # RC port, and a hard-coded production port would make every
                # write fail its origin check.
                headers['Origin'] = 'http://127.0.0.1:%d' % _upstream('kanzo', 4242)[1]
        else:
            headers['X-Tdai-Service-Id'] = tencent_service_id()
            headers['X-Tdai-User-Key'] = backend_key(kind)
            # The Panel's meta routes need a body identity as well as headers.
            # Never let a supplied identity override the dashboard owner.
            if path.startswith('/api/v1/meta/') and body:
                data = json.loads(body)
                if not isinstance(data, dict):
                    raise ValueError('expected JSON object')
                data.pop('user_id', None)
                data['user_key'] = backend_key(kind)
                body = json.dumps(data).encode()
        conn = http.client.HTTPConnection(*UPSTREAM[kind], timeout=30)
        try:
            conn.request(method, path + ('?' + parsed.query if parsed.query else ''), body=body, headers=headers)
            response = conn.getresponse()
            limit = 27 * 1024 * 1024 if kind == 'kanzo' else MAX_BODY
            content = response.read(limit + 1)
            if len(content) > limit:
                raise ValueError('panel response too large')
            code = response.status
            if code in (301, 302, 303, 307, 308):
                try:
                    redirect_location = _panel_redirect(kind, path, response.getheader('Location'), public_root=public_root)
                    # Upstream redirect bodies sometimes echo the original URL
                    # (including its capability token). Never relay that body.
                    content = b''
                except (PermissionError, ValueError):
                    code = 502
                    content = b'{"error":"upstream_redirect_refused"}'
                    content_type = 'application/json'
            content_type = 'application/json' if code == 502 else (response.getheader('Content-Type') or 'application/octet-stream')
            if not public_root and any(t in content_type for t in ('text/html', 'javascript', 'text/css')):
                content = rewrite(kind, content.decode('utf-8', 'replace'), content_type).encode()
        finally:
            conn.close()
    handler.send_response(code)
    handler.send_header('Content-Type', content_type)
    if redirect_location is not None and code in (301, 302, 303, 307, 308):
        handler.send_header('Location', redirect_location)
    handler.send_header('Cache-Control', 'no-store')
    handler.send_header('Referrer-Policy', 'no-referrer')
    handler.send_header('X-Content-Type-Options', 'nosniff')
    if kind == 'kanzo':
        # Preserve Kanzo's restrictive CSP while allowing same-origin dashboard
        # framing. Its upstream policy forbids all frames and cannot be copied.
        handler.send_header('Content-Security-Policy',
            "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; connect-src 'self'; base-uri 'none'; "
            "form-action 'none'; frame-ancestors 'self'")
    handler.send_header('Content-Length', str(len(content)))
    handler.end_headers()
    if method != 'HEAD':
        handler.wfile.write(content)


def websocket(handler, kind, path):
    upstream = None
    try:
        lines = [f'GET {path} HTTP/1.1', 'Host: %s:%d' % UPSTREAM[kind],
                 'Connection: Upgrade', 'Upgrade: websocket', 'X-API-Key: ' + backend_key(kind)]
        for key in ('Sec-WebSocket-Key', 'Sec-WebSocket-Version', 'Sec-WebSocket-Protocol', 'Sec-WebSocket-Extensions'):
            value = handler.headers.get(key)
            if value:
                lines.append(key + ': ' + value)
        upstream = socket.create_connection(UPSTREAM[kind], timeout=10)
        upstream.sendall(('\r\n'.join(lines) + '\r\n\r\n').encode('latin-1'))
        handler.connection.settimeout(None)
        upstream.settimeout(None)
        while True:
            ready, _, _ = select.select([handler.connection, upstream], [], [], 300)
            if not ready:
                return
            for source in ready:
                data = source.recv(65536)
                if not data:
                    return
                target = upstream if source is handler.connection else handler.connection
                target.sendall(data)
    finally:
        if upstream is not None:
            upstream.close()
        handler.close_connection = True


# Root-absolute art the Office client loads outside its embed base path.
# The Pixi texture loader issues /sprites/... and /rooms/... directly; inside the
# /embed/office/ iframe those resolve against the dashboard origin and hit its SPA
# fallback (index.html), so every texture fails and the rendered agents vanish.
# The Office already serves these images unauthenticated; proxy them unchanged.
STATIC_PREFIXES = ('/sprites/', '/rooms/')
MAX_ASSET = 8 * 1024 * 1024


def static_asset(handler, method, parsed):
    """Serve the Office art that escapes the /embed/office/ prefix."""
    if method not in ('GET', 'HEAD'):
        handler.send_json(405, {'error': 'method_not_allowed'})
        return
    path = parsed.path
    if (not path.startswith(STATIC_PREFIXES) or len(path) > 4096
            or any(c in path for c in ('..', '\\', '%', '\r', '\n'))):
        raise PermissionError('invalid asset path')
    conn = http.client.HTTPConnection(*UPSTREAM['office'], timeout=30)
    try:
        conn.request('GET', path + ('?' + parsed.query if parsed.query else ''),
                     headers={'Accept-Encoding': 'identity'})
        response = conn.getresponse()
        content = response.read(MAX_ASSET + 1)
        code = response.status
        content_type = response.getheader('Content-Type') or 'application/octet-stream'
    finally:
        conn.close()
    if len(content) > MAX_ASSET:
        raise ValueError('asset too large')
    handler.send_response(code)
    handler.send_header('Content-Type', content_type)
    handler.send_header('Cache-Control', 'private, max-age=300')
    handler.send_header('X-Content-Type-Options', 'nosniff')
    handler.send_header('Content-Length', str(len(content)))
    handler.end_headers()
    if method != 'HEAD':
        handler.wfile.write(content)
