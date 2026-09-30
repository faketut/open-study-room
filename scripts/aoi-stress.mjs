// M4 AOI stress: compares baseline (20Hz-if-changed) vs AOI-tiered publish
// rates under two synthetic room scenarios. Pure node, no dependencies,
// deterministic via seeded PRNG. Re-run with: node scripts/aoi-stress.mjs
//
// Model:
// - 100 peers on a 4000x3000 px map, 60 s virtual time, 50 ms ticks.
// - Walkers pick random waypoints and walk at 120 px/s (avatar speed); the
//   rest stay stationary.
// - Baseline (current behavior): every tick, publish if the position changed
//   since the last publish  => walkers publish ~20 Hz, stationary peers 0 Hz.
// - AOI (contract tiers): every tick, compute nearest *known* peer distance
//   (here: true positions) -> tier (NEAR<1600 -> 20Hz, MID 1600..4000 -> 5Hz,
//   FAR>4000 or no peers -> 1Hz); publish only if the tier interval has
//   elapsed *and* the position changed since the last publish (stationary
//   still 0 Hz; spawn position publishes once at t=0 in both policies).
// - 17-byte payload per publish; a published packet is fanned out by the SFU
//   to the other 99 peers.
//
// Per-client receive bytes/s = totalPublishes * 17 * 99 / 100 / 60, which is
// payload only (excludes SCTP/DTLS/IP framing overhead).

const TIER = {
  NEAR_PX: 1600,
  MID_PX: 4000,
  NEAR_HZ: 20,
  MID_HZ: 5,
  FAR_HZ: 1,
};

const MAP_W = 4000;
const MAP_H = 3000;
const PEERS = 100;
const SECONDS = 60;
const TICK_S = 0.05; // 50 ms
const TICKS = SECONDS / TICK_S;
const WALK_SPEED = 120; // px/s
const PACKET_BYTES = 17;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tierForDistance(d) {
  if (d < TIER.NEAR_PX) return "NEAR";
  if (d <= TIER.MID_PX) return "MID";
  return "FAR";
}
function hzForTier(tier) {
  return tier === "NEAR" ? TIER.NEAR_HZ : tier === "MID" ? TIER.MID_HZ : TIER.FAR_HZ;
}

// Build one scenario. walkers = count of waypoint-walking peers (rest idle).
function buildScenario(seed, walkers) {
  const rng = mulberry32(seed);
  const peers = [];
  for (let i = 0; i < PEERS; i++) {
    const walking = i < walkers;
    peers.push({
      x: rng() * MAP_W,
      y: rng() * MAP_H,
      walking,
      wx: 0,
      wy: 0,
      px: 0, // last published x
      py: 0,
      lastPublish: -Infinity,
      publishes: 0,
    });
    if (walking) pickWaypoint(peers[i], rng);
  }
  return { peers, rng };
}

function pickWaypoint(p, rng) {
  p.wx = rng() * MAP_W;
  p.wy = rng() * MAP_H;
}

function moveTick(p, rng) {
  const dx = p.wx - p.x;
  const dy = p.wy - p.y;
  const dist = Math.hypot(dx, dy);
  const step = WALK_SPEED * TICK_S;
  if (dist <= step) {
    p.x = p.wx;
    p.y = p.wy;
    pickWaypoint(p, rng);
  } else {
    p.x += (dx / dist) * step;
    p.y += (dy / dist) * step;
  }
}

function nearestDistance(self, peers) {
  let best = Infinity;
  for (const q of peers) {
    if (q === self) continue;
    const d = Math.hypot(q.x - self.x, q.y - self.y);
    if (d < best) best = d;
  }
  return best;
}

// changedSincePublish: strict float compare; a walking peer moves 6 px/tick,
// so any movement counts as changed (mirrors the UI's exact check).
function changed(p) {
  return p.x !== p.px || p.y !== p.py;
}

function simulate(seed, walkers, policy) {
  const { peers, rng } = buildScenario(seed, walkers);
  // t=0: everyone publishes their spawn position (bypass semantics).
  for (const p of peers) {
    p.px = p.x;
    p.py = p.y;
    p.lastPublish = 0;
    p.publishes = 1;
  }
  let total = peers.length;
  const tierShare = { NEAR: 0, MID: 0, FAR: 0 }; // AOI only
  for (let tick = 1; tick <= TICKS; tick++) {
    const t = tick * TICK_S;
    for (const p of peers) {
      if (p.walking) moveTick(p, rng);
      if (!changed(p)) continue; // stationary -> 0 Hz under both policies
      if (policy === "baseline") {
        p.px = p.x;
        p.py = p.y;
        p.publishes += 1;
        total += 1;
      } else {
        const tier = tierForDistance(nearestDistance(p, peers));
        const hz = hzForTier(tier);
        // 1e-9 epsilon: sim ticks land exactly on interval multiples, so raw
        // >= would skip ticks on float rounding (real UI ticks at rAF rate,
        // finer than the gate, and doesn't hit this aliasing).
        if (t - p.lastPublish >= 1 / hz - 1e-9) {
          p.px = p.x;
          p.py = p.y;
          p.lastPublish = t;
          p.publishes += 1;
          total += 1;
          tierShare[tier] += 1;
        }
      }
    }
  }
  return { total, tierShare };
}

function fmt(n) {
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function runScenario(name, seed, walkers) {
  const base = simulate(seed, walkers, "baseline");
  const aoi = simulate(seed, walkers, "aoi");
  const bytes = (pubs) => pubs * PACKET_BYTES;
  const rows = [
    ["total publishes", base.total, aoi.total],
    ["publish payload bytes/s", bytes(base.total) / SECONDS, bytes(aoi.total) / SECONDS],
    ["per-client receive bytes/s", (bytes(base.total) * (PEERS - 1)) / PEERS / SECONDS,
      (bytes(aoi.total) * (PEERS - 1)) / PEERS / SECONDS],
  ];
  console.log(`\nScenario: ${name} (${walkers} walkers / ${PEERS - walkers} stationary, ${PEERS} peers, ${SECONDS}s)`);
  console.log("| metric                        | baseline (20Hz-if-changed) | AOI tiered | delta |");
  console.log("|-------------------------------|----------------------------|------------|-------|");
  for (const [label, b, a] of rows) {
    const delta = b === 0 ? "n/a" : `${(((a - b) / b) * 100).toFixed(1)}%`;
    console.log(
      `| ${label.padEnd(29)} | ${fmt(b).padStart(26)} | ${fmt(a).padStart(10)} | ${delta.padStart(5)} |`,
    );
  }
  const ts = aoi.tierShare;
  const tsum = ts.NEAR + ts.MID + ts.FAR;
  console.log(
    `AOI publish tier mix: NEAR ${((ts.NEAR / tsum) * 100).toFixed(1)}% / ` +
    `MID ${((ts.MID / tsum) * 100).toFixed(1)}% / FAR ${((ts.FAR / tsum) * 100).toFixed(1)}%`,
  );
}

console.log("AOI publish-rate stress (deterministic; seeds fixed)");
console.log("Per-client receive = payload bytes only; excludes SCTP/DTLS/IP overhead.");
runScenario("study room", 1234, 15); // 85 stationary + 15 walking
runScenario("peak", 5678, 100);      // 100 walking
