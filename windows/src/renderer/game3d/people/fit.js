// The bike and how the rider sits on it, shared by the people build script (which poses the body to fit) and
// the runtime rider (bike geometry, pedalling IK). Metres; the bike points along -z, +x is the rider's right.

export const WHEEL_R = 0.336; // 700x25c
export const BB = [0, 0.268, 0];
export const REAR = [0, WHEEL_R, 0.405];
export const FRONT = [0, WHEEL_R, -0.588];
export const CRANK = 0.1725;
/** Hip joint centres (midpoint) over the saddle. */
export const HIP = [0, 1.045, 0.2];
/** Half the distance between the hip joints, and between the pedal centres (the legs track straight). */
export const LEG_X = 0.105;
export const PEDAL_X = 0.112;
/** Pedal spindle relative to the ankle joint in the foot's own frame (y up the shin, z towards the heel). */
export const PEDAL = [0, -0.098, -0.128];
/** Foot pitch (toes down, rad) as a function of the pedal angle a (0 = bottom, pi/2 = back, pi = top). */
export const footPitch = (a) => 0.24 + 0.16 * Math.sin(a) - 0.05 * Math.cos(a);
/** The pedal angle the body is modelled at: cranks level (right pedal back, left forward). */
export const BIND_CRANK = Math.PI / 2;
/** Top of the brake hood where the palm rests. */
export const HOOD = [0.205, 0.955, -0.625];
/** Saddle: top surface centre under the sit bones, nose and tail. */
export const SADDLE = [0, 0.965, 0.215];

/** Per body: where the hips, saddle top and hoods are (the seat post and stem adapt; the frame is shared). */
export const BODY = {
  m: { HIP, SADDLE, HOOD },
  f: { HIP: [0, 1.0, 0.196], SADDLE: [0, 0.922, 0.21], HOOD: [0.19, 0.93, -0.592] },
};

/** Ankle position for a crank angle (a: pedal angle for that leg) and side (1 right, -1 left). */
export function anklePosition(a, side, out = [0, 0, 0]) {
  const pz = BB[2] + Math.sin(a) * CRANK, py = BB[1] - Math.cos(a) * CRANK;
  const pitch = footPitch(a);
  // The foot frame is pitched toes-down by `pitch`, a rotation of -pitch about +x (which takes the toes, -z,
  // towards -y); the spindle is at PEDAL in that frame.
  const cs = Math.cos(pitch), sn = Math.sin(pitch);
  const dy = PEDAL[1] * cs + PEDAL[2] * sn, dz = -PEDAL[1] * sn + PEDAL[2] * cs;
  out[0] = side * PEDAL_X;
  out[1] = py - dy;
  out[2] = pz - dz;
  return out;
}
