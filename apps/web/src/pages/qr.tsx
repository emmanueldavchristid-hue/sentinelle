import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { go } from '../state';
import { Banner } from '../components/ui';

/** Lien encodé dans le QR : un simple raccourci vers la fiche, sans valeur de preuve d'identité. */
export const ficheUrl = (animalId: string) => `${window.location.origin}/#/animal/${encodeURIComponent(animalId)}`;

/** Extrait l'identifiant d'un QR Sentinelle ; refuse tout autre contenu (pas de navigation vers un site externe). */
export function animalIdFromQr(text: string): string | null {
  try {
    const u = new URL(text);
    if (u.origin !== window.location.origin) return null;
    const m = u.hash.match(/^#\/animal\/([^/]+)$/);
    return m ? decodeURIComponent(m[1]!) : null;
  } catch {
    return null;
  }
}

export function FicheQr({ animalId }: { animalId: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    QRCode.toDataURL(ficheUrl(animalId), { margin: 1, width: 168, color: { dark: '#1F2933', light: '#FFFFFF' } })
      .then(setSrc)
      .catch(() => setSrc(null));
  }, [animalId]);
  if (!src) return null;
  return (
    <figure className="flex items-center gap-3">
      <img src={src} width={112} height={112} alt={`QR code menant à la fiche ${animalId}`} className="rounded border border-line" />
      <figcaption className="hint max-w-56">Raccourci vers cette fiche. Le QR ne prouve pas l’identité physique de l’animal : vérifiez la boucle.</figcaption>
    </figure>
  );
}

interface Detector {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}

export function QrScan() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<'unsupported' | 'idle' | 'scanning' | 'error'>(() => ('BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia ? 'idle' : 'unsupported'));
  const [message, setMessage] = useState<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const stop = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };
  useEffect(() => stop, []);

  const start = async () => {
    setMessage(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      streamRef.current = stream;
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();
      setState('scanning');
      const Ctor = (window as unknown as { BarcodeDetector: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
      const detector = new Ctor({ formats: ['qr_code'] });
      const loop = async () => {
        if (!streamRef.current) return;
        try {
          const codes = await detector.detect(video);
          const raw = codes[0]?.rawValue;
          if (raw) {
            const id = animalIdFromQr(raw);
            if (id) {
              stop();
              go(`animal/${encodeURIComponent(id)}`);
              return;
            }
            setMessage('QR code non reconnu : ce n’est pas un raccourci Sentinelle.');
          }
        } catch {
          /* image suivante */
        }
        requestAnimationFrame(loop);
      };
      loop();
    } catch {
      stop();
      setState('error');
      setMessage('Caméra indisponible ou refusée. Utilisez la recherche manuelle.');
    }
  };

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <a href="#/animaux" className="text-sm">
        ← Recherche manuelle
      </a>
      <div className="card space-y-3 p-4">
        <h1 className="text-xl font-bold">Scanner un QR code</h1>
        <p className="hint">Le QR ouvre la fiche correspondante. Il ne prouve pas l’identité physique de l’animal : vérifiez toujours la boucle.</p>
        {state === 'unsupported' && (
          <Banner tone="warn">Ce navigateur ne permet pas la lecture de QR code (API BarcodeDetector ou caméra absente). Utilisez la recherche manuelle.</Banner>
        )}
        {state !== 'unsupported' && (
          <>
            <video ref={videoRef} className={`w-full rounded-lg bg-ink ${state === 'scanning' ? '' : 'hidden'}`} muted playsInline aria-label="Aperçu de la caméra" />
            {state !== 'scanning' ? (
              <button className="btn btn-primary" onClick={start}>
                Activer la caméra
              </button>
            ) : (
              <button
                className="btn"
                onClick={() => {
                  stop();
                  setState('idle');
                }}
              >
                Arrêter
              </button>
            )}
          </>
        )}
        <div aria-live="polite">{message && <Banner tone="warn">{message}</Banner>}</div>
      </div>
    </div>
  );
}
