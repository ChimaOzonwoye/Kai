"""
Shrine Change Tracker — Pipeline Integration Tests

Tests the server pipeline (routing, cropping, parsing, error handling)
using a mock Ollama server. Does NOT require Ollama to be running.

Usage:
    python test_pipeline.py
"""

import base64
import json
import sys
import threading
import time
import unittest
from http.server import HTTPServer, BaseHTTPRequestHandler
from unittest.mock import patch

import numpy as np

# Add parent dir to path
sys.path.insert(0, ".")
import server as srv


class MockOllamaHandler(BaseHTTPRequestHandler):
    """Mock Ollama server that returns predictable counts."""

    response_counts = {"plaques": 8, "flowers": 3, "candles": 1, "pictures": 2, "other": 1, "total": 15, "visibility": "clear"}

    def do_GET(self):
        if "/api/tags" in self.path:
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({
                "models": [{"name": "gemma3:4b", "size": 3000000000}]
            }).encode())
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if "/api/chat" in self.path:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length)) if length > 0 else {}

            # Verify request structure
            assert body.get("model") == "gemma3:4b", f"Wrong model: {body.get('model')}"
            assert body.get("format") == "json", "Missing JSON format"
            assert body.get("stream") is False, "Stream should be False"
            assert "options" in body, "Missing options"
            assert body["options"].get("temperature") == 0.1, f"Wrong temperature: {body['options'].get('temperature')}"

            msgs = body.get("messages", [])
            assert len(msgs) == 1, f"Expected 1 message, got {len(msgs)}"
            assert "images" in msgs[0], "No images in message"
            assert len(msgs[0]["images"]) == 1, "Expected 1 image"
            assert "madonnella" in msgs[0]["content"].lower() or "devotional shrine" in msgs[0]["content"].lower(), "Prompt missing domain context"
            assert "DO NOT COUNT" in msgs[0]["content"], "Prompt missing negative constraints"

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({
                "message": {
                    "content": json.dumps(MockOllamaHandler.response_counts)
                }
            }).encode())
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass  # Suppress logging


