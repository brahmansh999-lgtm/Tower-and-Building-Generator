import { useEffect, useRef, useState } from 'react';
import { isVRSupported } from '../vr/VRSession.js';

/**
 * VR entry for a studio. The viewport fills `vrRef` with { enter, exit } and
 * reports presenting through `onVRChange`; the button renders only when the
 * browser supports immersive-vr.
 */
export function useVREntry() {
  const vrRef = useRef(null);
  const [supported, setSupported] = useState(false);
  const [inVR, setInVR] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    isVRSupported().then((ok) => alive && setSupported(ok));
    return () => {
      alive = false;
    };
  }, []);
  const toggle = () => {
    const vr = vrRef.current;
    if (!vr) return;
    setError('');
    if (inVR) vr.exit();
    else vr.enter().catch((e) => setError(String((e && e.message) || e).slice(0, 80)));
  };
  return { vrRef, supported, inVR, setInVR, error, toggle };
}

export default function VREnterButton({ vr }) {
  return (
    <>
      {vr.supported && (
        <button type="button" className={vr.inVR ? 'vr-btn is-on' : 'vr-btn'} onClick={vr.toggle}>
          {vr.inVR ? 'EXIT VR' : 'ENTER VR'}
        </button>
      )}
      {vr.error && <div className="vr-error">VR · {vr.error}</div>}
    </>
  );
}
