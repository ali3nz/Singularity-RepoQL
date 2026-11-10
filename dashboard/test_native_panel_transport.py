import unittest
import native_panel_proxy as p


class TransportTests(unittest.TestCase):
    def test_transport_remaps_absolute_loopback_urls(self):
        js = p.transport("office").decode()
        self.assertIn("u.host!==location.host", js)
        self.assertIn("127.0.0.1", js)
        self.assertIn("/embed/office", js)

    def test_rewrite_prefixes_sprites_and_injects_transport(self):
        html = '<html><head></head><body><img src="/sprites/a.png"><script src="/assets/x.js"></script></body></html>'
        out = p.rewrite("office", html, "text/html")
        self.assertIn("/embed/office/sprites/a.png", out)
        self.assertIn("/embed/office/assets/x.js", out)
        self.assertIn("_transport.js", out)

    def test_rewrite_keeps_sprite_catalog_paths_in_javascript(self):
        js = 'x={a:"/sprites/coffee-machine.png",b:"/_next/static/c.js"}'
        out = p.rewrite("office", js, "application/javascript")
        self.assertIn('"/sprites/coffee-machine.png"', out)
        self.assertIn('/embed/office/_next/static/c.js', out)


if __name__ == "__main__":
    unittest.main()


def test_rewrite_prefixes_vite_preload_helper():
    from native_panel_proxy import rewrite, prefix
    out = rewrite('openmausbot', 'const a=function(i){return"/"+i};', 'text/javascript')
    assert 'return"' + prefix('openmausbot') + '/"+i' in out
