"""Service local de parole en baoulé (code ISO `bci`) pour SENTINELLE VIVANT.

Deux modèles ouverts, exécutés sur ce PC, sans aucun appel réseau une fois téléchargés :
- écoute : `abdouaziiz/baoule_stt_2` (Whisper small affiné sur du baoulé lu, Apache 2.0) ;
- voix   : `AfriSpeech/africa-tts`, langue `bci` (2,2 h de données, CC-BY-NC : usage non commercial).

Le service n'écoute que sur 127.0.0.1 : seul le serveur de l'application lui parle. Il ne garde aucun son reçu ni aucune
transcription. Il ne comprend rien et ne décide rien : il transcrit un son, ou lit un texte. Le sens est traité par le serveur.

Vitesse (demande de Yvan, 22/11 : « il prend le temps avant de transcrire ») :
- écoute : si le modèle converti pour CTranslate2 existe (data/baoule/stt-ct2, voir docs/BAOULE.md) et que `faster-whisper`
  est installé, c'est lui qui transcrit (calcul en entiers 8 bits) ; sinon le modèle d'origine, plus lent, reste utilisé ;
- le son est nettoyé avant l'écoute : silences du début et de la fin retirés, niveau remonté s'il est faible ; un
  enregistrement sans parole n'est pas transcrit du tout (le modèle inventerait une phrase) : il est rendu « silence » ;
- voix : chaque phrase déjà prononcée est gardée sur disque (data/baoule/cache-voix) et redite sans calcul, toujours de la
  même façon ; `/warm` prépare à l'avance les phrases qu'on lui donne, en laissant passer les demandes en direct.

Lancement : data/baoule/venv/Scripts/python.exe tools/baoule/serveur.py   (voir docs/BAOULE.md)
Réglages :
  BAOULE_PORT (8765), BAOULE_STT_DIR (data/baoule/stt), BAOULE_STT_CT2_DIR (data/baoule/stt-ct2), BAOULE_TTS_DIR (data/baoule/tts),
  BAOULE_CACHE_DIR (data/baoule/cache-voix ; « off » = mémoire seulement),
  BAOULE_STT_ENGINE (auto | rapide | origine), BAOULE_STT_LANG (langue imposée au moteur rapide ; vide = celle du modèle),
  BAOULE_BEAM (1), BAOULE_THREADS (0 = choix du moteur), BAOULE_TRIM (on | off).
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
import sys
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable, Optional

import numpy as np
import soundfile as sf

PORT = int(os.environ.get('BAOULE_PORT', '8765'))
STT_DIR = os.environ.get('BAOULE_STT_DIR', 'data/baoule/stt')
STT_CT2_DIR = os.environ.get('BAOULE_STT_CT2_DIR', 'data/baoule/stt-ct2')
TTS_DIR = os.environ.get('BAOULE_TTS_DIR', 'data/baoule/tts')
CACHE_DIR = os.environ.get('BAOULE_CACHE_DIR', 'data/baoule/cache-voix')
STT_ENGINE = os.environ.get('BAOULE_STT_ENGINE', 'auto').strip().lower()
STT_LANG = os.environ.get('BAOULE_STT_LANG', '').strip().lower()
BEAM = max(1, min(8, int(os.environ.get('BAOULE_BEAM', '1') or 1)))
THREADS = max(0, int(os.environ.get('BAOULE_THREADS', '0') or 0))
TRIM = os.environ.get('BAOULE_TRIM', 'on').strip().lower() != 'off'
MAX_BODY = 4 * 1024 * 1024
MAX_AUDIO_S = 30
MAX_TEXT = 600
MAX_WARM = 200
TTS_RATE = 24000
# Changer cette valeur invalide les phrases gardées sur disque (à faire si la voix ou son réglage change).
VOICE_VERSION = 'africa-tts-bci-1'

lock = threading.Lock()  # un seul calcul à la fois : le processeur n'en supporte pas davantage
stt: Optional[Callable[[np.ndarray], str]] = None
synth: Optional[Callable[[str], np.ndarray]] = None  # une phrase -> échantillons à 24 kHz
errors: dict[str, str] = {}
info: dict[str, object] = {'engine': None, 'lang': None}

memory: dict[str, np.ndarray] = {}
warm_queue: deque[str] = deque()
warm_event = threading.Event()
live_pending = 0
live_guard = threading.Lock()


# ---------- Écoute ----------


def model_language(stt_dir: str) -> Optional[str]:
    """Langue avec laquelle le modèle d'origine transcrit (son réglage de génération), pour imposer la même au moteur rapide.

    Sans cela, le moteur rapide devinerait la langue à chaque note vocale, et pourrait en choisir une autre que celle
    avec laquelle le modèle a été affiné. Rend None si le réglage ne le dit pas : le moteur rapide devine alors.
    """
    try:
        with open(os.path.join(stt_dir, 'generation_config.json'), encoding='utf-8') as fh:
            g = json.load(fh)
    except (OSError, ValueError):
        return None
    lang_to_id = g.get('lang_to_id') or {}
    id_to_lang = {v: k for k, v in lang_to_id.items()}
    found = g.get('language')
    if not found:
        for pair in g.get('forced_decoder_ids') or []:
            if isinstance(pair, (list, tuple)) and len(pair) == 2 and pair[0] == 1 and pair[1] in id_to_lang:
                found = id_to_lang[pair[1]]
    if not isinstance(found, str):
        return None
    code = found.strip().lower().replace('<|', '').replace('|>', '')
    return code if re.fullmatch(r'[a-z]{2,3}', code) else None


def token_cap(samples: np.ndarray) -> int:
    """Plafond proportionnel à la durée : sur un son très court, ce modèle a tendance à inventer une longue phrase."""
    return min(120, int(14 * len(samples) / 16000) + 12)


def load_fast() -> Callable[[np.ndarray], str]:
    from faster_whisper import WhisperModel

    model = WhisperModel(STT_CT2_DIR, device='cpu', compute_type='int8', cpu_threads=THREADS, local_files_only=True)
    lang = STT_LANG or model_language(STT_DIR)
    info['lang'] = lang or 'devinée par le moteur'

    def transcribe(samples: np.ndarray) -> str:
        segments, _ = model.transcribe(
            samples,
            language=lang,
            task='transcribe',
            beam_size=BEAM,
            best_of=1,
            temperature=0.0,
            condition_on_previous_text=False,
            without_timestamps=True,
            vad_filter=False,
            no_repeat_ngram_size=3,
            max_new_tokens=token_cap(samples),
            # Le tri « parole ou silence » est fait avant, sur le niveau du son : le moteur ne doit pas, en plus, écarter
            # de lui-même une phrase réellement dite.
            no_speech_threshold=None,
            log_prob_threshold=None,
            compression_ratio_threshold=None,
        )
        return ' '.join(s.text.strip() for s in segments).strip()

    return transcribe


def load_original() -> Callable[[np.ndarray], str]:
    import torch
    from transformers import WhisperForConditionalGeneration, WhisperProcessor

    processor = WhisperProcessor.from_pretrained(STT_DIR)
    model = WhisperForConditionalGeneration.from_pretrained(STT_DIR)
    model.eval()
    if THREADS:
        torch.set_num_threads(THREADS)
    info['lang'] = 'celle du modèle'

    def transcribe(samples: np.ndarray) -> str:
        feats = processor(samples, sampling_rate=16000, return_tensors='pt').input_features
        with torch.no_grad():
            ids = model.generate(feats, max_new_tokens=token_cap(samples), no_repeat_ngram_size=3)
        return processor.batch_decode(ids, skip_special_tokens=True)[0].strip()

    return transcribe


def load_stt() -> None:
    global stt
    want_fast = STT_ENGINE in ('auto', 'rapide', 'ct2')
    if want_fast and os.path.isdir(STT_CT2_DIR):
        try:
            stt = load_fast()
            info['engine'] = 'rapide (CTranslate2, entiers 8 bits)'
        except Exception as e:  # noqa: BLE001 : le moteur d'origine prend le relais, et /health dit pourquoi
            errors['stt-rapide'] = f'{type(e).__name__}: {e}'[:300]
    elif STT_ENGINE in ('rapide', 'ct2'):
        errors['stt-rapide'] = f'modèle converti absent ({STT_CT2_DIR})'
    if stt is None:
        try:
            stt = load_original()
            info['engine'] = 'origine (transformers)'
        except Exception as e:  # noqa: BLE001 : l'état est rapporté par /health, le service reste utilisable pour la voix
            errors['stt'] = f'{type(e).__name__}: {e}'[:300]
    if stt is not None:
        try:
            # Premier calcul à blanc : le tout premier appel d'un modèle est toujours le plus lent.
            stt(np.zeros(16000, dtype=np.float32))
        except Exception as e:  # noqa: BLE001
            errors['stt-essai'] = f'{type(e).__name__}: {e}'[:300]


def to_16k_mono(data: bytes) -> np.ndarray:
    x, sr = sf.read(io.BytesIO(data), dtype='float32', always_2d=True)
    x = x.mean(axis=1)
    if len(x) > sr * MAX_AUDIO_S:
        raise ValueError(f'enregistrement de plus de {MAX_AUDIO_S} secondes')
    if sr != 16000:
        n = int(len(x) * 16000 / sr)
        x = np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype(np.float32)
    return x.astype(np.float32)


def clean(x: np.ndarray, sr: int = 16000) -> tuple[np.ndarray, bool]:
    """Prépare un enregistrement pour l'écoute. Rend (son, silence).

    - Parole repérée par le niveau de tranches de 30 ms, comparé au bruit de fond de l'enregistrement lui-même.
    - Sans parole (moins d'un quart de seconde au-dessus du bruit) : `silence` est vrai et rien ne doit être transcrit.
    - Sinon : silences du début et de la fin retirés (une marge est gardée), niveau remonté si la voix est faible
      (un téléphone tenu loin de la bouche), sans jamais saturer.
    """
    frame = int(0.03 * sr)
    n = len(x) // frame
    if n < 4:
        return x, True
    x = x - float(np.mean(x))
    rms = np.sqrt(np.mean(x[: n * frame].reshape(n, frame) ** 2, axis=1))
    floor = float(np.percentile(rms, 10))
    threshold = max(0.004, 3.0 * floor, 0.12 * float(rms.max()))
    voiced = np.nonzero(rms > threshold)[0]
    if len(voiced) * 0.03 < 0.25:
        return x, True
    if not TRIM:
        return x, False
    start = max(0, int(voiced[0]) * frame - int(0.25 * sr))
    end = min(len(x), (int(voiced[-1]) + 1) * frame + int(0.35 * sr))
    y = x[start:end]
    peak = float(np.max(np.abs(y)))
    if 0 < peak < 0.5:
        y = y * min(20.0, 0.9 / peak)
    return y.astype(np.float32), False


# ---------- Voix ----------


def cache_path(sentence: str) -> Optional[str]:
    if CACHE_DIR.lower() == 'off':
        return None
    key = hashlib.sha1(f'{VOICE_VERSION}|{sentence}'.encode('utf-8')).hexdigest()
    return os.path.join(CACHE_DIR, f'{key}.npy')


def cached(sentence: str) -> Optional[np.ndarray]:
    hit = memory.get(sentence)
    if hit is not None:
        return hit
    p = cache_path(sentence)
    if p and os.path.isfile(p):
        try:
            a = np.load(p, allow_pickle=False).astype(np.float32)
        except (OSError, ValueError):
            return None
        memory[sentence] = a
        return a
    return None


def remember(sentence: str, audio: np.ndarray) -> None:
    if len(memory) > 2000:
        memory.clear()
    memory[sentence] = audio
    p = cache_path(sentence)
    if not p:
        return
    try:
        os.makedirs(os.path.dirname(p), exist_ok=True)
        tmp = f'{p}.{threading.get_ident()}.tmp'
        with open(tmp, 'wb') as fh:
            np.save(fh, audio.astype(np.float32), allow_pickle=False)
        os.replace(tmp, p)
    except OSError:
        pass  # disque indisponible : la phrase reste en mémoire pour cette exécution


def sentences(text: str) -> list[str]:
    return [s.strip() for s in re.split(r'(?<=[.!?])\s+', text) if s.strip()]


def sentence_audio(sentence: str) -> np.ndarray:
    """Une phrase : relue depuis la mémoire ou le disque, sinon calculée (sous le verrou) puis gardée."""
    hit = cached(sentence)
    if hit is not None:
        return hit
    if synth is None:
        raise RuntimeError('voix indisponible')
    with lock:
        hit = cached(sentence)  # une autre demande a pu la calculer pendant l'attente
        if hit is not None:
            return hit
        audio = np.asarray(synth(sentence), dtype=np.float32).reshape(-1)
    remember(sentence, audio)
    return audio


def speak(text: str) -> np.ndarray:
    """Phrase par phrase : une phrase fixe déjà prononcée n'est pas recalculée, et elle est toujours dite de la même façon."""
    pause = np.zeros(int(0.3 * TTS_RATE), dtype=np.float32)
    out: list[np.ndarray] = []
    for s in sentences(text):
        out.extend([sentence_audio(s), pause])
    return np.concatenate(out[:-1]) if out else np.zeros(0, dtype=np.float32)


def load_tts() -> None:
    global synth
    try:
        from africa_tts import AfricaTTS

        engine = AfricaTTS.load(TTS_DIR, download=False)
        synth = lambda sentence: engine.generate(sentence, lang='bci', codeswitch=False)  # noqa: E731
    except Exception as e:  # noqa: BLE001
        errors['tts'] = f'{type(e).__name__}: {e}'[:300]


def warm_worker() -> None:
    """Prépare les phrases demandées par /warm, une à la fois, en laissant toujours passer une demande en direct."""
    while True:
        warm_event.wait()
        while True:
            try:
                s = warm_queue.popleft()
            except IndexError:
                warm_event.clear()
                break
            while live_pending > 0:
                time.sleep(0.05)
            try:
                sentence_audio(s)
            except Exception as e:  # noqa: BLE001 : une phrase qui échoue n'arrête pas la préparation des autres
                errors['tts-preparation'] = f'{type(e).__name__}: {e}'[:300]


def load() -> None:
    load_stt()
    load_tts()


# ---------- HTTP ----------


class Handler(BaseHTTPRequestHandler):
    server_version = 'SentinelleBaoule/2'

    def log_message(self, *_args) -> None:  # ni son, ni texte, ni adresse dans un journal
        return

    def reply(self, status: int, body: bytes, ctype: str, extra: Optional[dict[str, str]] = None) -> None:
        self.send_response(status)
        self.send_header('content-type', ctype)
        self.send_header('content-length', str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def json(self, status: int, obj: dict) -> None:
        self.reply(status, json.dumps(obj, ensure_ascii=False).encode('utf-8'), 'application/json; charset=utf-8')

    def do_GET(self) -> None:  # noqa: N802
        if self.path != '/health':
            return self.json(404, {'error': 'inconnu'})
        self.json(200, {'stt': stt is not None, 'tts': synth is not None, 'errors': errors, 'engine': info['engine'], 'lang': info['lang'], 'cached': len(memory), 'warming': len(warm_queue)})

    def do_POST(self) -> None:  # noqa: N802
        global live_pending
        n = int(self.headers.get('content-length') or 0)
        if n <= 0 or n > MAX_BODY:
            return self.json(413, {'error': 'corps absent ou trop gros'})
        body = self.rfile.read(n)
        t0 = time.time()
        try:
            if self.path == '/warm':
                texts = json.loads(body.decode('utf-8')).get('texts', [])
                if synth is None:
                    return self.json(503, {'error': errors.get('tts', 'voix indisponible')})
                queued = 0
                for text in texts[:MAX_WARM] if isinstance(texts, list) else []:
                    if not isinstance(text, str) or len(text) > MAX_TEXT:
                        continue
                    for s in sentences(text):
                        if cached(s) is None and s not in warm_queue and len(warm_queue) < MAX_WARM * 4:
                            warm_queue.append(s)
                            queued += 1
                if queued:
                    warm_event.set()
                return self.json(200, {'queued': queued, 'warming': len(warm_queue)})
            if self.path not in ('/stt', '/tts'):
                return self.json(404, {'error': 'inconnu'})
            with live_guard:
                live_pending += 1
            try:
                if self.path == '/stt':
                    if stt is None:
                        return self.json(503, {'error': errors.get('stt', 'écoute indisponible')})
                    raw = to_16k_mono(body)
                    samples, silence = clean(raw)
                    text = ''
                    if not silence:
                        with lock:
                            text = stt(samples)
                    return self.json(200, {'text': text, 'silence': silence, 'audioSeconds': round(len(raw) / 16000, 2), 'computeSeconds': round(time.time() - t0, 2), 'engine': info['engine']})
                if synth is None:
                    return self.json(503, {'error': errors.get('tts', 'voix indisponible')})
                text = str(json.loads(body.decode('utf-8')).get('text', '')).strip()
                if not text or len(text) > MAX_TEXT:
                    return self.json(400, {'error': 'texte absent ou trop long'})
                audio = speak(text)
                buf = io.BytesIO()
                sf.write(buf, audio, TTS_RATE, format='WAV', subtype='PCM_16')
                return self.reply(200, buf.getvalue(), 'audio/wav', {'x-compute-seconds': str(round(time.time() - t0, 2))})
            finally:
                with live_guard:
                    live_pending -= 1
        except Exception as e:  # noqa: BLE001
            return self.json(400, {'error': f'{type(e).__name__}: {e}'[:300]})


def serve(port: int = PORT) -> ThreadingHTTPServer:
    threading.Thread(target=warm_worker, daemon=True).start()
    return ThreadingHTTPServer(('127.0.0.1', port), Handler)


if __name__ == '__main__':
    t = time.time()
    load()
    print(f'parole baoulé : écoute {"prête, moteur " + str(info["engine"]) if stt else "INDISPONIBLE"}, voix {"prête" if synth else "INDISPONIBLE"} ({time.time() - t:.0f} s) ; http://127.0.0.1:{PORT}', flush=True)
    for k, v in errors.items():
        print(f'  {k} : {v}', file=sys.stderr, flush=True)
    serve().serve_forever()
