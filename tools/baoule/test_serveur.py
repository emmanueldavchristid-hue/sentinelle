"""Tests du service local de parole, SANS les modèles : l'écoute et la voix sont remplacées par de faux moteurs.

Ce qui est vérifié ici : le nettoyage du son (silence, niveau), la mémoire des phrases (mémoire vive et disque), la
préparation à l'avance, et les routes HTTP. Ce qui ne l'est pas : la justesse et la vitesse des vrais modèles, qui ne se
mesurent que sur le PC où ils sont installés (`pnpm baoule:check`).

Lancement : python tools/baoule/test_serveur.py   (demande numpy et soundfile, rien d'autre)
"""

from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import serveur  # noqa: E402


def wav(samples: np.ndarray, sr: int = 16000) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, samples, sr, format='WAV', subtype='PCM_16')
    return buf.getvalue()


def voice(seconds: float, level: float, sr: int = 16000) -> np.ndarray:
    """Un son qui ressemble assez à de la parole pour le tri par niveau : une note modulée."""
    t = np.arange(int(seconds * sr)) / sr
    return (level * np.sin(2 * np.pi * 180 * t) * (0.6 + 0.4 * np.sin(2 * np.pi * 4 * t))).astype(np.float32)


def noise(seconds: float, level: float, sr: int = 16000) -> np.ndarray:
    return (level * np.random.default_rng(1).standard_normal(int(seconds * sr))).astype(np.float32)


class CleanTest(unittest.TestCase):
    def test_silence_is_not_transcribed(self):
        _, silence = serveur.clean(np.zeros(32000, dtype=np.float32))
        self.assertTrue(silence)
        _, silence = serveur.clean(noise(2.0, 0.002))
        self.assertTrue(silence, 'un bruit de fond régulier n’est pas de la parole')

    def test_too_short_is_silence(self):
        _, silence = serveur.clean(voice(0.05, 0.3))
        self.assertTrue(silence)

    def test_speech_is_trimmed_and_raised(self):
        x = np.concatenate([noise(1.0, 0.001), voice(1.5, 0.05) + noise(1.5, 0.001), noise(3.0, 0.001)])
        y, silence = serveur.clean(x)
        self.assertFalse(silence)
        self.assertLess(len(y) / 16000, 2.4, 'les silences du début et de la fin sont retirés')
        self.assertGreater(len(y) / 16000, 1.5, 'une marge est gardée autour de la parole')
        self.assertGreater(float(np.max(np.abs(y))), 0.5, 'une voix faible est remontée')
        self.assertLessEqual(float(np.max(np.abs(y))), 1.0, 'sans saturer')

    def test_loud_speech_is_left_at_its_level(self):
        x = np.concatenate([np.zeros(8000, dtype=np.float32), voice(1.0, 0.8), np.zeros(8000, dtype=np.float32)])
        y, silence = serveur.clean(x)
        self.assertFalse(silence)
        self.assertAlmostEqual(float(np.max(np.abs(y))), 0.8, delta=0.05)


