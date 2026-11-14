"""Dashboard graph Rust bridge: only positions cross the native boundary."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock,patch
from graph_projection import project_graph
from server import Handler

class GraphBridgeTests(unittest.TestCase):
    def setUp(self):
        tmp=tempfile.TemporaryDirectory();self.addCleanup(tmp.cleanup)
        self.binary=Path(tmp.name)/'graph.exe'
        self.binary.write_bytes(b'fixture')
        self.pairs=[[2,1],[2,0],[2,1],[1,3]]
        self.expected=project_graph(4,self.pairs,rust_bin='')

    def test_reference_order_and_duplicate_edges(self):
        self.assertEqual(self.expected['node_indices'],[2,1,0,3])
        self.assertEqual(self.expected['edge_indices'],self.pairs)
        self.assertFalse(self.expected['truncated'])
        pairs=[[i,i+1] for i in range(200)]
        full=project_graph(201,pairs,rust_bin='')
        self.assertTrue(full['truncated'])
        self.assertEqual(len(full['node_indices']),120)
        self.assertEqual(len(full['edge_indices']),119)
        long=project_graph(2,[[0,1]]*300,rust_bin='')
        self.assertEqual(len(long['edge_indices']),200)
        self.assertFalse(long['truncated'])

    def test_random_graph_matches_pre_migration_behavior(self):
        import random
        rng = random.Random(4838)
        for _ in range(300):
            total = rng.randrange(0, 300)
            links = []
            for i in range(total):
                a = f'concept:///{rng.randrange(150)}'
                b = f'concept:///{rng.randrange(150)}'
                links.append({'resolved':rng.randrange(5) != 0,
                              'source_uri':a,'target_uri':b,
                              'source_name':f'S{i}','target_name':f'T{i}',
                              'source_category':'wisdom','target_category':'rule'})
            focus = rng.choice(['', 'concept:///5', 'concept:///20'])
            nodes = {}
            edges = []
            for link in links:
                if not link['resolved'] or (focus and focus not in (link['source_uri'],link['target_uri'])):
                    continue
                for uri, name, category in ((link['source_uri'],link['source_name'],link['source_category']),
                                            (link['target_uri'],link['target_name'],link['target_category'])):
                    nodes.setdefault(uri, {'id':uri,'name':name,'category':category})
                edges.append({'source':link['source_uri'],'target':link['target_uri'],'type':'SEE_ALSO'})
                if len(nodes) >= 120: break
            old = {'nodes':list(nodes.values())[:120], 'edges':edges[:200],
                   'focus':focus or None, 'truncated':len(nodes) >= 120}
            class LocalHandler(Handler):
                app=SimpleNamespace(see_also_links=lambda:links)
            with patch.dict(os.environ, {'SINGULARITY_GRAPH_PROJECTION_RUST_BINARY':''}):
                got=object.__new__(LocalHandler).links_graph({'focus':focus})
            self.assertEqual(old, got)

    def test_native_exact_without_private_data(self):
        fake=Mock(return_value=subprocess.CompletedProcess([],0,json.dumps(self.expected),''))
        with patch.dict(os.environ,{'SINGULARITY_GRAPH_PROJECTION_RUST_BINARY':str(self.binary),
                                    'PRIVATE_CONFIG':'SECRET'}):
            got=project_graph(4,self.pairs,runner=fake)
        self.assertEqual(got,self.expected)
        args,opts=fake.call_args
        self.assertEqual(args,([str(self.binary)],))
        self.assertFalse(opts['shell']);self.assertEqual(opts['timeout'],8)
        self.assertEqual(json.loads(opts['input']),
                         {'schema':'singularity-dashboard-graph/v1','node_count':4,'pairs':self.pairs})
        self.assertNotIn('PRIVATE_CONFIG',opts['env'])
        for fragment in ('SECRET','uri','name','token'):
            self.assertNotIn(fragment,opts['input'])

    def test_parity_and_process_fail_closed(self):
        bad=[(json.dumps({**self.expected,'node_indices':[1,2,0,3]}),0),
             (json.dumps({'node_indices':[]}),0),('broken',0),('',2)]
        for output,rc in bad:
            with self.subTest(output=output),self.assertRaisesRegex(RuntimeError,'graph_native_'):
                fake=Mock(return_value=subprocess.CompletedProcess([],rc,output,''))
                project_graph(4,self.pairs,rust_bin=self.binary,runner=fake)

    def test_bounds_and_binary_safety(self):
        with self.assertRaisesRegex(RuntimeError,'invalid_pair'):
            project_graph(2,[[0,2]],rust_bin=self.binary)
        with self.assertRaisesRegex(RuntimeError,'input_too_large'):
            project_graph(2,[[0,1]]*20001,rust_bin=self.binary)
        with self.assertRaisesRegex(RuntimeError,'binary_invalid'):
            project_graph(2,[],rust_bin='relative.exe')
        l=self.binary.parent/'link.exe'
        try:l.symlink_to(self.binary)
        except OSError:return
        with self.assertRaisesRegex(RuntimeError,'binary_invalid'):
            project_graph(2,[],rust_bin=l)

    def test_handler_graph_result_and_focus_unchanged(self):
        links=[
            {'resolved':True,'source_uri':'concept:///wisdom/a','target_uri':'concept:///rule/b',
             'source_name':'A private','target_name':'B private','source_category':'wisdom','target_category':'rule'},
            {'resolved':True,'source_uri':'concept:///wisdom/a','target_uri':'concept:///rule/b',
             'source_name':'Other','target_name':'Other','source_category':'wrong','target_category':'wrong'},
            {'resolved':False,'source_uri':'concept:///wisdom/a','target_uri':None,
             'source_name':'A private','target_name':'missing','source_category':'wisdom','target_category':'unresolved'}]
        class LocalHandler(Handler):
            app=SimpleNamespace(see_also_links=lambda:links)
        handler=object.__new__(LocalHandler)
        with patch.dict(os.environ,{'SINGULARITY_GRAPH_PROJECTION_RUST_BINARY':''}):
            graph=handler.links_graph({})
            filtered=handler.links_graph({'focus':'concept:///rule/b'})
        self.assertEqual({k:v for k,v in graph.items() if k != 'focus'},
                         {k:v for k,v in filtered.items() if k != 'focus'})
        self.assertEqual(filtered['focus'], 'concept:///rule/b')
        self.assertEqual(graph['nodes'],[
            {'id':'concept:///wisdom/a','name':'A private','category':'wisdom'},
            {'id':'concept:///rule/b','name':'B private','category':'rule'}])
        self.assertEqual(len(graph['edges']),2)
        self.assertEqual(handler.links_graph({'focus':'unknown'})['nodes'],[])

if __name__=='__main__':unittest.main()
