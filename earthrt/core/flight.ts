// A flight (ARCHITECTURE § 8): a fixed track along the great circle between two points, climbing to a cruise height
// and descending, timed. The camera rides it; where it looks is the user's (yaw and pitch relative to the track).
import { bearing, enu, geodeticToEcef, greatCircle, haversine, type V3 } from "./geo.ts";

export interface FlightPlan {
  from: { lat: number; lon: number; alt: number };
  to: { lat: number; lon: number; alt: number };
  /** Cruise height above the ellipsoid, m (default: 10 km, less for short hops). */
  cruise?: number;
  /** Ground speed at cruise, m/s (default 250: an airliner). Short hops are slower. */
  speed?: number;
}

export interface Pose {
  lat: number;
  lon: number;
  alt: number;
  /** ECEF position, forward along the track, and up. */
  position: V3;
  forward: V3;
  up: V3;
  /** 0..1 along the track. */
  t: number;
}

export class Flight {
  readonly plan: Required<FlightPlan>;
  readonly distance: number;
  /** Seconds from start to end. */
  readonly duration: number;

  constructor(plan: FlightPlan) {
    const d = haversine(plan.from.lat, plan.from.lon, plan.to.lat, plan.to.lon);
    const cruise = plan.cruise ?? Math.min(10_000, Math.max(1_500, d / 12));
    const speed = plan.speed ?? Math.min(250, Math.max(60, d / 120));
    this.plan = { from: plan.from, to: plan.to, cruise, speed };
    this.distance = d;
    // time: the distance at speed, plus a climb and a descent of ~90 s each scaled by the height to gain
    this.duration = d / speed + 2 * Math.min(90, cruise / 60);
  }

  /** Height along the track: an eased climb over the first fifth, cruise, an eased descent over the last fifth. */
  private altAt(t: number) {
    const { from, to, cruise } = this.plan;
    const top = Math.max(cruise, from.alt, to.alt);
    const ease = (x: number) => x * x * (3 - 2 * x);
    if (t < 0.2) return from.alt + (top - from.alt) * ease(t / 0.2);
    if (t > 0.8) return to.alt + (top - to.alt) * ease((1 - t) / 0.2);
    return top;
  }

  /** Where the camera is `seconds` after the start (clamped to the track's ends). */
  at(seconds: number): Pose {
    const s = Math.min(1, Math.max(0, seconds / this.duration));
    // the ground track moves slower near the ends (climb, descent): progress along it eased
    const t = s * s * (3 - 2 * s) * 0.3 + s * 0.7;
    const { from, to } = this.plan;
    const g = greatCircle(from.lat, from.lon, to.lat, to.lon, t);
    const alt = this.altAt(t);
    const ahead = greatCircle(from.lat, from.lon, to.lat, to.lon, Math.min(1, t + 1e-4));
    const hdg = t < 1 - 1e-4 ? bearing(g.lat, g.lon, ahead.lat, ahead.lon) : bearing(from.lat, from.lon, to.lat, to.lon);
    const { e, n, u } = enu(g.lat, g.lon);
    const h = (hdg * Math.PI) / 180;
    const fwd: V3 = [n[0] * Math.cos(h) + e[0] * Math.sin(h), n[1] * Math.cos(h) + e[1] * Math.sin(h), n[2] * Math.cos(h) + e[2] * Math.sin(h)];
    return { lat: g.lat, lon: g.lon, alt, position: geodeticToEcef(g.lat, g.lon, alt), forward: fwd, up: u, t };
  }

  /** Poses every `step` seconds over the next `horizon` seconds from `now`: what to fetch ahead of the camera. */
  lookahead(now: number, horizon = 60, step = 5): Pose[] {
    const out: Pose[] = [];
    for (let s = now + step; s <= Math.min(this.duration, now + horizon); s += step) out.push(this.at(s));
    return out;
  }
}
