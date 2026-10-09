// Minimal in-memory rate limiter (per-process; fine for a single Railway instance).
// Allows `perIpMax` hits per `perIpWindowMs` for each key, plus a global cap of `globalMax` per `globalWindowMs`.
export function createRateLimiter({ perIpMax, perIpWindowMs, globalMax, globalWindowMs, now = Date.now }) {
  const perIp = new Map();
  let global = [];

  const recent = (list, windowMs, t) => list.filter((ts) => t - ts < windowMs);

  /** Records a hit and returns true when allowed, false when a limit is exceeded (the hit is not recorded). */
  return function allow(key) {
    const t = now();
    global = recent(global, globalWindowMs, t);
    const hits = recent(perIp.get(key) || [], perIpWindowMs, t);
    if (hits.length >= perIpMax || global.length >= globalMax) {
      perIp.set(key, hits);
      return false;
    }
    hits.push(t);
    global.push(t);
    perIp.set(key, hits);
    // Drop idle keys so the map cannot grow without bound.
    if (perIp.size > 1000) {
      for (const [k, list] of perIp) if (recent(list, perIpWindowMs, t).length === 0) perIp.delete(k);
    }
    return true;
  };
}
