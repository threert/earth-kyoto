// The floating origin (SPEC § 1): the local frame the renderer draws in, moved under the camera when it strays.
import { ecefToGeodetic, Frame, quatMul, type Quat, type V3 } from "./geo.ts";

export class FloatingOrigin {
  frame: Frame;
  /** Bumped at every rebase: whoever placed objects in the old frame places them again. */
  generation = 0;

  constructor(lat = 0, lon = 0) {
    this.frame = new Frame(lat, lon, 0);
  }

  /** Moves the origin under the camera if it strayed (SPEC § 1). True when it moved. */
  update(camera: V3, force = false): boolean {
    const g = ecefToGeodetic(camera[0], camera[1], camera[2]);
    const local = this.frame.point(camera);
    const sideways = Math.hypot(local[0], local[2]);
    if (!force && sideways <= Math.max(2000, Math.max(0, g.h) / 4)) return false;
    this.frame = new Frame(g.lat, g.lon, 0);
    this.generation++;
    return true;
  }

  /** Transform of an object whose vertices are relative to `center` in ECEF axes (a tile). */
  placeEcef(center: V3): { position: V3; quaternion: Quat } {
    return { position: this.frame.point(center), quaternion: this.frame.quat };
  }

  /** Transform of an object built in another frame (a place's): its axes turned into this one. */
  placeFrame(f: Frame): { position: V3; quaternion: Quat } {
    return { position: this.frame.point(f.origin), quaternion: this.frame.quatOf(f) };
  }

  /** A quaternion in ECEF axes, turned into the frame (e.g. a camera orientation kept in ECEF). */
  quat(q: Quat): Quat {
    return quatMul(this.frame.quat, q);
  }
}
