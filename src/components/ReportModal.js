import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { X, Award, DollarSign, BarChart2, TrendingDown, Cpu, RotateCcw, Sliders, RefreshCw, Image as ImageIcon, Box, Plus, Maximize2, Minimize2, ChevronDown, ChevronUp } from 'lucide-react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, useGLTF, Environment } from '@react-three/drei';
import * as THREE from 'three';
import VehicleCanvas from './VehicleCanvas';
import { fetchVinAuditImages } from '../utils/vinAuditImages';
import ModelFeedbackButton from './ModelFeedbackButton';

// Local error boundary so a GLB load failure doesn't kill the report
// modal (or worse, the whole app). When the GLTFLoader throws — usually
// because a Tripo URL expired, hit CORS, or returned a malformed model
// — we swap in the procedural VehicleCanvas fallback so the user still
// sees a 3D silhouette and can keep using the rest of the report.
class ModelErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { errored: false };
  }
  static getDerivedStateFromError() {
    return { errored: true };
  }
  componentDidCatch(error) {
    // eslint-disable-next-line no-console
    console.warn('[3d] GLB load failed, falling back to procedural', error?.message || error);
  }
  componentDidUpdate(prevProps) {
    // Reset the boundary when the URL/swatch changes — gives a fresh
    // model a chance to succeed even if the previous one failed.
    if (this.state.errored && prevProps.children !== this.props.children) {
      this.setState({ errored: false });
    }
  }
  render() {
    if (this.state.errored) return this.props.fallback;
    return this.props.children;
  }
}

const fmt = (n, prefix = '') => {
  if (n == null) return '—';
  if (typeof n === 'string') return n;
  return prefix + n.toLocaleString();
};
const fmtPct = n => n == null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;

