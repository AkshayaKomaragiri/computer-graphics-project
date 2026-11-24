"""Check the same HTTP entry point teammates use, without opening a browser."""
import importlib.util
import os
import tempfile
from pathlib import Path
import threading
import unittest
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("mars_launcher", ROOT / "start.py")
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class LauncherTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = launcher.create_server(0)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = "http://127.0.0.1:{}/".format(cls.server.server_address[1])

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.thread.join()
        cls.server.server_close()

    def test_root_is_project_directory_even_from_another_working_directory(self):
        original_directory = Path.cwd()
        with tempfile.TemporaryDirectory() as directory:
            try:
                os.chdir(directory)
                with urlopen(self.base) as response:
                    self.assertEqual(response.status, 200)
                    self.assertIn(b"Mars Atlas", response.read())
                    self.assertEqual(response.headers["Cache-Control"], "no-store")
            finally:
                os.chdir(original_directory)

    def test_every_startup_dependency_has_a_javascript_mime_type(self):
        for path in ["js/startup.js", "js/app.mjs", "js/terrain-analysis.mjs", "vendor/three/three.module.js", "vendor/three/OrbitControls.js"]:
            with self.subTest(path=path), urlopen(self.base + path) as response:
                self.assertEqual(response.headers.get_content_type(), "text/javascript")
                self.assertGreater(len(response.read()), 100)

    def test_region_catalog_and_heightmap_are_served(self):
        with urlopen(self.base + "data/sites.json") as response:
            self.assertEqual(response.headers.get_content_type(), "application/json")
            self.assertIn(b"Jezero Crater", response.read())
        with urlopen(self.base + "data/jezero_heightmap.png") as response:
            self.assertTrue(response.read().startswith(b"\x89PNG\r\n\x1a\n"))


if __name__ == "__main__":
    unittest.main()
