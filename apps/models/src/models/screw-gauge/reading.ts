// Screw gauge (micrometer) reading maths. Pure functions: no DOM, no three.js.
// Textbook relations (SSC/HSC):
//   least count  LC = pitch / N           (N = circular scale divisions)
//   observed     R  = MSR + CSR × LC
//   corrected    = R − zero error         (zero error e = zeroDivisions × LC, signed)

export interface GaugeSettings {
  /** Pitch = 1 main-scale division the spindle advances per turn (mm). */
  pitch: number;
  /** Circular (thimble) scale divisions. */
  divisions: number;
  /** Zero error in circular-scale divisions (+ when the zero is below the datum line when closed). */
  zeroDivisions: number;
}

export interface Reading {
  leastCount: number;
  zeroError: number;
  /** Main scale reading: the last main-scale mark (step = pitch) uncovered by the thimble. */
  msr: number;
  /** Circular scale reading: the thimble division on the datum line. */
  csr: number;
  observed: number;
  corrected: number;
}

export const leastCount = (s: GaugeSettings) => s.pitch / s.divisions;
export const zeroError = (s: GaugeSettings) => s.zeroDivisions * leastCount(s);

/** What the scales show when the true gap between the faces is `gapMm`. */
export function indicated(gapMm: number, s: GaugeSettings) {
  return gapMm + zeroError(s);
}

export function read(gapMm: number, s: GaugeSettings): Reading {
  const lc = leastCount(s);
  const r = indicated(gapMm, s);
  // Snap to whole divisions (the thimble moves in steps of LC in the UI, so this only removes float noise).
  const steps = Math.round(r / lc);
  const perTurn = s.divisions;
  const turns = Math.floor(steps / perTurn);
  const csr = steps - turns * perTurn;
  const msr = turns * s.pitch;
  const observed = msr + csr * lc;
  return { leastCount: lc, zeroError: zeroError(s), msr, csr, observed, corrected: observed - zeroError(s) };
}

/** Round to the instrument's resolution for display (avoids 0.30000000000000004). */
export const fmt = (mm: number, lc: number) => {
  const dp = Math.max(0, Math.ceil(-Math.log10(lc) - 1e-9));
  return (Math.abs(mm) < lc / 2 ? 0 : mm).toFixed(dp);
};
