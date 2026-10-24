// The answer reveal: the rarer the answer, the further out the shot.
// Like a depth meter, the ball rolls back up the pitch while the yardage ticks
// up, then it's struck: into the top corner for a correct answer, over the bar
// for a wrong one, and off to VAR for an answer we can't verify yet.

/** Distance and commentary for each tier. Tap-in really is a tap-in. */
export const SHOTS = {
  'Tap-in':     { yards: 6,  line: 'Tapped in from six yards' },
  'Solid':      { yards: 12, line: 'Slotted home from the spot' },
  'Good Shout': { yards: 18, line: 'Curled in from the edge of the box' },
  'Proper Fan': { yards: 25, line: 'A 25-yard rocket' },
  'Deep Cut':   { yards: 35, line: 'A 35-yard screamer' },
  'Hidden Gem': { yards: 50, line: 'From the halfway line!' },
};

// Pitch geometry (matches the SVG in index.html): viewBox 100 × 135,
// 2.2 units per yard, goal line at y = 10.
const VIEW_H = 135;
const GOAL_LINE = 10;
const PER_YARD = 2.2;
const topPct = (yards) => ((GOAL_LINE + yards * PER_YARD) / VIEW_H) * 100;

const ROLL_MS = 750;
const PAUSE_MS = 120;
const STRIKE_MS = 420;
const VAR_MS = 750;

const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Play the shot. `kind` is 'goal' | 'miss' | 'var' | 'none'.
 * Calls onImpact() when the ball arrives (or straight away for 'none').
 * Returns a function that skips to the end.
 */
export function playShot({ ball, net, meter, panel }, { kind, yards = 18, onImpact }) {
  const anims = [];
  const timers = [];
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    timers.forEach(clearTimeout);
    anims.forEach((a) => a.finish());
    panel.classList.remove('var-check');
    onImpact();
  };

  const startX = 50 + (Math.random() * 30 - 15);
  const spot = { left: `${startX}%`, top: `${topPct(yards)}%` };
  ball.getAnimations().forEach((a) => a.cancel());
  panel.classList.remove('scored');
  ball.style.opacity = '1';
  meter.textContent = kind === 'goal' || kind === 'var' ? '0 yds' : '';

  if (kind === 'none' || reduceMotion()) {
    Object.assign(ball.style, kind === 'goal' || kind === 'var' ? { left: '50%', top: '5%' } : spot);
    if (kind === 'goal' || kind === 'var') meter.textContent = `${yards} yds`;
    finish();
    return finish;
  }

  // 1. Roll back from the goal line to the shooting spot, yardage ticking up.
  Object.assign(ball.style, spot);
  anims.push(ball.animate(
    [{ left: '50%', top: `${topPct(0)}%`, transform: 'translate(-50%, -50%) rotate(0deg)' },
      { left: spot.left, top: spot.top, transform: 'translate(-50%, -50%) rotate(-540deg)' }],
    { duration: ROLL_MS, easing: 'cubic-bezier(.25,.8,.35,1)', fill: 'both' },
  ));
  if (kind !== 'miss') {
    const t0 = performance.now();
    const tick = (now) => {
      if (done) return;
      const p = Math.min(1, (now - t0) / ROLL_MS);
      meter.textContent = `${Math.round(yards * (1 - (1 - p) ** 3))} yds`;
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // 2. Strike: top corner, or over the bar.
  const cornerX = startX < 50 ? 56 : 44;
  const target = kind === 'miss'
    ? { left: `${startX < 50 ? 30 : 70}%`, top: '-14%' }
    : { left: `${cornerX}%`, top: '4.5%' };
  timers.push(setTimeout(() => {
    const strike = ball.animate(
      [{ left: spot.left, top: spot.top, transform: 'translate(-50%, -50%) scale(1) rotate(0deg)', opacity: 1 },
        { offset: 0.55, transform: 'translate(-50%, -50%) scale(1.45) rotate(300deg)', opacity: 1 },
        { left: target.left, top: target.top, transform: `translate(-50%, -50%) scale(${kind === 'miss' ? 1.7 : 0.8}) rotate(620deg)`, opacity: kind === 'miss' ? 0 : 1 }],
      { duration: STRIKE_MS, easing: 'cubic-bezier(.5,0,.8,.6)', fill: 'forwards' },
    );
    anims.push(strike);
    strike.onfinish = () => {
      if (done) return;
      if (kind === 'miss') { finish(); return; }
      // 3. Net bulges.
      anims.push(net.animate(
        [{ transform: 'translateX(-50%) scale(1, 1)' }, { transform: 'translateX(-50%) scale(1.12, 1.6)' }, { transform: 'translateX(-50%) scale(1, 1)' }],
        { duration: 380, easing: 'ease-out' },
      ));
      if (navigator.vibrate) navigator.vibrate(kind === 'goal' ? [30, 40, 30] : 20);
      if (kind === 'goal') panel.classList.add('scored');
      if (kind === 'var') {
        panel.classList.add('var-check');
        timers.push(setTimeout(finish, VAR_MS));
      } else finish();
    };
  }, ROLL_MS + PAUSE_MS));

  return finish;
}