class TestServerPipeline(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        """Start mock Ollama and configure the Flask test client."""
        # Start mock Ollama on a free port
        cls.mock_ollama = HTTPServer(("127.0.0.1", 0), MockOllamaHandler)
        cls.ollama_port = cls.mock_ollama.server_address[1]
        cls.ollama_thread = threading.Thread(target=cls.mock_ollama.serve_forever, daemon=True)
        cls.ollama_thread.start()

        # Point the server at our mock
        srv.OLLAMA_URL = f"http://127.0.0.1:{cls.ollama_port}"

        cls.app = srv.app.test_client()
        cls.app.testing = True

    @classmethod
    def tearDownClass(cls):
        cls.mock_ollama.shutdown()

    def test_health_check(self):
        """Health endpoint reports connected Ollama and model."""
        r = self.app.get("/health")
        data = r.get_json()
        self.assertEqual(data["status"], "ok")
        self.assertEqual(data["ollama"], "connected")
        self.assertEqual(data["model"], "gemma3:4b")

    def test_health_check_ollama_down(self):
        """Health endpoint handles Ollama being unreachable."""
        old_url = srv.OLLAMA_URL
        srv.OLLAMA_URL = "http://127.0.0.1:1"  # Nothing listening
        try:
            r = self.app.get("/health")
            data = r.get_json()
            self.assertEqual(data["ollama"], "not_connected")
        finally:
            srv.OLLAMA_URL = old_url

    def test_analyze_image_basic(self):
        """Analyze endpoint returns correct multi-run consensus from mock model."""
        # Create a fake image in the cache so we don't need network
        fake_img = np.zeros((800, 1600, 3), dtype=np.uint8)
        fake_img[100:700, 200:1400] = 128  # Gray rectangle

        import cv2
        _, buf = cv2.imencode(".jpg", fake_img)
        fake_bytes = buf.tobytes()

        # Patch the thumbnail fetch to return our fake image
        with patch.object(srv, "_fetch_thumbnail_bytes", return_value=fake_bytes):
            r = self.app.post("/analyze-image", json={
                "pano_id": "test-pano-123",
                "heading": 271.0,
                "pitch": -2.0,
                "num_runs": 2,
            })

        self.assertEqual(r.status_code, 200)
        data = r.get_json()
        # Top-level counts (backward compat) should match median
        self.assertEqual(data["plaques"], 8)
        self.assertEqual(data["flowers"], 3)
        self.assertEqual(data["total"], 15)
        self.assertIn("image_url", data)
        self.assertTrue(data["image_url"].startswith("/image/"))

        # New multi-run fields
        self.assertIn("runs", data)
        self.assertIn("median", data)
        self.assertIn("range", data)
        self.assertIn("confidence", data)
        self.assertIn("agreement", data)
        self.assertIn("visibility", data)

        # With consistent mock, confidence should be high
        self.assertEqual(data["confidence"], "high")
        self.assertEqual(len(data["runs"]), 2)

    def test_analyze_image_with_crop(self):
        """Analyze endpoint correctly crops before sending to model and returns crop image."""
        fake_img = np.zeros((800, 1600, 3), dtype=np.uint8)
        import cv2
        _, buf = cv2.imencode(".jpg", fake_img)
        fake_bytes = buf.tobytes()

        actual_img_sent = []

        original_analyze = srv._analyze_image_vlm

        def capture_analyze(img):
            actual_img_sent.append(img.shape)
            return original_analyze(img)

        with patch.object(srv, "_fetch_thumbnail_bytes", return_value=fake_bytes):
            with patch.object(srv, "_analyze_image_vlm", side_effect=capture_analyze):
                # Send with crop: right half of image
                r = self.app.post("/analyze-image", json={
                    "pano_id": "test-pano-456",
                    "heading": 271.0,
                    "pitch": -2.0,
                    "crop": {"x": 0.5, "y": 0.0, "w": 0.5, "h": 1.0},
                    "num_runs": 1,
                })

        self.assertEqual(r.status_code, 200)
        data = r.get_json()
        # The cropped image should be roughly half the width
        h, w = actual_img_sent[0][:2]
        self.assertAlmostEqual(w, 800, delta=10)  # Half of 1600
        self.assertAlmostEqual(h, 800, delta=10)  # Full height

        # Should have both full and crop image URLs
        self.assertIn("image_url", data)
        self.assertIn("crop_image_url", data)

    def test_analyze_image_no_crop(self):
        """Without crop, full image is sent to model and no crop_image_url returned."""
        fake_img = np.zeros((800, 1600, 3), dtype=np.uint8)
        import cv2
        _, buf = cv2.imencode(".jpg", fake_img)
        fake_bytes = buf.tobytes()

        actual_img_sent = []

        def capture_analyze(img):
            actual_img_sent.append(img.shape)
            return {"plaques": 0, "flowers": 0, "candles": 0, "pictures": 0, "other": 0, "total": 0}

        with patch.object(srv, "_fetch_thumbnail_bytes", return_value=fake_bytes):
            with patch.object(srv, "_analyze_image_vlm", side_effect=capture_analyze):
                r = self.app.post("/analyze-image", json={
                    "pano_id": "test-pano-789",
                    "heading": 271.0,
                    "pitch": -2.0,
                    "num_runs": 1,
                })

        self.assertEqual(r.status_code, 200)
        data = r.get_json()
        h, w = actual_img_sent[0][:2]
        self.assertEqual(w, 1600)
        self.assertEqual(h, 800)
        self.assertNotIn("crop_image_url", data)

    def test_crop_region_function(self):
        """_crop_to_region correctly crops image by percentage."""
        img = np.zeros((100, 200, 3), dtype=np.uint8)
        img[:, :] = 255  # White image

        # Mark the crop area with a different color
        img[25:75, 50:150] = 128  # Gray rectangle in center

        cropped = srv._crop_to_region(img, {"x": 0.25, "y": 0.25, "w": 0.5, "h": 0.5})
        self.assertEqual(cropped.shape[0], 50)  # 50% of 100
        self.assertEqual(cropped.shape[1], 100)  # 50% of 200
        self.assertTrue(np.all(cropped == 128))  # Should be all gray

    def test_crop_region_invalid(self):
        """Invalid crop region returns original image."""
        img = np.zeros((100, 200, 3), dtype=np.uint8)

        # Zero-size crop
        result = srv._crop_to_region(img, {"x": 0.5, "y": 0.5, "w": 0.0, "h": 0.0})
        self.assertEqual(result.shape, img.shape)

    def test_prompt_structure(self):
        """Verify prompt contains required elements."""
        prompt = srv._VLM_PROMPT
        # Domain context
        self.assertIn("devotional shrine", prompt.lower())
        self.assertIn("madonnella", prompt.lower())

        # Categories
        for cat in ["plaques", "flowers", "candles", "pictures", "other"]:
            self.assertIn(cat, prompt)

        # Negative constraints
        self.assertIn("DO NOT COUNT", prompt)
        self.assertIn("vehicles", prompt.lower())
        self.assertIn("pedestrians", prompt.lower())
        self.assertIn("street signs", prompt.lower())

        # Counting strategy
        self.assertIn("left to right", prompt.lower())

        # Fallback
        self.assertIn("return all zeros", prompt.lower())

        # JSON output format
        self.assertIn('"plaques"', prompt)
        self.assertIn('"total"', prompt)

        # Visibility self-assessment
        self.assertIn("visibility", prompt.lower())
        self.assertIn("clear", prompt)
        self.assertIn("partial", prompt)
        self.assertIn("poor", prompt)

    def test_temperature_setting(self):
        """Temperature is set to a low value for consistency."""
        self.assertLessEqual(srv.OLLAMA_TEMPERATURE, 0.2)
        self.assertGreater(srv.OLLAMA_TEMPERATURE, 0.0)

    def test_model_response_parsing(self):
        """Server correctly parses model JSON response and computes total."""
        fake_img = np.zeros((100, 200, 3), dtype=np.uint8)

        # Set mock to return counts where total is wrong (model might miscalculate)
        MockOllamaHandler.response_counts = {
            "plaques": 5, "flowers": 2, "candles": 0,
            "pictures": 1, "other": 0, "total": 999,  # Wrong total
        }

        import cv2
        _, buf = cv2.imencode(".jpg", fake_img)
        fake_bytes = buf.tobytes()

        with patch.object(srv, "_fetch_thumbnail_bytes", return_value=fake_bytes):
            r = self.app.post("/analyze-image", json={
                "pano_id": "test-parse",
                "heading": 0,
                "pitch": 0,
                "num_runs": 1,
            })

        data = r.get_json()
        # Server should recompute total from categories
        self.assertEqual(data["total"], 8)  # 5+2+0+1+0 = 8, not 999

        # Restore default
        MockOllamaHandler.response_counts = {
            "plaques": 8, "flowers": 3, "candles": 1,
            "pictures": 2, "other": 1, "total": 15,
        }

    def test_stored_image_accessible(self):
        """Stored images can be retrieved via /image/<id>."""
        fake_img = np.zeros((800, 1600, 3), dtype=np.uint8)
        import cv2
        _, buf = cv2.imencode(".jpg", fake_img)
        fake_bytes = buf.tobytes()

        with patch.object(srv, "_fetch_thumbnail_bytes", return_value=fake_bytes):
            r = self.app.post("/analyze-image", json={
                "pano_id": "test-img-store",
                "heading": 0,
                "pitch": 0,
                "num_runs": 1,
            })

        data = r.get_json()
        img_url = data["image_url"]

        # Fetch the stored image
        r2 = self.app.get(img_url)
        self.assertEqual(r2.status_code, 200)
        self.assertEqual(r2.content_type, "image/png")
        self.assertGreater(len(r2.data), 100)  # Non-trivial image data

    def test_multi_run_consensus(self):
        """Multi-run analysis computes correct consensus with consistent mock."""
        fake_img = np.zeros((100, 200, 3), dtype=np.uint8)

        # Mock returns same counts each time — should give high confidence
        result = srv._analyze_image_multi(fake_img, num_runs=3)

        self.assertEqual(len(result["runs"]), 3)
        self.assertEqual(result["median"]["plaques"], 8)
        self.assertEqual(result["median"]["total"], 15)
        self.assertEqual(result["confidence"], "high")
        self.assertGreaterEqual(result["agreement"], 0.9)

        # Range should be tight (all same values)
        self.assertEqual(result["range"]["total"][0], 15)
        self.assertEqual(result["range"]["total"][1], 15)

    def test_multi_run_with_variance(self):
        """Multi-run analysis handles varying responses correctly."""
        fake_img = np.zeros((100, 200, 3), dtype=np.uint8)

        # Simulate varying responses by patching _analyze_image_vlm
        call_count = [0]
        responses = [
            {"plaques": 5, "flowers": 2, "candles": 0, "pictures": 1, "other": 0, "total": 8, "visibility": "clear"},
            {"plaques": 15, "flowers": 2, "candles": 0, "pictures": 1, "other": 0, "total": 18, "visibility": "partial"},
            {"plaques": 8, "flowers": 2, "candles": 0, "pictures": 1, "other": 0, "total": 11, "visibility": "clear"},
        ]

        def varying_vlm(img):
            idx = call_count[0] % len(responses)
            call_count[0] += 1
            return dict(responses[idx])

        with patch.object(srv, "_analyze_image_vlm", side_effect=varying_vlm):
            result = srv._analyze_image_multi(fake_img, num_runs=3)

        self.assertEqual(len(result["runs"]), 3)
        # Median of [5, 15, 8] = 8
        self.assertEqual(result["median"]["plaques"], 8)
        # Range should reflect the spread
        self.assertEqual(result["range"]["plaques"], [5, 15])
        # With high variance, confidence should not be high
        self.assertIn(result["confidence"], ["moderate", "low"])
        # Worst visibility should be "partial"
        self.assertEqual(result["visibility"], "partial")


if __name__ == "__main__":
    unittest.main(verbosity=2)
