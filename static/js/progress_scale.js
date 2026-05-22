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

  global.ProgressScale = {
    clamp,
    computeProgressPct,
    classifyProgress,
  };
})(window);
