// Vernier caliper reading maths. Pure functions: no DOM, no three.js.
//   N vernier divisions span (N − 1) main-scale divisions of 1 mm, so
//   least count  LC = 1 MSD − 1 VSD = 1/N mm
//   observed     R  = MSR + VSR × LC     (VSR = the vernier division that lines up with a main-scale mark)
//   corrected    = R − zero error        (zero error e = zeroDivisions × LC, signed)

export interface VernierSettings {
  /** Vernier scale divisions (10, 20 or 50). */
  divisions: number;
  /** Zero error in vernier divisions (+ when the vernier zero is right of the main zero with the jaws closed). */
  zeroDivisions: number;
}

export interface VernierReading {
  leastCount: number;
  zeroError: number;
  msr: number;
  vsr: number;
  observed: number;
  corrected: number;
}

export const MSD = 1; // mm
export const leastCount = (s: VernierSettings) => MSD / s.divisions;
export const zeroError = (s: VernierSettings) => s.zeroDivisions * leastCount(s);
/** Length of one vernier division (mm). */
export const vsd = (s: VernierSettings) => ((s.divisions - 1) * MSD) / s.divisions;

/** What the scales show when the true jaw opening is `openingMm`. */
export const indicated = (openingMm: number, s: VernierSettings) => openingMm + zeroError(s);

export function read(openingMm: number, s: VernierSettings): VernierReading {
  const lc = leastCount(s);
  const steps = Math.round(indicated(openingMm, s) / lc);
  const msr = Math.floor(steps / s.divisions) * MSD;
  const vsr = steps - (msr / MSD) * s.divisions;
  const observed = msr + vsr * lc;
  return { leastCount: lc, zeroError: zeroError(s), msr, vsr, observed, corrected: observed - zeroError(s) };
}

export const fmt = (mm: number, lc: number) => {
  const dp = Math.max(0, Math.ceil(-Math.log10(lc) - 1e-9));
  return (Math.abs(mm) < lc / 2 ? 0 : mm).toFixed(dp);
};