function VerdictBadge({ rating, large }) {
  const cls = { Great: 'verdict-great', Good: 'verdict-good', Fair: 'verdict-fair', Bad: 'verdict-bad' }[rating] || 'verdict-gray';
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full font-bold ${cls} ${large ? 'px-5 py-2 text-base' : 'px-3 py-1 text-sm'}`}>
      <Award size={large ? 16 : 14} />
      {rating} Deal
    </span>
  );
}

function MetricCard({ m }) {
  const colors = { green: '#1a7a45', orange: '#b7550c', red: '#c0392b', gray: 'var(--color-muted)' };
  return (
    <div className="rounded-xl p-4" style={{ background: 'var(--color-bg)', border: '1px solid var(--color-border)' }}>
      <div className="text-xl font-bold" style={{ color: colors[m.color] || colors.gray }}>{m.value}</div>
      <div className="text-xs font-semibold uppercase tracking-wider mt-1" style={{ color: 'var(--color-muted)' }}>{m.label}</div>
      {m.sub && <div className="text-xs mt-1" style={{ color: 'var(--color-muted)' }}>{m.sub}</div>}
    </div>
  );
}

function Section({ icon, title, children }) {
  return (
    <div className="rounded-xl p-4" style={{ background: 'var(--color-bg)', border: '1px solid var(--color-border)' }}>
      <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider mb-3" style={{ color: 'var(--color-muted)' }}>
        {icon} {title}
      </h3>
      {children}
    </div>
  );
}

function Row({ label, value, color }) {
  return (
    <div className="flex justify-between text-sm py-1" style={{ borderBottom: '1px solid var(--color-border)' }}>
      <span style={{ color: 'var(--color-muted)' }}>{label}</span>
      <span style={{ color: color || 'var(--color-text)', fontWeight: 600 }}>{value}</span>
    </div>
  );
}

// ─── Body color swatches ──────────────────────────────────────────────────────
// 8 presets that span the typical paint range. `metalness` and `roughness` are
// tuned per-color so light colors still look like paint and not plastic.
// "id" is the only thing persisted to URL/state; everything else is presentation.
const BODY_COLORS = [
  { id: 'white',  label: 'White',  hex: '#eef0f2', metalness: 0.35, roughness: 0.45 },
  { id: 'silver', label: 'Silver', hex: '#b8bdc4', metalness: 0.85, roughness: 0.30 },
  { id: 'grey',   label: 'Grey',   hex: '#5a5e63', metalness: 0.60, roughness: 0.40 },
  { id: 'black',  label: 'Black',  hex: '#1a1a1c', metalness: 0.55, roughness: 0.30 },
  { id: 'red',    label: 'Red',    hex: '#b8211c', metalness: 0.50, roughness: 0.35 },
  { id: 'blue',   label: 'Blue',   hex: '#1d3a8a', metalness: 0.50, roughness: 0.35 },
  { id: 'green',  label: 'Green',  hex: '#1e5c3a', metalness: 0.50, roughness: 0.35 },
  { id: 'yellow', label: 'Yellow', hex: '#d9a300', metalness: 0.40, roughness: 0.40 },
];

// Map a CARFAX/VIN-decoded color string to one of our preset IDs. Best effort.
function inferColorIdFromVehicle(vehicle) {
  const c = (vehicle?.color || '').toLowerCase();
  if (!c) return null;
  if (/white|pearl|ivory/.test(c)) return 'white';
  if (/silver|alumin/.test(c)) return 'silver';
  if (/black|onyx|obsidian/.test(c)) return 'black';
  if (/grey|gray|graphite|gunmetal|charcoal/.test(c)) return 'grey';
  if (/red|crimson|scarlet|maroon|burgundy/.test(c)) return 'red';
  if (/blue|navy|cobalt|azure|sapphire/.test(c)) return 'blue';
  if (/green|emerald|forest|olive/.test(c)) return 'green';
  if (/yellow|gold|amber/.test(c)) return 'yellow';
  return null;
}

// Tripo3D returns a single merged mesh with one material — there are no
// "body" vs "wheel" submeshes to look up by name. So instead of trying to
// detect parts via mesh names (which always finds nothing), we tint per
// PIXEL via shader injection.
//
// Tripo bakes lighting/highlights/shadows into albedo, which means body
// paint pixels often have substantial saturation (not pure grayscale).
// Gating on low-saturation excludes most of the body. Instead we exclude
// only the things that obviously shouldn't repaint:
//
//   - Pure-hue accents (taillight red, indicator amber)  → very high sat
//   - Tires / rubber / dark cavities                      → very low lum
//   - Chrome / headlight covers / specular hot spots      → very high lum
//
// Everything in between is treated as body paint and re-hued. The blend
// REPLACES the hue with the swatch and reuses the original luminance for
// shading — so a black car going to red still looks red (not black-times-
// red ≈ black) but keeps panel highlights and crease shadows.
function buildBodyTintCompiler(swatch) {
  const tintColor = new THREE.Color(swatch.hex);
  return (shader) => {
    shader.uniforms.uBodyTint = { value: tintColor };
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec3 uBodyTint;`
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        {
          vec3 _albedo = diffuseColor.rgb;
          float _maxC = max(max(_albedo.r, _albedo.g), _albedo.b);
          float _minC = min(min(_albedo.r, _albedo.g), _albedo.b);
          float _sat = (_maxC > 0.001) ? (_maxC - _minC) / _maxC : 0.0;
          float _lum = dot(_albedo, vec3(0.299, 0.587, 0.114));

          // Exclude pure-hue accent lights/badges — body paint with baked
          // lighting tops out around sat 0.7, taillight red is ~0.95+.
          float _isAccent = smoothstep(0.78, 0.92, _sat);
          // Exclude tires, rubber, dark grille cavities.
          float _isDark   = 1.0 - smoothstep(0.03, 0.10, _lum);
          // Exclude specular highlights, chrome, headlight covers.
          float _isBright = smoothstep(0.88, 0.98, _lum);

          float _mask = (1.0 - _isAccent) * (1.0 - _isDark) * (1.0 - _isBright);

          // Re-hue: project luminance onto the swatch, then bias up so a
          // dark base doesn't crush the new color into near-black. The
          // 0.18..0.95 floor/ceiling preserves shading without flattening.
          float _shading = clamp(_lum * 1.4 + 0.18, 0.18, 0.95);
          vec3 _retinted = uBodyTint * _shading;
          diffuseColor.rgb = mix(_albedo, _retinted, _mask);
        }`
      );
  };
}

function applyBodyColor(scene, swatch) {
  if (!scene || !swatch) return;
  const compiler = buildBodyTintCompiler(swatch);

  scene.traverse((obj) => {
    if (!obj.isMesh || !obj.material) return;

    // Cache the original material(s) once so subsequent retints always start
    // from the source — no compounding tints if the user picks several swatches.
    if (!obj.userData.__originalMat) {
      obj.userData.__originalMat = Array.isArray(obj.material)
        ? obj.material.map((m) => m.clone())
        : obj.material.clone();
    }

    const apply = (origMat) => {
      // Skip transparent materials entirely (windows, glass, headlight covers).
      if (origMat.transparent || (origMat.opacity != null && origMat.opacity < 0.9)) {
        return origMat.clone();
      }
      const next = origMat.clone();
      next.onBeforeCompile = compiler;
      // Force shader recompile — Three.js caches by program key, and changing
      // onBeforeCompile alone won't trigger a rebuild without this flag.
      next.customProgramCacheKey = () => `body-tint-${swatch.id}`;
      if ('metalness' in next) next.metalness = swatch.metalness;
      if ('roughness' in next) next.roughness = swatch.roughness;
      next.needsUpdate = true;
      return next;
    };

    obj.material = Array.isArray(obj.userData.__originalMat)
      ? obj.userData.__originalMat.map(apply)
      : apply(obj.userData.__originalMat);
  });
}

// GLB model renderer with dynamic camera fitting.
//
// Two problems a static camera/scale couldn't solve:
//
//   1. Tripo3D output scales vary wildly (0.5 to 5 world units). A fixed
//      `scale={1.2}` renders some cars huge and others tiny.
//   2. The panel is taller than wide and cars are wider than tall — the
//      model's "fill" is bounded by horizontal viewport at most rotations
//      but vertical at others (during auto-rotate). A static camera distance
//      either crops or under-fills depending on the angle.
//
// Solution: measure the model's bounding box and compute the camera distance
// that fits the worst-case projected size into the panel. OrbitControls'
// target is pinned to the body's actual center (not a hardcoded y) so the
// model stays centered regardless of its height.
//
// Also resets the scene's transform on each mount because useGLTF returns a
// globally cached scene — a previous mount may have left scale/position
// modified, which would corrupt the bounding box measurement.
function GLBScene({ url, swatch }) {
  const { scene } = useGLTF(url);
  const { camera, size: viewport } = useThree();
  const [orbitTarget, setOrbitTarget] = useState(() => [0, 0, 0]);

  useLayoutEffect(() => {
    if (!viewport.width || !viewport.height) return;

    // Reset transforms in case this scene was previously mounted and scaled.
    scene.position.set(0, 0, 0);
    scene.scale.setScalar(1);
    scene.updateMatrixWorld(true);

    // 1. Measure the unscaled model.
    const rawBox = new THREE.Box3().setFromObject(scene);
    const rawSize = rawBox.getSize(new THREE.Vector3());
    const rawCenter = rawBox.getCenter(new THREE.Vector3());
    const maxDim = Math.max(rawSize.x, rawSize.y, rawSize.z) || 1;

    // 2. Normalize to a 4-unit reference so the camera fit math is stable.
    const fit = 4.0 / maxDim;
    scene.scale.setScalar(fit);
    scene.position.set(
      -rawCenter.x * fit,
      -rawBox.min.y * fit,   // bottom touches y=0 so the car sits on the ground
      -rawCenter.z * fit,
    );
    scene.updateMatrixWorld(true);

    // 3. Re-measure after normalization for the camera-fit step.
    const fittedBox = new THREE.Box3().setFromObject(scene);
    const fittedSize = fittedBox.getSize(new THREE.Vector3());
    const fittedCenter = fittedBox.getCenter(new THREE.Vector3());

    // 4. Compute the camera distance that fits the panel.
    //
    //    Worst-case width during a y-axis rotation = max(x, z). At any
    //    rotation the projected silhouette is bounded by this value.
    //    Vertical extent doesn't change during y-rotation.
    //
    //    fitRatio < 1 means the model fills more (tighter) — 0.85 leaves a
    //    small margin so wheels and bumpers don't kiss the panel edges
    //    during full rotation.
    const aspect = viewport.width / viewport.height;
    const fov = (camera.fov * Math.PI) / 180;
    const fitRatio = 0.85;
    const projWidth = Math.max(fittedSize.x, fittedSize.z);
    const projHeight = fittedSize.y;
    const distH = projHeight / fitRatio / (2 * Math.tan(fov / 2));
    const distW = projWidth / fitRatio / (2 * Math.tan(fov / 2) * aspect);
    const distance = Math.max(distH, distW);

    // 5. Place camera at a 3/4 angle and look at the body center.
    const dir = new THREE.Vector3(0.55, 0.4, 0.75).normalize();
    camera.position.set(
      fittedCenter.x + dir.x * distance,
      fittedCenter.y + dir.y * distance,
      fittedCenter.z + dir.z * distance,
    );
    camera.lookAt(fittedCenter);
    camera.near = Math.max(0.1, distance / 100);
    camera.far = distance * 100;
    camera.updateProjectionMatrix();

    // 6. Drive OrbitControls' orbit point off the body center so auto-rotate
    //    spins around the car, not above or below it.
    setOrbitTarget([fittedCenter.x, fittedCenter.y, fittedCenter.z]);
  }, [scene, camera, viewport.width, viewport.height]);

  useEffect(() => {
    if (swatch) applyBodyColor(scene, swatch);
  }, [scene, swatch]);

  return (
    <>
      <ambientLight intensity={0.8} />
      <directionalLight position={[5, 8, 5]} intensity={1.3} />
      <directionalLight position={[-5, 3, -3]} intensity={0.4} color="#88aaff" />
      <primitive object={scene} />
      <OrbitControls
        autoRotate
        autoRotateSpeed={1.5}
        enableZoom
        zoomSpeed={0.6}
        minDistance={1.5}
        maxDistance={30}
        maxPolarAngle={Math.PI / 2}
        target={orbitTarget}
      />
      <Environment preset="city" />
    </>
  );
}

// Small probe inside <Canvas> that hands a screenshot-capture function
// back up to the parent via a ref. Lives inside the Three fiber tree so
// it can read the renderer (gl) — the parent ModelFeedbackButton can
// then take a JPEG of the current viewport at submit time.
//
// Requires the parent <Canvas> to be created with preserveDrawingBuffer
// set (otherwise gl.domElement.toDataURL returns an empty image).
function CanvasCaptureProbe({ captureRef }) {
  const { gl } = useThree();
  useEffect(() => {
    if (!captureRef) return undefined;
    captureRef.current = () => {
      try {
        // Force one render-into-the-back-buffer so the captured frame is
        // up-to-date (autoRotate means the buffer is in flux). Then read.
        return gl.domElement.toDataURL('image/jpeg', 0.82);
      } catch {
        return null;
      }
    };
    return () => {
      if (captureRef.current) captureRef.current = null;
    };
  }, [gl, captureRef]);
  return null;
}

function ColorSwatchRow({ activeId, onSelect }) {
  return (
    <div
      className="absolute left-0 right-0 flex items-center justify-center gap-2 px-4"
      style={{ bottom: 152, zIndex: 5 }}
    >
      <div
        className="flex items-center gap-1.5 px-3 py-2 rounded-full"
        style={{
          background: 'var(--color-bg)',
          border: '1px solid var(--color-border)',
          backdropFilter: 'blur(10px)',
        }}
      >
        {BODY_COLORS.map(c => {
          const active = c.id === activeId;
          return (
            <button
              key={c.id}
              onClick={() => onSelect(c.id)}
              title={c.label}
              aria-label={`Color: ${c.label}`}
              className="rounded-full transition-all"
              style={{
                width: 22,
                height: 22,
                background: c.hex,
                border: active
                  ? '2px solid var(--color-accent)'
                  : '1px solid var(--color-border)',
                boxShadow: active ? '0 0 0 2px var(--color-surface)' : 'none',
                transform: active ? 'scale(1.15)' : 'scale(1)',
                cursor: 'pointer',
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

// Derive a Three.js-compatible bodyStyle string from the vehicle report.
// Falls back to 'coupe' so the S5 always renders correctly by default.
function inferBodyStyle(vehicle) {
  if (!vehicle) return 'coupe';
  const model = (vehicle.model || '').toLowerCase();
  const trim  = (vehicle.trim  || '').toLowerCase();
  const combined = model + ' ' + trim;
  if (/suv|crossover|cx|rx|gx|x5|q7|q8|q5|explorer|pilot|tahoe|suburban|rav4|cr-v|tucson|santa fe/.test(combined)) return 'suv';
  if (/truck|pickup|f-150|silverado|tundra|tacoma|ranger|ram 1/.test(combined)) return 'suv'; // close enough
  if (/coupe|convertible|s5|s4|s3|m4|m2|c63|amg|gt|911|corvette|mustang|camaro|challenger/.test(combined)) return 'coupe';
  return 'sedan';
}

// ─── Interactive financing calculator ────────────────────────────────────────
// Lets the user tweak price / down / APR / term and see monthly, total interest,
// and total cost recalc live. Seeded from the AI report; "Reset" restores it.

function calcMonthly(principal, aprPct, months) {
  if (!(principal > 0) || !(months > 0)) return 0;
  const r = (aprPct || 0) / 100 / 12;
  if (r === 0) return principal / months;
  const pow = Math.pow(1 + r, months);
  return (principal * r * pow) / (pow - 1);
}

const TERM_PRESETS = [36, 48, 60, 72, 84];

function NumberField({ label, value, onChange, prefix, suffix, step = 1, min = 0, max }) {
  return (
    <label className="block">
      <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-muted)' }}>{label}</span>
      <div
        className="mt-1 flex items-center rounded-lg overflow-hidden focus-within:ring-2 focus-within:ring-blue-500"
        style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
      >
        {prefix && <span className="pl-2.5 text-sm" style={{ color: 'var(--color-muted)' }}>{prefix}</span>}
        <input
          type="number"
          inputMode="decimal"
          value={Number.isFinite(value) ? value : ''}
          step={step}
          min={min}
          max={max}
          onChange={(e) => {
            const v = e.target.value;
            onChange(v === '' ? 0 : parseFloat(v));
          }}
          className="w-full bg-transparent px-2 py-1.5 text-sm outline-none"
          style={{ color: 'var(--color-text)' }}
        />
        {suffix && <span className="pr-2.5 text-sm" style={{ color: 'var(--color-muted)' }}>{suffix}</span>}
      </div>
    </label>
  );
}

function FinancingEditor({ financing, pricing, onConfirmEdits, isReanalyzing }) {
  // Seed values from the AI report. Fall back sensibly if missing.
  const seed = useMemo(() => ({
    price: pricing?.askingPrice ?? financing?.totalCost ?? 0,
    downPayment: financing?.downPayment ?? 0,
    apr: financing?.apr ?? 0,
    termMonths: financing?.termMonths ?? 60,
  }), [pricing, financing]);

  const [price, setPrice] = useState(seed.price);
  const [downPayment, setDownPayment] = useState(seed.downPayment);
  const [apr, setApr] = useState(seed.apr);
  const [termMonths, setTermMonths] = useState(seed.termMonths);

  // Re-seed when a new report is opened.
  useEffect(() => {
    setPrice(seed.price);
    setDownPayment(seed.downPayment);
    setApr(seed.apr);
    setTermMonths(seed.termMonths);
  }, [seed]);

  const principal = Math.max(0, (price || 0) - (downPayment || 0));
  const monthly = calcMonthly(principal, apr, termMonths);
  const totalPaid = monthly * termMonths;
  const totalInterest = Math.max(0, totalPaid - principal);
  const totalCost = totalPaid + (downPayment || 0);

  const edited =
    price !== seed.price ||
    downPayment !== seed.downPayment ||
    apr !== seed.apr ||
    termMonths !== seed.termMonths;

  const reset = () => {
    setPrice(seed.price);
    setDownPayment(seed.downPayment);
    setApr(seed.apr);
    setTermMonths(seed.termMonths);
  };

  return (
    <div className="rounded-xl p-4" style={{ background: 'var(--color-bg)', border: '1px solid var(--color-border)' }}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--color-muted)' }}>
          <BarChart2 size={13} /> Financing
          <span className="ml-1 inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full" style={{ background: 'var(--color-surface)', color: 'var(--color-muted)', border: '1px solid var(--color-border)' }}>
            <Sliders size={9} /> Interactive
          </span>
        </h3>
        {edited && (
          <button
            onClick={reset}
            className="flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-lg transition-all hover:opacity-80"
            style={{ color: 'var(--color-muted)', border: '1px solid var(--color-border)' }}
          >
            <RotateCcw size={11} /> Reset
          </button>
        )}
      </div>

      {/* Inputs */}
      <div className="grid grid-cols-2 gap-2.5 mb-3">
        <NumberField label="Sale Price" prefix="$" step={100} value={price} onChange={setPrice} />
        <NumberField label="Down Payment" prefix="$" step={100} value={downPayment} onChange={setDownPayment} max={price} />
        <NumberField label="APR" suffix="%" step={0.1} min={0} max={30} value={apr} onChange={setApr} />
        <div>
          <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-muted)' }}>Term</span>
          <div className="mt-1 flex gap-1">
            {TERM_PRESETS.map((t) => {
              const active = termMonths === t;
              return (
                <button
                  key={t}
                  onClick={() => setTermMonths(t)}
                  className="flex-1 py-1.5 rounded-lg text-xs font-semibold transition-all"
                  style={{
                    background: active ? '#2563eb' : 'var(--color-surface)',
                    color: active ? '#fff' : 'var(--color-muted)',
                    border: active ? '1px solid #2563eb' : '1px solid var(--color-border)',
                  }}
                >
                  {t}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Computed results */}
      <div className="grid grid-cols-3 gap-2 pt-3" style={{ borderTop: '1px solid var(--color-border)' }}>
        <div className="rounded-lg p-2.5 text-center" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
          <div className="text-base font-bold" style={{ color: 'var(--color-text)' }}>${Math.round(monthly).toLocaleString()}</div>
          <div className="text-[10px] font-semibold uppercase tracking-wider mt-0.5" style={{ color: 'var(--color-muted)' }}>Monthly</div>
        </div>
        <div className="rounded-lg p-2.5 text-center" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
          <div className="text-base font-bold" style={{ color: totalInterest > 0 ? '#b7550c' : 'var(--color-text)' }}>${Math.round(totalInterest).toLocaleString()}</div>
          <div className="text-[10px] font-semibold uppercase tracking-wider mt-0.5" style={{ color: 'var(--color-muted)' }}>Interest</div>
        </div>
        <div className="rounded-lg p-2.5 text-center" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
          <div className="text-base font-bold" style={{ color: 'var(--color-text)' }}>${Math.round(totalCost).toLocaleString()}</div>
          <div className="text-[10px] font-semibold uppercase tracking-wider mt-0.5" style={{ color: 'var(--color-muted)' }}>Total Cost</div>
        </div>
      </div>

      {edited && (
        <div className="mt-3 pt-3 flex items-center justify-between gap-3" style={{ borderTop: '1px solid var(--color-border)' }}>
          <p className="text-[11px] italic flex-1" style={{ color: 'var(--color-muted)' }}>
            Custom scenario — AI rating not yet updated.
          </p>
          {onConfirmEdits && (
            <button
              onClick={() => onConfirmEdits({ price, downPayment, apr, termMonths, monthly, totalInterest, totalCost })}
              disabled={isReanalyzing}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed transition-all whitespace-nowrap"
            >
              <RefreshCw size={12} className={isReanalyzing ? 'animate-spin' : ''} />
              {isReanalyzing ? 'Re-analyzing…' : 'Re-analyze with these numbers'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Car Images panel ────────────────────────────────────────────────────────
// Shown when the "Car Images" tab is active. Combines:
//   - userImages: data-URL-encoded photos the user uploaded for this analysis
//   - vinAuditImages: stock photos pulled by VIN (currently stubbed; returns
//                     [] until VinAudit API access lands)
// Click any tile to open the lightbox.
function CarImagesPanel({ userImages, vehicle }) {
  const [vinImages, setVinImages] = useState([]);
  const [loadingVin, setLoadingVin] = useState(false);
  // Track the open tile by INDEX (not src) so ←/→ keys can navigate through
  // the full list. null = lightbox closed.
  const [lightboxIndex, setLightboxIndex] = useState(null);

  useEffect(() => {
    let abort = false;
    const vin = vehicle?.vin;
    if (!vin) return;
    // Skip the paid VinAudit lookup ($1/call) when the user already
    // supplied their own photos. Their photos are more accurate (actual
    // color, trim, condition) and the stock image adds little. If the L2
    // Firestore cache happens to have an entry, the in-memory map still
    // makes it free to fetch — but we don't want to pay for fresh calls.
    if (Array.isArray(userImages) && userImages.length > 0) return;
    setLoadingVin(true);
    // Pass the parsed vehicle so the cache hits by year-make-model when
    // available (lets different trims share a single VinAudit fetch).
    fetchVinAuditImages(vin, { vehicle })
      .then((imgs) => {
        if (!abort) setVinImages(Array.isArray(imgs) ? imgs : []);
      })
      .finally(() => {
        if (!abort) setLoadingVin(false);
      });
    return () => { abort = true; };
    // We intentionally key on the specific vehicle identifier fields,
    // NOT the whole vehicle object (which is a new reference each render
    // and would re-fire the effect for no real reason).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicle?.vin, vehicle?.year, vehicle?.make, vehicle?.model, userImages?.length]);

  const tiles = useMemo(() => {
    const out = [];
    for (const img of userImages || []) {
      if (img?.dataUrl) out.push({ src: img.dataUrl, label: img.name || 'Uploaded photo', source: 'user' });
    }
    for (const img of vinImages) {
      if (img?.url) out.push({ src: img.url, label: 'VinAudit stock photo', source: 'vinaudit' });
    }
    return out;
  }, [userImages, vinImages]);

  // Keyboard navigation while the lightbox is open.
  // Esc → close. ← / → → cycle. The handler is registered only when an
  // index is selected so it doesn't intercept keys outside lightbox mode.
  useEffect(() => {
    if (lightboxIndex == null) return;
    const handler = (e) => {
      if (tiles.length === 0) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        // The parent ReportModal also has a window-level Escape handler
        // (registered in bubble phase). Without stopImmediatePropagation
        // here, pressing Escape closes BOTH the lightbox AND the modal in
        // one keystroke. We register in capture phase + stop immediately
        // so the modal's listener never sees the event.
        e.stopImmediatePropagation();
        setLightboxIndex(null);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setLightboxIndex((i) => (i == null ? 0 : (i + 1) % tiles.length));
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setLightboxIndex((i) => (i == null ? 0 : (i - 1 + tiles.length) % tiles.length));
      }
    };
    // Capture phase: fires before the bubble-phase modal handler.
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [lightboxIndex, tiles.length]);

  const empty = tiles.length === 0 && !loadingVin;

  return (
    <div
      className="absolute inset-0 overflow-y-auto"
      style={{
        padding: 12,
        // Clear the floating ViewTabs pill (sits at top: 12, ~36px tall).
        // The extra ~24px gives visual breathing room between the tab row
        // and the first image.
        paddingTop: 72,
        // Reserve bottom space for the vehicle-info gradient overlay so the
        // first image's lower edge isn't permanently hidden behind it.
        paddingBottom: 200,
      }}
    >
      {empty ? (
        <div className="h-full flex flex-col items-center justify-center text-center px-6" style={{ minHeight: '60%' }}>
          <ImageIcon size={36} style={{ color: 'var(--color-muted)', opacity: 0.5 }} />
          <div className="text-sm mt-3 font-semibold" style={{ color: 'var(--color-text)' }}>
            No photos available
          </div>
          <div className="text-xs mt-1 max-w-xs" style={{ color: 'var(--color-muted)' }}>
            Upload one or more vehicle photos with your CARFAX, or VinAudit
            will surface a stock photo for this trim if one is available.
          </div>
        </div>
      ) : (
        // Stack images vertically, full panel width, 4:3 aspect. Scrolls
        // when there are more photos than fit. The first photo's lower
        // edge clears the vehicle-info gradient (handled by paddingBottom
        // above), so the whole car is visible above the fade.
        <div className="flex flex-col gap-2">
          {tiles.map((t, i) => (
            <button
              key={i}
              onClick={() => setLightboxIndex(i)}
              title={t.label}
              className="relative rounded-xl overflow-hidden transition-transform hover:scale-[1.01]"
              style={{
                width: '100%',
                aspectRatio: '4 / 3',
                border: '1px solid var(--color-border)',
                background: 'var(--color-bg)',
                padding: 0,
                cursor: 'zoom-in',
              }}
            >
              <img
                src={t.src}
                alt={t.label}
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
              />
              {t.source === 'vinaudit' && (
                <span
                  className="absolute top-2 left-2 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full"
                  style={{ background: 'rgba(0,0,0,0.7)', color: '#fff' }}
                >
                  VinAudit
                </span>
              )}
            </button>
          ))}
          {loadingVin && (
            <div
              className="rounded-xl flex items-center justify-center text-xs"
              style={{
                width: '100%',
                aspectRatio: '4 / 3',
                border: '1px dashed var(--color-border)',
                color: 'var(--color-muted)',
              }}
            >
              Loading VinAudit photos…
            </div>
          )}
        </div>
      )}

      {lightboxIndex != null && tiles[lightboxIndex] && (
        <div
          onClick={() => setLightboxIndex(null)}
          className="fixed inset-0 z-[70] flex items-center justify-center cursor-zoom-out"
          style={{ background: 'rgba(0,0,0,0.9)', backdropFilter: 'blur(8px)' }}
        >
          <img
            src={tiles[lightboxIndex].src}
            alt={tiles[lightboxIndex].label}
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: '92vw', maxHeight: '88vh', objectFit: 'contain', borderRadius: 12, cursor: 'default' }}
          />
          {/* Counter pill */}
          {tiles.length > 1 && (
            <div
              className="absolute bottom-6 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full text-xs font-semibold"
              style={{ background: 'rgba(255,255,255,0.15)', color: '#fff', backdropFilter: 'blur(8px)' }}
            >
              {lightboxIndex + 1} / {tiles.length}
            </div>
          )}
          {/* Prev/Next arrows — only when there is more than one tile */}
          {tiles.length > 1 && (
            <>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setLightboxIndex((i) => (i - 1 + tiles.length) % tiles.length);
                }}
                aria-label="Previous image"
                className="absolute left-6 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full flex items-center justify-center text-2xl transition-all hover:scale-110"
                style={{ background: 'rgba(255,255,255,0.15)', color: '#fff', border: 'none', cursor: 'pointer', backdropFilter: 'blur(8px)' }}
              >
                ‹
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setLightboxIndex((i) => (i + 1) % tiles.length);
                }}
                aria-label="Next image"
                className="absolute right-6 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full flex items-center justify-center text-2xl transition-all hover:scale-110"
                style={{ background: 'rgba(255,255,255,0.15)', color: '#fff', border: 'none', cursor: 'pointer', backdropFilter: 'blur(8px)' }}
              >
                ›
              </button>
            </>
          )}
          <div
            className="absolute top-6 right-6 text-xs font-medium px-2.5 py-1 rounded-full"
            style={{ background: 'rgba(255,255,255,0.12)', color: '#fff', backdropFilter: 'blur(8px)' }}
          >
            ← → to navigate · Esc to close
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Tab strip ───────────────────────────────────────────────────────────────
function ViewTabs({ active, onChange, modelStatus }) {
  const generating = modelStatus
    && modelStatus !== 'Done'
    && modelStatus !== 'Failed'
    && modelStatus !== 'CacheHit';
  return (
    <div
      className="absolute top-3 left-3 right-3 flex items-center gap-1 p-1 rounded-full z-10"
      style={{
        background: 'var(--color-bg)',
        border: '1px solid var(--color-border)',
        backdropFilter: 'blur(10px)',
      }}
    >
      {[
        { id: 'images', label: 'Car Images', Icon: ImageIcon },
        { id: 'model', label: '3D Model', Icon: Box },
      ].map(({ id, label, Icon }) => {
        const isActive = active === id;
        return (
          <button
            key={id}
            onClick={() => onChange(id)}
            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-all"
            style={{
              background: isActive ? 'var(--color-accent)' : 'transparent',
              color: isActive ? '#fff' : 'var(--color-muted)',
            }}
          >
            <Icon size={12} />
            {label}
            {id === 'model' && generating && (
              <span
                className="ml-1 inline-block rounded-full"
                style={{
                  width: 6,
                  height: 6,
                  background: isActive ? '#fff' : '#2563eb',
                  animation: 'pulse 1.5s ease-in-out infinite',
                }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

// Map the internal provider id to a short human label for the corner badge.
// Kept tiny — this is purely a diagnostic for the developer (and a confidence
// signal for the user that the model isn't procedural).
function formatProviderLabel(modelProvider) {
  if (!modelProvider) return null;
  switch (modelProvider) {
    case 'replicate-trellis': return 'Replicate · TRELLIS';
    case 'nvidia-trellis':    return 'NVIDIA · TRELLIS';
    case 'tripo':             return 'Tripo3D';
    default:                  return modelProvider;
  }
}

function LeftPanel({ vehicleColor, glbUrl, modelStatus, vehicle, wheelColor, activeColorId, onColorSelect, activeTab, userImages, onAddImage, captureRef }) {
  const bodyStyle = inferBodyStyle(vehicle);
  const activeSwatch = BODY_COLORS.find(c => c.id === activeColorId) || null;
  const fileInputRef = useRef(null);

  // Preflight the GLB URL with a HEAD request before handing it to
  // useGLTF. Replicate's signed CDN URLs expire ~1h after generation, and
  // when they 404 the GLTFLoader rejects asynchronously — which slips
  // past React's render-time ErrorBoundary and triggers the dev error
  // overlay. Preflighting lets us catch the failure cleanly and show the
  // procedural fallback exactly as if the GLB never existed.
  // States: null = not checked yet (treat as ok and let useGLTF try),
  // true = reachable, false = 404'd (use procedural fallback).
  const [glbReachable, setGlbReachable] = useState(null);
  useEffect(() => {
    if (!glbUrl) {
      setGlbReachable(null);
      return;
    }
    // Data URLs never 404 — skip the check.
    if (glbUrl.startsWith('data:')) {
      setGlbReachable(true);
      return;
    }
    // Replicate's CDN refuses HEAD/Range-GET cross-origin (no CORS
    // headers), so a preflight here can't tell "expired" from "blocked"
    // and would just spew console errors. Trust the upstream expiresAt
    // check + ErrorBoundary instead — they're already the real defense.
    if (/replicate\.delivery\//.test(glbUrl)) {
      setGlbReachable(true);
      return;
    }
    let abort = false;
    setGlbReachable(null);
    (async () => {
      try {
        let res;
        try {
          res = await fetch(glbUrl, { method: 'HEAD' });
        } catch {
          res = await fetch(glbUrl, { method: 'GET', headers: { Range: 'bytes=0-15' } });
        }
        if (!abort) setGlbReachable(res.ok);
      } catch {
        if (!abort) setGlbReachable(false);
      }
    })();
    return () => { abort = true; };
  }, [glbUrl]);

  const showGLB = !!glbUrl && glbReachable !== false;

  // Trigger condition for the "+ Add Image" CTA:
  //   - No GLB rendered yet
  //   - User never provided a vehicle photo (and VinAudit didn't supply one)
  //   - Model pipeline is in a terminal state — i.e. we're not actively
  //     generating right now. If we're mid-generation we want the existing
  //     "Generating 3D model…" overlay, not the CTA.
  // When all three hold, replace the procedural blocky-car fallback with a
  // click-to-upload affordance so the user can opt-in to a real Tripo3D
  // model without restarting the whole analysis.
  const isTerminalStatus =
    modelStatus === 'Done' ||
    modelStatus === 'Failed' ||
    modelStatus === 'CacheHit' ||
    modelStatus === null ||
    modelStatus === undefined;
  const showAddImageCTA =
    !showGLB &&
    isTerminalStatus &&
    (!Array.isArray(userImages) || userImages.length === 0) &&
    typeof onAddImage === 'function';

  const handlePickFile = (e) => {
    const file = e.target.files?.[0];
    // Reset the input so picking the same file twice still fires onChange.
    if (e.target) e.target.value = '';
    if (file) onAddImage(file);
  };

  // Both panels are kept mounted; we toggle visibility via display rather
  // than conditionally rendering. Mounting/unmounting the <Canvas> on every
  // tab toggle creates a fresh WebGL context each time, and Chrome caps
  // active contexts at ~8 — repeatedly toggling eventually triggers
  // "THREE.WebGLRenderer: Context Lost" as the browser force-evicts old
  // contexts. Keeping the Canvas mounted avoids this entirely.
  return (
    <>
      <div style={{ position: 'absolute', inset: 0, display: activeTab === 'images' ? 'block' : 'none' }}>
        <CarImagesPanel userImages={userImages} vehicle={vehicle} />
      </div>
    <div style={{ position: 'absolute', inset: 0, display: activeTab === 'images' ? 'none' : 'block' }}>
      {showGLB ? (
        // Tier 1 — AI-generated GLB from Tripo3D, persisted in R2 by trim.
        // Position is computed dynamically inside GLBScene per-model; only
        // the FOV survives across renders (the fit math depends on it).
        //
        // ModelErrorBoundary catches GLTF load failures (expired Tripo URL,
        // CORS block, malformed GLB) so a broken model doesn't take down
        // the rest of the report. On error, falls back to the procedural
        // VehicleCanvas so the user still sees a 3D-ish silhouette.
        <ModelErrorBoundary
          fallback={
            <VehicleCanvas
              vehicleColor={vehicleColor}
              wheelColor={wheelColor || 'gunmetal'}
              bodyStyle={bodyStyle}
            />
          }
        >
          <Canvas
            camera={{ fov: 38 }}
            style={{ background: 'transparent' }}
            // preserveDrawingBuffer keeps the rendered frame readable so
            // the feedback button can grab a screenshot via toDataURL.
            // Slight perf hit; negligible for a single-model viewer.
            gl={{ preserveDrawingBuffer: true }}
          >
            <GLBScene url={glbUrl} swatch={activeSwatch} />
            <CanvasCaptureProbe captureRef={captureRef} />
          </Canvas>
        </ModelErrorBoundary>
      ) : showAddImageCTA ? (
        // Tier 1.5 — No source image was provided AND we're not currently
        // generating, so the procedural blocky-car would be all the user
        // sees. Offer them a click-to-upload affordance instead. On click,
        // ChatInterface's handleAddImageToReport pushes the chosen file
        // through the same Tripo pipeline used for live analyses.
        <div className="absolute inset-0 flex items-center justify-center p-8">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handlePickFile}
            style={{ display: 'none' }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="group flex flex-col items-center justify-center gap-3 rounded-2xl px-8 py-10 transition-all hover:scale-[1.02]"
            style={{
              border: '2px dashed var(--color-border)',
              background: 'var(--color-bg)',
              minWidth: 280,
              cursor: 'pointer',
            }}
          >
            <div
              className="rounded-full p-3 transition-colors group-hover:bg-blue-500/10"
              style={{ background: 'var(--color-surface)' }}
            >
              <Plus size={28} style={{ color: 'var(--color-accent)' }} />
            </div>
            <div className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
              Add Image of Vehicle
            </div>
            <div
              className="text-xs text-center max-w-[240px]"
              style={{ color: 'var(--color-muted)' }}
            >
              Upload a photo to generate an interactive 3D model — takes about 1–2 minutes.
            </div>
          </button>
        </div>
      ) : (
        // Tier 2 — Pipeline procedural 3D (used when we ARE generating, so
        // the blocky fallback spins behind the loading overlay).
        <VehicleCanvas
          vehicleColor={vehicleColor}
          wheelColor={wheelColor || 'gunmetal'}
          bodyStyle={bodyStyle}
        />
      )}

      {/* Color swatches — only meaningful when a real GLB is rendered */}
      {showGLB && (
        <ColorSwatchRow activeId={activeColorId} onSelect={onColorSelect} />
      )}


      {/* When the GLB is still being generated and the user is looking at the
          3D Model tab, show a prominent centered "creating" message with the
          pulsing dots — much more visible than the small top-left pill. The
          procedural fallback continues to spin behind it.
          We treat ANY non-terminal state (including null, which happens during
          the gap between the report streaming and startRodinJob's first
          progress callback) as "still generating" so the user always sees the
          message immediately when they switch to the 3D Model tab. */}
      {!showGLB && !showAddImageCTA && (() => {
        const isTerminal =
          modelStatus === 'Done' || modelStatus === 'Failed' || modelStatus === 'CacheHit';
        const generating = !isTerminal;
        if (generating) {
          const label =
            modelStatus === 'Pending' ? 'Queued for 3D…' :
            modelStatus === 'WaitingForOther' ? 'Waiting on another generation…' :
            'Generating 3D model…';
          return (
            <>
              <div
                className="absolute inset-x-0 flex items-center justify-center pointer-events-none"
                style={{ bottom: '50%', transform: 'translateY(50%)' }}
              >
                <div
                  className="flex flex-col items-center gap-3 px-6 py-5 rounded-2xl text-center"
                  style={{
                    background: 'var(--color-surface)',
                    border: '1px solid var(--color-border)',
                    backdropFilter: 'blur(12px)',
                    boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
                    minWidth: 240,
                    animation: 'pulse 2.4s ease-in-out infinite',
                  }}
                >
                  <Cpu size={26} style={{ color: 'var(--color-accent)' }} className="animate-pulse" />
                  <div className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
                    3D model in creation
                  </div>
                  <div className="text-xs" style={{ color: 'var(--color-muted)', maxWidth: 220 }}>
                    Can take up to 2 minutes — please wait. Status: {label}
                  </div>
                  <span className="flex items-center gap-1.5 mt-1">
                    <span className="typing-dot" />
                    <span className="typing-dot" />
                    <span className="typing-dot" />
                  </span>
                </div>
              </div>
              <div
                className="absolute top-16 left-4 flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium model-loading"
                style={{ background: 'var(--color-bg)', color: 'var(--color-text)', border: '1px solid var(--color-border)', backdropFilter: 'blur(8px)' }}
              >
                <Cpu size={11} className="animate-pulse" />
                {label}
              </div>
            </>
          );
        }
        return (
          <div
            className="absolute top-16 left-4 flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold"
            style={{ background: 'var(--color-bg)', color: 'var(--color-muted)', backdropFilter: 'blur(10px)', border: '1px solid var(--color-border)' }}
          >
            <Cpu size={10} />
            Pipeline 3D · Procedural
          </div>
        );
      })()}
    </div>
    </>
  );
}

export default function ReportModal({ report, vehicleColor, vehicleLabel, imageBase64, imageMediaType, glbUrl, modelStatus, modelProvider, userImages = [], onAddImage, onClose, onConfirmEdits, isReanalyzing, layout = 'sideBySide', onChangeLayout, widthPct = 65, onChangeWidthPct, onResizingChange, sessionId = null, messageId = null }) {
  // Two presentations:
  //   'sideBySide' — anchored to the right (width = widthPct vw), no backdrop.
  //                  Chat on the left stays interactive so the user can answer
  //                  Claude's clarifying questions without dismissing the report.
  //   'full'       — full-viewport modal with blurred backdrop.
  // Default is sideBySide; user can expand to full via the header toggle.
  // The transition between modes is a single CSS width animation so the
  // modal grows/shrinks smoothly rather than snapping between two
  // position models.
  const isSide = layout === 'sideBySide';
  const [isResizing, setIsResizing] = useState(false);

  // Phone breakpoint. On a narrow screen the side-by-side layout is unusable:
  // a ~62vw panel with a 42%-wide visual pane leaves the report text about
  // 140px wide, which wraps to one word per line. Below md the modal instead
  // takes the full screen and stacks the visual above the report. Tracked in
  // JS because the width and the flex direction are driven inline, not by
  // classes that a media query could reach.
  const [isNarrow, setIsNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches,
  );

  // The report defaults to a lean view — verdict + pros/cons only — with the
  // summary paragraph and the numeric breakdowns (metrics, price, financing,
  // depreciation) tucked behind "More info". Feedback was that the full report
  // read as information overload; leading with just the decision + reasons and
  // letting the user opt into the detail fixes that without dropping anything.
  const [showMore, setShowMore] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const onChange = (e) => setIsNarrow(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Drag-resize the side-by-side modal from its left edge. The width is
  // owned by the parent (ChatInterface) so the chat's right padding can
  // track it 1:1 during the drag. We disable the CSS transition mid-drag
  // (via onResizingChange) so the cursor and edge move together.
  const startResize = (e) => {
    if (!isSide || typeof onChangeWidthPct !== 'function') return;
    e.preventDefault();
    setIsResizing(true);
    onResizingChange?.(true);
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
    const handleMove = (ev) => {
      const pct = ((window.innerWidth - ev.clientX) / window.innerWidth) * 100;
      onChangeWidthPct(pct);
    };
    const handleUp = () => {
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
      setIsResizing(false);
      onResizingChange?.(false);
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  };
  const [exiting, setExiting] = useState(false);
  const closeTimer = useRef(null);
  // Set by CanvasCaptureProbe inside <Canvas> — returns a JPEG data URL
  // of the current 3D viewport when called. Consumed by ModelFeedbackButton
  // at submit time so a "report bad render" attaches what the user saw.
  const captureRef = useRef(null);
  // Color picker state. Seeded from the CARFAX/decoded color when possible so
  // the GLB opens with a tint that matches the actual car; user can override.
  const inferredColorId = inferColorIdFromVehicle(report?.vehicle);
  const [activeColorId, setActiveColorId] = useState(inferredColorId || 'white');
  // Tab state — defaults to "Car Images" so the user sees real photos
  // immediately while the 3D model is still rendering. Toggle to "3D Model"
  // shows the GLB or the in-progress message.
  const [activeTab, setActiveTab] = useState('images');

  const handleClose = () => {
    setExiting(true);
    // Side-slide exit is slightly longer than the full-screen fade — wait
    // for whichever animation is actually playing before unmounting.
    closeTimer.current = setTimeout(onClose, layout === 'sideBySide' ? 230 : 200);
  };

  useEffect(() => () => clearTimeout(closeTimer.current), []);

  // Close on Escape
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') handleClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!report) return null;
  const { vehicle, pricing, financing, depreciation, verdict, metrics } = report;

  // Single positioning model: the modal is always anchored to the right
  // edge with width controlled by `layout` + `widthPct`. Toggling between
  // sideBySide and full just animates the width property — no class swap,
  // no remount, no snap.
  // On a phone the modal is always full-screen; the side-by-side width only
  // applies on wider viewports.
  const targetWidth = isNarrow ? '100vw' : isSide ? `${widthPct}vw` : '100vw';
  // Mount animation: slide in from the right via translateX. Once the
  // class is removed (after the animation finishes), width transitions
  // take over for any layout toggles.
  const panelClassName = `fixed top-0 bottom-0 right-0 z-50 ${
    exiting ? 'modal-side-exit' : 'modal-side-enter'
  }`;
  // Width transition is disabled mid-drag so the panel edge tracks the
  // cursor 1:1 instead of lagging behind.
  const widthTransition = isResizing
    ? 'none'
    : 'width 320ms cubic-bezier(0.22,1,0.36,1), box-shadow 280ms ease';

  return (
    <>
      {/* Backdrop layer — visible only in full mode. Fades in/out so the
          transition between layouts doesn't pop. Click-to-close lives here. */}
      <div
        className="fixed inset-0 z-40"
        style={{
          background: 'rgba(0,0,0,0.82)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          opacity: isSide || exiting ? 0 : 1,
          pointerEvents: isSide || exiting ? 'none' : 'auto',
          transition: 'opacity 280ms ease',
        }}
        onClick={() => { if (!isSide) handleClose(); }}
      />
      <div
        className={panelClassName}
        style={{
          width: targetWidth,
          background: 'var(--color-bg)',
          boxShadow: isSide ? '-12px 0 36px rgba(0,0,0,0.45)' : 'none',
          borderLeft: isSide ? '1px solid var(--color-border)' : 'none',
          transition: widthTransition,
        }}
      >
        {/* Resize handle on the left edge — only in side-by-side. A 6px hit
            zone that sits slightly outside the modal so it's easy to grab
            without occluding modal content. */}
        {isSide && !isNarrow && typeof onChangeWidthPct === 'function' && (
          <div
            onMouseDown={startResize}
            title="Drag to resize"
            className="absolute top-0 bottom-0 z-50"
            style={{
              left: -3,
              width: 6,
              cursor: 'ew-resize',
              // Subtle highlight on hover so the affordance is discoverable.
              background: isResizing ? 'rgba(59,130,246,0.35)' : 'transparent',
              transition: 'background 120ms ease',
            }}
          />
        )}
        <div
          className={`flex flex-col md:flex-row w-full h-full ${exiting ? '' : 'modal-content-enter'}`}
        >
        {/* Left: Vehicle visual — theme-aware (white in light, dark in dark).
            On a phone this becomes a top banner (full width, capped height)
            with the report scrolling beneath it, instead of a side column that
            starves the text of horizontal space. */}
        <div
          className="relative flex-shrink-0 overflow-hidden w-full md:w-[42%] h-[32vh] md:h-full"
          style={{
            background: 'var(--color-surface)',
            [isNarrow ? 'borderBottom' : 'borderRight']: '1px solid var(--color-border)',
          }}
        >
          <ViewTabs active={activeTab} onChange={setActiveTab} modelStatus={modelStatus} />

          <LeftPanel
            vehicleColor={vehicleColor}
            glbUrl={glbUrl}
            modelStatus={modelStatus}
            vehicle={vehicle}
            wheelColor="gunmetal"
            activeColorId={activeColorId}
            onColorSelect={setActiveColorId}
            activeTab={activeTab}
            userImages={userImages}
            onAddImage={onAddImage}
            captureRef={captureRef}
          />

          {/* Bottom gradient + info — theme-aware fade so text stays legible.
              Hidden on phones: the visual is only a 32vh banner there, so this
              label overlay collides with the empty-state placeholder, and every
              field it shows (year/make/model/trim/miles + verdict) is repeated
              in the report header directly beneath the banner. */}
          <div
            className="absolute bottom-0 left-0 right-0 p-6 hidden md:block"
            style={{ background: 'linear-gradient(transparent, var(--color-surface) 55%)' }}
          >
            <div className="font-bold text-xl leading-tight" style={{ color: 'var(--color-text)' }}>
              {vehicleLabel || `${vehicle?.year} ${vehicle?.make} ${vehicle?.model}`}
            </div>
            {vehicle?.trim && <div className="text-sm mt-0.5" style={{ color: 'var(--color-muted)' }}>{vehicle.trim}</div>}
            {vehicle?.mileage && <div className="text-sm mt-1" style={{ color: 'var(--color-muted)', opacity: 0.8 }}>{vehicle.mileage.toLocaleString()} miles</div>}
            <div className="mt-3">{verdict?.rating && <VerdictBadge rating={verdict.rating} large />}</div>
            <div className="flex items-end justify-between gap-2 mt-2">
              <div className="flex items-center gap-2 min-w-0">
                <p className="text-xs" style={{ color: 'var(--color-muted)', opacity: 0.7 }}>Drag to rotate · auto-spins</p>
                {/* "Report an issue" — only meaningful when we're showing
                    a real generated GLB. Hidden for the procedural
                    fallback (nothing to report on a placeholder). */}
                {glbUrl && activeTab === 'model' && (
                  <ModelFeedbackButton
                    vehicle={vehicle}
                    modelProvider={modelProvider}
                    glbUrl={glbUrl}
                    userImages={userImages}
                    sessionId={sessionId}
                    messageId={messageId}
                    captureScreenshot={() => (captureRef.current ? captureRef.current() : null)}
                  />
                )}
              </div>
              {/* Subtle provider attribution — only shown on 3D Model tab
                  with a real GLB loaded. Helps tell Tripo3D vs Replicate
                  TRELLIS output apart at a glance. */}
              {glbUrl && activeTab === 'model' && formatProviderLabel(modelProvider) && (
                <span
                  className="select-none"
                  style={{
                    fontSize: 10,
                    letterSpacing: '0.04em',
                    fontWeight: 500,
                    color: 'var(--color-muted)',
                    opacity: 0.45,
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {formatProviderLabel(modelProvider)}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Right: Report */}
        <div className="flex-1 overflow-y-auto relative" style={{ background: 'var(--color-surface)' }}>
          {/* Sticky header */}
          <div className="sticky top-0 z-10" style={{ background: 'var(--color-surface)', borderBottom: '1px solid var(--color-border)' }}>
            <div className="flex items-center justify-between px-6 py-4">
              <div>
                <h1 className="text-lg font-bold" style={{ color: 'var(--color-text)' }}>
                  {vehicle?.year} {vehicle?.make} {vehicle?.model} {vehicle?.trim}
                </h1>
                {vehicle?.vin && <p className="text-xs font-mono mt-0.5" style={{ color: 'var(--color-muted)' }}>VIN: {vehicle.vin}</p>}
              </div>
              <div className="flex items-center gap-2">
                {/* Layout toggle — flip between side-by-side (chat visible)
                    and full-screen (immersive). Hidden when there's no
                    onChangeLayout callback, e.g. embedded usage. */}
                {typeof onChangeLayout === 'function' && !isNarrow && (
                  <button
                    onClick={() => onChangeLayout(isSide ? 'full' : 'sideBySide')}
                    title={isSide ? 'Expand to full screen' : 'Collapse to side panel'}
                    aria-label={isSide ? 'Expand to full screen' : 'Collapse to side panel'}
                    className="w-9 h-9 rounded-full flex items-center justify-center transition-all hover:opacity-70"
                    style={{ background: 'var(--color-bg)', border: '1px solid var(--color-border)' }}
                  >
                    {isSide
                      ? <Maximize2 size={14} style={{ color: 'var(--color-muted)' }} />
                      : <Minimize2 size={14} style={{ color: 'var(--color-muted)' }} />
                    }
                  </button>
                )}
                <button onClick={handleClose} className="w-9 h-9 rounded-full flex items-center justify-center transition-all hover:opacity-70" style={{ background: 'var(--color-bg)', border: '1px solid var(--color-border)' }}>
                  <X size={16} style={{ color: 'var(--color-muted)' }} />
                </button>
              </div>
            </div>
            {isReanalyzing && (
              <div className="px-6 pb-3 -mt-1 flex items-center gap-2 text-xs font-medium" style={{ color: '#2563eb' }}>
                <RefreshCw size={12} className="animate-spin" />
                Re-analyzing with your updated financing terms…
              </div>
            )}
          </div>

          <div className="p-6 space-y-4">
            {/* Verdict — lean by default: rating + pros/cons only. */}
            {verdict && (
              <div className="rounded-xl p-5" style={{ background: 'var(--color-bg)', border: '1px solid var(--color-border)' }}>
                <div className="flex items-center gap-3 mb-4"><VerdictBadge rating={verdict.rating} /></div>
                {(verdict.pros?.length > 0 || verdict.cons?.length > 0) ? (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {verdict.pros?.length > 0 && (
                      <div>
                        <p className="text-xs font-bold uppercase tracking-wider mb-2" style={{ color: '#1a7a45' }}>Pros</p>
                        <ul className="space-y-1.5">
                          {verdict.pros.map((p, i) => <li key={i} className="flex gap-2 text-sm" style={{ color: 'var(--color-text)' }}><span style={{ color: '#1a7a45', flexShrink: 0 }}>+</span>{p}</li>)}
                        </ul>
                      </div>
                    )}
                    {verdict.cons?.length > 0 && (
                      <div>
                        <p className="text-xs font-bold uppercase tracking-wider mb-2" style={{ color: '#c0392b' }}>Cons</p>
                        <ul className="space-y-1.5">
                          {verdict.cons.map((c, i) => <li key={i} className="flex gap-2 text-sm" style={{ color: 'var(--color-text)' }}><span style={{ color: '#c0392b', flexShrink: 0 }}>−</span>{c}</li>)}
                        </ul>
                      </div>
                    )}
                  </div>
                ) : (
                  // No pros/cons in the report — fall back to the summary so the
                  // verdict box is never empty.
                  <p className="text-sm leading-relaxed" style={{ color: 'var(--color-text)' }}>{verdict.summary}</p>
                )}
              </div>
            )}

            {/* More info — reveals the summary + the numeric breakdowns. */}
            <button
              onClick={() => setShowMore((v) => !v)}
              aria-expanded={showMore}
              className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-xs font-semibold transition-all hover:opacity-80"
              style={{ background: 'var(--color-bg)', border: '1px solid var(--color-border)', color: 'var(--color-muted)' }}
            >
              {showMore ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              {showMore ? 'Less info' : 'More info'}
            </button>

            {showMore && (
              <div className="space-y-4">
                {verdict?.summary && (verdict.pros?.length > 0 || verdict.cons?.length > 0) && (
                  <div className="rounded-xl p-4" style={{ background: 'var(--color-bg)', border: '1px solid var(--color-border)' }}>
                    <h3 className="text-xs font-bold uppercase tracking-wider mb-2" style={{ color: 'var(--color-muted)' }}>Summary</h3>
                    <p className="text-sm leading-relaxed" style={{ color: 'var(--color-text)' }}>{verdict.summary}</p>
                  </div>
                )}

                {metrics?.length > 0 && (
                  <div>
                    <h3 className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: 'var(--color-muted)' }}>Key Metrics</h3>
                    {/* 2x2 on small screens, 1x4 on large — both layouts stay
                        visually balanced regardless of metric count. */}
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                      {metrics.slice(0, 4).map((m, i) => <MetricCard key={i} m={m} />)}
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {pricing && (
                    <Section icon={<DollarSign size={13} />} title="Price Analysis">
                      <Row label="Asking Price" value={fmt(pricing.askingPrice, '$')} />
                      <Row label="KBB Value" value={fmt(pricing.kbbValue, '$')} />
                      <Row label="Market Average" value={fmt(pricing.marketAvg, '$')} />
                      <Row label="vs. Market" value={fmtPct(pricing.priceVsMarketPct)} color={pricing.priceVsMarketPct > 5 ? '#c0392b' : pricing.priceVsMarketPct < -5 ? '#1a7a45' : '#b7550c'} />
                    </Section>
                  )}
                  {(financing || pricing) && (
                    <FinancingEditor
                      financing={financing}
                      pricing={pricing}
                      onConfirmEdits={onConfirmEdits}
                      isReanalyzing={isReanalyzing}
                    />
                  )}
                </div>

                {depreciation && (
                  <Section icon={<TrendingDown size={13} />} title="Depreciation Curve">
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1">
                      {[
                        { label: 'Annual Rate', val: depreciation.annualRatePct != null ? `${depreciation.annualRatePct}%` : '—' },
                        { label: '1 Year', val: fmt(depreciation.projectedValue1yr, '$') },
                        { label: '3 Years', val: fmt(depreciation.projectedValue3yr, '$') },
                        { label: '5 Years', val: fmt(depreciation.projectedValue5yr, '$') },
                      ].map((d, i) => (
                        <div key={i} className="rounded-lg p-3 text-center" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
                          <div className="text-base font-bold" style={{ color: 'var(--color-text)' }}>{d.val}</div>
                          <div className="text-xs mt-0.5" style={{ color: 'var(--color-muted)' }}>{d.label}</div>
                        </div>
                      ))}
                    </div>
                  </Section>
                )}

                {vehicle?.dealer && <p className="text-xs text-center pb-2" style={{ color: 'var(--color-muted)' }}>Listed by: {vehicle.dealer}</p>}
              </div>
            )}
          </div>
        </div>
      </div>
      </div>
    </>
  );
}
