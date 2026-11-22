"""Service local de parole en baoulé (code ISO `bci`) pour SENTINELLE VIVANT.

Deux modèles ouverts, exécutés sur ce PC, sans aucun appel réseau une fois téléchargés :
- écoute : `abdouaziiz/baoule_stt_2` (Whisper small affiné sur du baoulé lu, Apache 2.0) ;
- voix   : `AfriSpeech/africa-tts`, langue `bci` (2,2 h de données, CC-BY-NC : usage non commercial).

Le service n'écoute que sur 127.0.0.1 : seul le serveur de l'application lui parle. Il ne garde ni son ni texte.
Il ne comprend rien et ne décide rien : il transcrit un son, ou lit un texte. Le sens est traité par le serveur.

Lancement : data/baoule/venv/Scripts/python.exe tools/baoule/serveur.py   (voir docs/BAOULE.md)
Réglages : BAOULE_PORT (8765), BAOULE_STT_DIR (data/baoule/stt), BAOULE_TTS_DIR (data/baoule/tts).
"""

from __future__ import annotations

import io
import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import soundfile as sf

PORT = int(os.environ.get('BAOULE_PORT', '8765'))
STT_DIR = os.environ.get('BAOULE_STT_DIR', 'data/baoule/stt')
TTS_DIR = os.environ.get('BAOULE_TTS_DIR', 'data/baoule/tts')
MAX_BODY = 4 * 1024 * 1024
MAX_AUDIO_S = 30
MAX_TEXT = 600

lock = threading.Lock()  # un seul calcul à la fois : le processeur n'en supporte pas davantage
stt = None
tts = None
errors: dict[str, str] = {}


def load() -> None:
    global stt, tts
    try:
        import torch
        from transformers import WhisperForConditionalGeneration, WhisperProcessor

        processor = WhisperProcessor.from_pretrained(STT_DIR)
        model = WhisperForConditionalGeneration.from_pretrained(STT_DIR)
        model.eval()

        def transcribe(samples: np.ndarray) -> str:
            feats = processor(samples, sampling_rate=16000, return_tensors='pt').input_features
            # Plafond proportionnel à la durée : sur un son très court, ce modèle a tendance à inventer une longue phrase.
            cap = min(120, int(14 * len(samples) / 16000) + 12)
            with torch.no_grad():
                ids = model.generate(feats, max_new_tokens=cap, no_repeat_ngram_size=3)
            return processor.batch_decode(ids, skip_special_tokens=True)[0].strip()

        stt = transcribe
    except Exception as e:  # noqa: BLE001 : l'état est rapporté par /health, le service reste utilisable pour l'autre moitié
        errors['stt'] = f'{type(e).__name__}: {e}'[:300]
    try:
        from africa_tts import AfricaTTS

        engine = AfricaTTS.load(TTS_DIR, download=False)

        cache: dict[str, np.ndarray] = {}
        pause = np.zeros(int(0.3 * 24000), dtype=np.float32)

        def speak(text: str) -> np.ndarray:
            # Phrase par phrase, avec mémoire : une phrase fixe déjà prononcée (« les détails sont à l'écran ») n'est pas
            # recalculée, et elle est toujours dite de la même façon. Seules les phrases à nombre coûtent du temps.
            out: list[np.ndarray] = []
            for sentence in [x.strip() for x in re.split(r'(?<=[.!?])\s+', text) if x.strip()]:
                if sentence not in cache:
                    if len(cache) > 400:
                        cache.clear()
                    cache[sentence] = engine.generate(sentence, lang='bci', codeswitch=False)
                out.extend([cache[sentence], pause])
            return np.concatenate(out[:-1]) if out else np.zeros(0, dtype=np.float32)

        tts = speak
    except Exception as e:  # noqa: BLE001
        errors['tts'] = f'{type(e).__name__}: {e}'[:300]


def to_16k_mono(data: bytes) -> np.ndarray:
    x, sr = sf.read(io.BytesIO(data), dtype='float32', always_2d=True)
    x = x.mean(axis=1)
    if len(x) > sr * MAX_AUDIO_S:
        raise ValueError(f'enregistrement de plus de {MAX_AUDIO_S} secondes')
    if sr != 16000:
        n = int(len(x) * 16000 / sr)
        x = np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype(np.float32)
    return x


class Handler(BaseHTTPRequestHandler):
    server_version = 'SentinelleBaoule/1'

    def log_message(self, *_args) -> None:  # ni son, ni texte, ni adresse dans un journal
        return

    def reply(self, status: int, body: bytes, ctype: str) -> None:
        self.send_response(status)
        self.send_header('content-type', ctype)
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def json(self, status: int, obj: dict) -> None:
        self.reply(status, json.dumps(obj, ensure_ascii=False).encode('utf-8'), 'application/json; charset=utf-8')

    def do_GET(self) -> None:  # noqa: N802
        if self.path != '/health':
            return self.json(404, {'error': 'inconnu'})
        self.json(200, {'stt': stt is not None, 'tts': tts is not None, 'errors': errors})

    def do_POST(self) -> None:  # noqa: N802
        n = int(self.headers.get('content-length') or 0)
        if n <= 0 or n > MAX_BODY:
            return self.json(413, {'error': 'corps absent ou trop gros'})
        body = self.rfile.read(n)
        t0 = time.time()
        try:
            if self.path == '/stt':
                if stt is None:
                    return self.json(503, {'error': errors.get('stt', 'écoute indisponible')})
                samples = to_16k_mono(body)
                with lock:
                    text = stt(samples)
                return self.json(200, {'text': text, 'audioSeconds': round(len(samples) / 16000, 2), 'computeSeconds': round(time.time() - t0, 2)})
            if self.path == '/tts':
                if tts is None:
                    return self.json(503, {'error': errors.get('tts', 'voix indisponible')})
                text = str(json.loads(body.decode('utf-8')).get('text', '')).strip()
                if not text or len(text) > MAX_TEXT:
                    return self.json(400, {'error': 'texte absent ou trop long'})
                with lock:
                    audio = tts(text)
                buf = io.BytesIO()
                sf.write(buf, audio, 24000, format='WAV', subtype='PCM_16')
                self.send_response(200)
                self.send_header('content-type', 'audio/wav')
                self.send_header('content-length', str(buf.getbuffer().nbytes))
                self.send_header('x-compute-seconds', str(round(time.time() - t0, 2)))
                self.end_headers()
                self.wfile.write(buf.getvalue())
                return None
            return self.json(404, {'error': 'inconnu'})
        except Exception as e:  # noqa: BLE001
            return self.json(400, {'error': f'{type(e).__name__}: {e}'[:300]})


if __name__ == '__main__':
    t = time.time()
    load()
    print(f'parole baoulé : écoute {"prête" if stt else "INDISPONIBLE"}, voix {"prête" if tts else "INDISPONIBLE"} ({time.time() - t:.0f} s) ; http://127.0.0.1:{PORT}', flush=True)
    for k, v in errors.items():
        print(f'  {k} : {v}', file=sys.stderr, flush=True)
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
