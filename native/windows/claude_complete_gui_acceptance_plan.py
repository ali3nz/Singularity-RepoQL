#!/usr/bin/env python3
"""Generate a manual, native Claude Desktop CODE TAB two-session memory test.

This only creates operator prompts; it cannot programmatically assert GUI
behavior, capture, persistence, or recall. Does not execute Claude CLI or touch
MemoryCore. Never upload the local plan or private screenshots unreviewed.
"""
from __future__ import annotations
import argparse, json, os, secrets
from pathlib import Path
import stat

SCHEMA='singularity-claude-desktop-code-tab-memory-plan/v1'


def make_plan(*,token=None,value=None):
    tag=token if token is not None else secrets.token_hex(12).upper()
    number=value if value is not None else 100+secrets.randbelow(900)
    if not isinstance(tag,str) or len(tag)!=24 or any(c not in '0123456789ABCDEF' for c in tag):
        raise ValueError('INVALID_EPHEMERAL_MARKER')
    if type(number) is not int or not 100 <= number <= 999:
        raise ValueError('INVALID_EPHEMERAL_FACT')
    label='SING-GUI-'+tag
    capture=f'In this native Claude Desktop Code-tab session, remember this harmless test fact for later: {label} has value {number}. Acknowledge only. Do not write the fact to a project file.'
    recall=f'This is a NEW native Claude Desktop Code-tab conversation. Without guessing, what three-digit value was associated with marker {label} in my earlier session? If unavailable, say you cannot recall it.'
    assert str(number) not in recall
    return {
        'schema':SCHEMA,'scope':'native-claude-desktop-code-tab-only',
        'first_session_prompt':capture,'second_fresh_session_prompt':recall,
        'operator_expected_value':number,'operator_marker':label,
        'instructions':[
          'Use the SAME authenticated native Claude Desktop account, memory integration and workspace; NOT claude CLI or a headless session.',
          'Record evidence of the first session, then start a separate NEW GUI conversation with a distinct session identity.',
          'Ask the second prompt without revealing the expected value, clipboard content or prior transcript.',
          'Independently verify the stored scoped memory record and its fresh-session recall; protect sensitive credentials and screenshots.',
          'If any step fails, mark BLOCKED. Do not infer memory capture merely from the model repeating the value in the first session.',
        ],
        'session_one_started':False,'session_two_distinct_verified':False,
        'authenticated_persistence_verified':False,'new_session_recall_verified':False,
        'automated_runtime_test_performed':False,'release_ready':False,
    }

def main(argv=None):
    p=argparse.ArgumentParser(description='New private native GUI test plan; NOT a runtime test')
    p.add_argument('--output',type=Path,required=True)
    args=p.parse_args(argv)
    output=Path(os.path.abspath(args.output))
    # Prevent following a junction or symlink into unrelated private locations.
    cursor=output.parent
    while True:
        st=cursor.lstat()
        if stat.S_ISLNK(st.st_mode) or (getattr(st,'st_file_attributes',0)&0x400):
            p.error('REPARSE_OUTPUT_PATH_REFUSED')
        if cursor==cursor.parent:break
        cursor=cursor.parent
    payload=json.dumps(make_plan(),indent=2)+'\n'
    with output.open('x',encoding='utf8') as file:
        file.write(payload)
    try:os.chmod(output,0o600)
    except OSError:pass
    # Do not echo the private fact. Report only the path the operator supplied.
    print('NATIVE_GUI_MEMORY_TEST_PLAN_CREATED_NOT_EXECUTED')
    return 0
if __name__=='__main__':raise SystemExit(main())
