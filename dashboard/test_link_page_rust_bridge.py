"""Dashboard link read projection tests; mocked child is not compiled Rust proof."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from link_page_projection import page_links
from server import Handler, COLLECTIONS

ROWS = [
    {"source_name":"Alpha", "target_name":"Beta", "source_category":"rule", "target_category":"wisdom"},
    {"source_name":"Gamma", "target_name":"Alpha", "source_category":"knowledge", "target_category":"wisdom"},
    {"source_name":"Delta", "target_name":"Other", "source_category":"rule", "target_category":"rule"},
]


class LinkPageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.bin = Path(self.tmp.name) / 'native.exe'
        self.bin.write_bytes(b'fixture')

    def test_reference_filtering_and_page(self):
        result = page_links(ROWS, 1, 1, query='alpha', target_category='wisdom', rust_bin='')
        self.assertEqual(result, {'total':2,'rows':ROWS[:1]})
        result = page_links(ROWS, 2, 1, query='alpha', rust_bin='')
        self.assertEqual(result, {'total':2,'rows':ROWS[1:2]})
        self.assertEqual(page_links(ROWS, 5, 2, rust_bin=''), {'total':3,'rows':[]})

    def test_opt_in_sends_only_match_bits(self):
        fake = Mock(return_value=subprocess.CompletedProcess([],0,json.dumps({'total':2,'indices':[0,1]}),''))
        with patch.dict(os.environ, {'PRIVATE_API_KEY':'SECRET','SINGULARITY_DASHBOARD_LINK_PAGE_RUST_BINARY':str(self.bin)}):
            result = page_links(ROWS, 1, 2, query='alpha', runner=fake)
        self.assertEqual(result, {'total':2,'rows':ROWS[:2]})
        args, opts = fake.call_args
        self.assertEqual(args, ([str(self.bin)],))
        self.assertEqual(opts['timeout'],8)
        self.assertFalse(opts['shell'])
        self.assertNotIn('PRIVATE_API_KEY',opts['env'])
        request = json.loads(opts['input'])
        self.assertEqual(request['matches'], [True, True, False])
        for text in ('Alpha','Gamma','Beta','SECRET','source_name','query'):
            self.assertNotIn(text,opts['input'])

    def test_forged_result_or_child_error_refused(self):
        for output, code in [('{"total":2,"indices":[1,0]}',0),
                             ('{"total":1,"indices":[0]}',0),
                             ('{"total":2,"indices":[0,"1"]}',0),('not-json',0),('',2)]:
            with self.subTest(output=output,code=code):
                fake=Mock(return_value=subprocess.CompletedProcess([],code,output,''))
                with self.assertRaisesRegex(RuntimeError, 'link_page_native_'):
                    page_links(ROWS,1,2,query='alpha',rust_bin=self.bin,runner=fake)

    def test_bounds_and_symlinks(self):
        with self.assertRaisesRegex(ValueError,'invalid_link_paging'):
            page_links(ROWS,0,2,rust_bin='')
        with self.assertRaisesRegex(RuntimeError,'binary_invalid'):
            page_links(ROWS,1,2,rust_bin='relative.exe')
        with self.assertRaisesRegex(RuntimeError,'input_too_large'):
            page_links(ROWS*20000,1,2,rust_bin=self.bin)
        link=self.bin.parent/'link.exe'
        try: link.symlink_to(self.bin)
        except OSError: return
        with self.assertRaisesRegex(RuntimeError,'binary_invalid'):
            page_links(ROWS,1,2,rust_bin=link)

    def test_handler_see_also_reuses_python_authorization_boundary(self):
        handler=object.__new__(Handler)
        handler.app=SimpleNamespace(see_also_links=lambda:list(ROWS))
        handler.link_collection_counts=lambda: {'see_also':3}
        result=handler.links({'collection':'see_also','q':'alpha','page':'2','page_size':'1','counts':'false'})
        self.assertEqual(result['total'],2)
        self.assertEqual(result['rows'],ROWS[1:2])
        self.assertEqual(result['counts'],{})
        self.assertEqual(result['description'],COLLECTIONS['see_also'])

if __name__=='__main__': unittest.main()