class LanguageTest(unittest.TestCase):
    def test_language_read_from_generation_config(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(serveur.model_language(d))
            with open(os.path.join(d, 'generation_config.json'), 'w', encoding='utf-8') as fh:
                json.dump({'forced_decoder_ids': [[1, 50265], [2, 50359]], 'lang_to_id': {'<|fr|>': 50265, '<|en|>': 50259}}, fh)
            self.assertEqual(serveur.model_language(d), 'fr')
            with open(os.path.join(d, 'generation_config.json'), 'w', encoding='utf-8') as fh:
                json.dump({'language': '<|sw|>'}, fh)
            self.assertEqual(serveur.model_language(d), 'sw')
            with open(os.path.join(d, 'generation_config.json'), 'w', encoding='utf-8') as fh:
                json.dump({'language': 'a language name, not a code'}, fh)
            self.assertIsNone(serveur.model_language(d))


class ServiceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        serveur.CACHE_DIR = cls.tmp.name
        cls.heard: list[int] = []
        cls.said: list[str] = []

        def fake_stt(samples: np.ndarray) -> str:
            cls.heard.append(len(samples))
            return 'min nnɛn mun be ti sɛ'

        def fake_synth(sentence: str) -> np.ndarray:
            cls.said.append(sentence)
            time.sleep(0.02)
            return np.full(2400, 0.1, dtype=np.float32)

        serveur.stt = fake_stt
        serveur.synth = fake_synth
        serveur.info['engine'] = 'faux moteur de test'
        cls.httpd = serveur.serve(0)
        cls.url = f'http://127.0.0.1:{cls.httpd.server_address[1]}'
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.tmp.cleanup()

    def setUp(self):
        type(self).heard.clear()
        type(self).said.clear()
        serveur.memory.clear()
        for f in os.listdir(self.tmp.name):
            os.remove(os.path.join(self.tmp.name, f))

    def post(self, path: str, body: bytes, ctype: str):
        req = urllib.request.Request(self.url + path, data=body, headers={'content-type': ctype}, method='POST')
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, r.headers.get('content-type', ''), r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.headers.get('content-type', ''), e.read()

    def health(self) -> dict:
        with urllib.request.urlopen(self.url + '/health', timeout=5) as r:
            return json.loads(r.read())

    def test_health(self):
        h = self.health()
        self.assertTrue(h['stt'] and h['tts'])
        self.assertEqual(h['engine'], 'faux moteur de test')

    def test_stt_transcribes_speech_and_skips_silence(self):
        status, _, body = self.post('/stt', wav(np.concatenate([np.zeros(16000, dtype=np.float32), voice(1.2, 0.3), np.zeros(32000, dtype=np.float32)])), 'audio/wav')
        j = json.loads(body)
        self.assertEqual(status, 200)
        self.assertEqual(j['text'], 'min nnɛn mun be ti sɛ')
        self.assertFalse(j['silence'])
        self.assertEqual(len(self.heard), 1)
        self.assertLess(self.heard[0] / 16000, 2.0, 'le moteur reçoit le son sans ses silences')

        status, _, body = self.post('/stt', wav(np.zeros(48000, dtype=np.float32)), 'audio/wav')
        j = json.loads(body)
        self.assertEqual((status, j['text'], j['silence']), (200, '', True))
        self.assertEqual(len(self.heard), 1, 'un enregistrement sans parole n’est pas donné au modèle')

    def test_stt_rejects_what_is_not_audio(self):
        status, _, _ = self.post('/stt', b'pas un son', 'audio/wav')
        self.assertEqual(status, 400)

    def test_tts_keeps_each_sentence_once(self):
        text = 'Be klɛli nnɛn mɔcuɛ. Ndɛ’n i kwlaa wo ekran’n su.'
        status, ctype, body = self.post('/tts', json.dumps({'text': text}).encode(), 'application/json')
        self.assertEqual((status, ctype), (200, 'audio/wav'))
        audio, sr = sf.read(io.BytesIO(body), dtype='float32')
        self.assertEqual(sr, 24000)
        self.assertEqual(len(audio), 2400 + int(0.3 * 24000) + 2400, 'deux phrases séparées par une pause')
        self.assertEqual(self.said, ['Be klɛli nnɛn mɔcuɛ.', 'Ndɛ’n i kwlaa wo ekran’n su.'])

        # Même phrase fixe dans une autre réponse : elle n'est pas recalculée.
        self.post('/tts', json.dumps({'text': 'Ndɛ fi kaman. Ndɛ’n i kwlaa wo ekran’n su.'}).encode(), 'application/json')
        self.assertEqual(self.said.count('Ndɛ’n i kwlaa wo ekran’n su.'), 1)

        # Après un redémarrage (mémoire vide), le disque suffit.
        serveur.memory.clear()
        before = len(self.said)
        status, _, again = self.post('/tts', json.dumps({'text': text}).encode(), 'application/json')
        self.assertEqual(status, 200)
        self.assertEqual(len(self.said), before, 'rien n’est recalculé : les phrases sont relues du disque')
        self.assertEqual(again, body, 'et la phrase est dite exactement de la même façon')

    def test_tts_rejects_empty_or_long_text(self):
        self.assertEqual(self.post('/tts', json.dumps({'text': ''}).encode(), 'application/json')[0], 400)
        self.assertEqual(self.post('/tts', json.dumps({'text': 'a' * 700}).encode(), 'application/json')[0], 400)

    def test_warm_prepares_sentences_ahead(self):
        status, _, body = self.post('/warm', json.dumps({'texts': ['N a timan. Kan ekun, yaci.', 'Nnɛn fi wɔman mmua.', 42, 'N a timan.']}).encode(), 'application/json')
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['queued'], 3, 'trois phrases distinctes ; ce qui n’est pas un texte est ignoré')
        deadline = time.time() + 5
        while self.health()['warming'] and time.time() < deadline:
            time.sleep(0.05)
        time.sleep(0.1)
        self.assertEqual(sorted(self.said), sorted(['N a timan.', 'Kan ekun, yaci.', 'Nnɛn fi wɔman mmua.']))
        before = len(self.said)
        status, _, _ = self.post('/tts', json.dumps({'text': 'N a timan. Kan ekun, yaci.'}).encode(), 'application/json')
        self.assertEqual((status, len(self.said)), (200, before), 'la réponse préparée part sans calcul')
        # Les redemander ne remet rien en file.
        _, _, body = self.post('/warm', json.dumps({'texts': ['N a timan. Kan ekun, yaci.']}).encode(), 'application/json')
        self.assertEqual(json.loads(body)['queued'], 0)

    def test_unknown_route(self):
        self.assertEqual(self.post('/autre', b'{}', 'application/json')[0], 404)


if __name__ == '__main__':
    unittest.main(verbosity=1)
