"""Protect sensitive exception text in dashboard's generic error boundary."""
import contextlib
import io
import unittest
from unittest.mock import patch
from server import Handler


class DashboardUnexpectedFailureTests(unittest.TestCase):
    def test_unexpected_exception_never_echoes_sensitive_exception_text(self):
        h = object.__new__(Handler)
        h.path = '/api/test'
        h.headers = {'Host': 'localhost:18100'}
        h.is_public_office_host = lambda: False
        h.authorized = lambda: True
        h.dispatch = lambda *_: (_ for _ in ()).throw(RuntimeError('api_key=test-secret; file=C:/private'))
        response = []
        h.send_json = lambda code, payload: response.append((code, payload))
        h.request_origin_allowed = lambda **kwargs: True
        out = io.StringIO()
        with patch('server.variant_features',return_value={'features': {}}), \
             patch('server.variant_route_allowed',return_value=True), \
             contextlib.redirect_stderr(out):
            h.route('GET')
        self.assertEqual(response, [(500, {'error': 'internal_error'})])
        self.assertNotIn('test-secret',out.getvalue())
        self.assertNotIn('C:/private',out.getvalue())
        self.assertIn('RuntimeError',out.getvalue())


if __name__=='__main__':unittest.main()
