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


if __name__ == "__main__":
    unittest.main()
