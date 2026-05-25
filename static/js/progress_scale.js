// Shared Progress scale helper (used by index.js and test.js)
// Progress is computed as (output / goal) * 100.
// Scale:
// - ok:   pct >= 100
// - warn: pct >= 50
// - bad:  pct < 50

(function (global) {
  'use strict';

  function clamp(n, min, max) {
    const x = Number.isFinite(n) ? n : 0;
    return Math.min(max, Math.max(min, x));
  }

  function computeProgressPct(output, goal) {
    const outN = Number(output) || 0;
    const goalN = Number(goal) || 0;
    if (goalN > 0) return (outN / goalN) * 100;
    return 0;
  }

  function classifyProgress(pct, output, goal) {
    const outN = Number(output) || 0;
    const goalN = Number(goal) || 0;

    if (goalN <= 0 && outN <= 0) return '';
    if (pct >= 100) return 'is-ok';
  if (pct >= 50) return 'is-warn';
    return 'is-bad';
  }

  // Gradual color scale for progress fill (keeps labels/classes unchanged).
  // 0%   -> red (h=0)
  // 50%  -> orange (h=30)
  // 100% -> green (h=120)
  function progressHue(pct) {
    const p = clamp(Number(pct) || 0, 0, 100);
    if (p <= 50) return (p / 50) * 30; // 0..30
    return 30 + ((p - 50) / 50) * 90;  // 30..120
  }

  function fillGradientCss(pct) {
    const h = progressHue(pct);
    // Slightly glossy gradient like iOS progress bars.
    const c1 = `hsl(${h} 85% 45%)`;
    const c2 = `hsl(${h} 90% 70%)`;
    return `linear-gradient(90deg, ${c1}, ${c2})`;
  }

  global.ProgressScale = {
    clamp,
    computeProgressPct,
    classifyProgress,
  fillGradientCss,
  };
})(window);
