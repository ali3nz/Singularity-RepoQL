"""Authenticated same-origin reverse proxy for Tencent's UNMODIFIED MemoryPanel UI.

No Tencent secret is sourced from server config: individual user identity is
provided through the panel's own x-tdai-* headers and enforced upstream.
"""
from __future__ import annotations
import json
import os
from http import HTTPStatus
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError, URLError

MAX_RESPONSE=4*1024*1024
MAX_REQUEST=512*1024

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def target_for(path):
    if path.startswith('/api/v1/'):
        raw=os.environ.get('TENCENT_PANEL_BASE','')
    elif path.startswith('/v3/'):
        raw=os.environ.get('TENCENT_SKILL_GATEWAY_BASE','')
    else:
        raise FileNotFoundError('not an approved Tencent panel API route')
    parsed=urlsplit(raw)
    if parsed.scheme!='http' or parsed.hostname not in ('127.0.0.1','localhost','::1') or not parsed.port or parsed.path not in ('','/') or parsed.username or parsed.password:
        raise PermissionError('Tencent upstream must be configured on local loopback')
    return raw.rstrip('/')


def serve_proxy(handler,method,parsed):
    if method not in ('GET','POST'):
        raise PermissionError('Tencent panel method unsupported')
    if any(x in parsed.path for x in ('..','\\','%')):
        raise ValueError('invalid Tencent path')
    base=target_for(parsed.path)
    length=int(handler.headers.get('Content-Length') or 0)
    if length<0 or length>MAX_REQUEST:raise ValueError('Tencent request too large')
    body=handler.rfile.read(length) if method=='POST' else None
    headers={'Accept':'application/json','Content-Type':'application/json'}
    for key in ('x-tdai-service-id','x-tdai-user-key','x-request-id'):
        value=handler.headers.get(key)
        if value:
            if len(value)>4096 or '\r' in value or '\n' in value:raise ValueError('invalid auth header')
            headers[key]=value
    url=base+parsed.path+('?' + parsed.query if parsed.query else '')
    request=Request(url,method=method,data=body,headers=headers)
    try:
        with build_opener(NoRedirect()).open(request,timeout=25) as response:
            code=response.status;content=response.read(MAX_RESPONSE+1)
    except HTTPError as exc:
        code=exc.code;content=exc.read(MAX_RESPONSE+1)
    except (URLError,TimeoutError,OSError):
        handler.send_json(HTTPStatus.BAD_GATEWAY,{'error':'tencent_upstream_unavailable'});return
    if len(content)>MAX_RESPONSE:raise ValueError('Tencent response too large')
    handler.send_response(code)
    handler.send_header('Content-Type','application/json; charset=utf-8')
    handler.send_header('Cache-Control','no-store')
    handler.send_header('X-Content-Type-Options','nosniff')
    handler.send_header('Content-Length',str(len(content)))
    handler.end_headers();handler.wfile.write(content)
