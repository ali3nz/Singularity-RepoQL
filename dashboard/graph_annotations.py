"""Dashboard-local visual labels and notes, not RepoQL/Tencent memory mutations.

All writes are called only after server.py's existing identity, same-origin and
custom-header checks. JSON file is protected by a fixed-name advisory flock.
"""
from __future__ import annotations
from file_lock import fcntl
import json
import os
import re
import tempfile
from pathlib import Path

DEFAULT = Path(__file__).resolve().parent / 'state' / 'graph-annotations.json'
MAX_RECORDS = 5000

def _path():
    return Path(os.environ.get('REPOQL_GRAPH_ANNOTATIONS_FILE', str(DEFAULT)))

def _load(path):
    try:
        value=json.loads(path.read_text(encoding='utf-8'))
    except FileNotFoundError:
        return {}
    if not isinstance(value,dict):
        raise ValueError('invalid annotations store')
    return value

def list_annotations():
    path=_path()
    if path.is_symlink(): raise PermissionError('annotation store cannot be a symlink')
    return {'annotations':_load(path),'scope':'dashboard_display_only','editable_source_records':False}

def save_annotation(body):
    if body.get('confirm')!='SAVE GRAPH ANNOTATION':
        raise PermissionError('explicit annotation confirmation required')
    key=body.get('id')
    if not isinstance(key,str) or not re.fullmatch(r'(repoql|tencent):[^\x00-\x1f]{1,500}|edge:[^\x00-\x1f]{1,500}',key):
        raise ValueError('invalid graph record id')
    version=body.get('expected_revision')
    if type(version) is not int or version<0:
        raise ValueError('expected_revision must be an integer')
    delete=body.get('delete') is True
    label=body.get('display_label','')
    notes=body.get('notes','')
    if not isinstance(label,str) or len(label)>150 or not isinstance(notes,str) or len(notes)>2500:
        raise ValueError('annotation too large')
    if any(ord(ch)<32 and ch not in '\t\n' for ch in notes+label):
        raise ValueError('invalid control characters')
    if os.name == 'nt':
        # Windows mode bits do not enforce ACLs. Do not mutate personal graph
        # annotations until Rust's Windows ACL-protected store is available.
        raise PermissionError('native Windows annotation writes require ACL-protected Rust store')
    path=_path();path.parent.mkdir(parents=True,exist_ok=True)
    if path.is_symlink():raise PermissionError('annotation store cannot be a symlink')
    lockpath=path.with_suffix('.lock')
    with open(lockpath,'a+',encoding='utf8') as lock:
        fcntl.flock(lock.fileno(),fcntl.LOCK_EX)
        rows=_load(path)
        current=rows.get(key,{});revision=current.get('revision',0)
        if revision !=version:
            raise ValueError('stale_annotation_revision_refresh_required')
        if delete:
            rows.pop(key,None);new=None
        else:
            if key not in rows and len(rows)>=MAX_RECORDS:
                raise ValueError('annotation limit reached')
            new={'display_label':label.strip(),'notes':notes.strip(),'revision':revision+1}
            rows[key]=new
        content=json.dumps(rows,sort_keys=True,ensure_ascii=False,separators=(',',':'))
        fd, name=tempfile.mkstemp(prefix='.graph-annotations-',dir=path.parent)
        try:
            os.fchmod(fd,0o600)
            with os.fdopen(fd,'w',encoding='utf8') as file:
                file.write(content);file.flush();os.fsync(file.fileno())
            os.replace(name,path)
        finally:
            if os.path.exists(name):os.unlink(name)
    return {'ok':True,'id':key,'annotation':new,'scope':'dashboard_display_only'}
