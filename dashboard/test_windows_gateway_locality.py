"""Native Windows proxy must not mistake a local port forward for local data."""
import os
import unittest
from unittest.mock import patch, MagicMock
import unified_bridge as bridge

class GatewayLocalityTests(unittest.TestCase):
    def test_tunnel_ssh_listener_is_not_accepted(self):
        process = MagicMock(returncode=0, stdout='38028\nssh.exe\nC:\\Windows\\System32\\OpenSSH\\ssh.exe\n')
        with patch.dict(os.environ, {'SINGULARITY_WINDOWS_NATIVE':'1'}, clear=False), \
             patch.object(bridge.sys,'platform','win32'), \
             patch.object(bridge,'BASE','http://127.0.0.1:18101'), \
             patch.object(bridge.subprocess,'run',process):
            self.assertFalse(bridge._native_gateway_owner())
            with patch.object(bridge.SECRET_FILE.__class__,'read_text',side_effect=AssertionError('token accessed')):
                result=bridge.forward_unified('GET','/api/unified/graph')
            self.assertEqual(result['error'],'windows_local_unified_gateway_unverified')

    def test_unapproved_shim_is_rejected(self):
        with patch.dict(os.environ, {'SINGULARITY_WINDOWS_NATIVE':'1'},clear=False),\
             patch.object(bridge.sys,'platform','win32'),\
             patch.object(bridge,'BASE','http://127.0.0.1:18102'),\
             patch.object(bridge.subprocess,'run',return_value=MagicMock(returncode=0,stdout='42000\npython.exe\nC:\\Python\\python.exe\n')):
            self.assertFalse(bridge._native_gateway_owner())

    def test_local_gateway_name_may_proceed(self):
        with patch.dict(os.environ, {'SINGULARITY_WINDOWS_NATIVE':'1'},clear=False),\
             patch.object(bridge.sys,'platform','win32'),\
             patch.object(bridge,'BASE','http://127.0.0.1:18101'),\
             patch.object(bridge.subprocess,'run',return_value=MagicMock(returncode=0,stdout='42001\nunified-repoql-control.exe\nC:\\Singularity\\unified-repoql-control.exe\n')):
            self.assertTrue(bridge._native_gateway_owner())

    def test_process_owner_probe_never_opens_a_console(self):
        runner=MagicMock(return_value=MagicMock(returncode=0,stdout='42001\nunified-repoql-control.exe\nC:\\Singularity\\unified-repoql-control.exe\n'))
        with patch.dict(os.environ, {'SINGULARITY_WINDOWS_NATIVE':'1'}, clear=False), \
             patch.object(bridge.sys,'platform','win32'), \
             patch.object(bridge.subprocess,'run',runner), \
             patch.object(bridge.subprocess,'CREATE_NO_WINDOW',0x08000000,create=True):
            self.assertTrue(bridge._native_gateway_owner())
        self.assertEqual(runner.call_args.kwargs['creationflags'],0x08000000)

    def test_failure_clears_previously_cached_graph(self):
        bridge._graph_cache_clear()
        bridge._store((), {'available':True,'nodes':[{'id':'remote-secret'}]})
        with patch.dict(os.environ, {'SINGULARITY_WINDOWS_NATIVE':'1'},clear=False),\
             patch.object(bridge.sys,'platform','win32'),\
             patch.object(bridge,'BASE','http://127.0.0.1:18101'),\
             patch.object(bridge.subprocess,'run',return_value=MagicMock(returncode=0,stdout='38028\nssh.exe\n')):
            result=bridge.forward_unified('GET','/api/unified/graph')
        self.assertFalse(result['available'])
        self.assertEqual(bridge._graph_cache,{})


    def test_listener_pid_change_invalidates_old_graph_cache(self):
        # A process restart or SSH-to-Rust cutover can reuse port and path.
        # Never show a graph from the previous source for the stale-cache TTL.
        bridge._graph_cache_clear()
        with patch.dict(os.environ, {'SINGULARITY_WINDOWS_NATIVE':'1'}, clear=False), \
             patch.object(bridge.sys,'platform','win32'), \
             patch.object(bridge,'BASE','http://127.0.0.1:18101'), \
             patch.object(bridge.subprocess,'run',return_value=MagicMock(returncode=0,stdout='42001\nunified-repoql-control.exe\nC:\\Singularity\\unified-repoql-control.exe\n')):
            self.assertTrue(bridge._native_gateway_owner())
            bridge._store((), {'nodes':[{'id':'previous-process'}], 'available':True})
            self.assertTrue(bridge._graph_cache)
        with patch.dict(os.environ, {'SINGULARITY_WINDOWS_NATIVE':'1'}, clear=False), \
             patch.object(bridge.sys,'platform','win32'), \
             patch.object(bridge,'BASE','http://127.0.0.1:18101'), \
             patch.object(bridge.subprocess,'run',return_value=MagicMock(returncode=0,stdout='42002\nunified-repoql-control.exe\nC:\\Singularity\\unified-repoql-control.exe\n')):
            self.assertTrue(bridge._native_gateway_owner())
            self.assertEqual(bridge._graph_cache,{})

    def test_garbage_pid_does_not_establish_gateway_identity(self):
        with patch.dict(os.environ, {'SINGULARITY_WINDOWS_NATIVE':'1'},clear=False), \
             patch.object(bridge.sys,'platform','win32'), \
             patch.object(bridge.subprocess,'run',return_value=MagicMock(returncode=0,stdout='not-a-pid\nunified-repoql-control.exe\nC:\\Singularity\\unified-repoql-control.exe\n')):
            self.assertFalse(bridge._native_gateway_owner())


    def test_inflight_old_graph_cannot_repopulate_cache_after_owner_changes(self):
        bridge._graph_cache_clear()
        with bridge._graph_lock:
            previous_epoch = bridge._graph_epoch
        bridge._graph_cache_clear()
        self.assertFalse(bridge._store((), {'nodes':[{'id':'remote-stale'}]},previous_epoch))
        self.assertEqual(bridge._graph_cache,{})
        self.assertTrue(bridge._store((), {'nodes':[{'id':'local-new'}]},bridge._graph_epoch))
        self.assertEqual(bridge._graph_cache[()][1]['nodes'][0]['id'],'local-new')


    def test_source_switch_during_graph_read_never_returns_previous_graph(self):
        bridge._graph_cache_clear()
        def switched(*args):
            bridge._graph_cache_clear()
            return {'available':True,'nodes':[{'id':'dockerhost-only'}]}
        with patch.object(bridge,'_fetch_upstream',side_effect=switched):
            response=bridge._cached_graph('GET','/api/unified/graph',{},None)
        self.assertFalse(response['available'])
        self.assertEqual(response['error'],'unified_gateway_changed_during_graph_read')
        self.assertEqual(bridge._graph_cache,{})

if __name__=='__main__':unittest.main()
