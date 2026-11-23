// Minimal, spec-compliant FIT writer and the FIT/TCX/CSV exporters.
// Ports of FITWriter.swift and ActivityExporter.swift.
import { ByteWriter, roundHalfAway } from './bytes.js';
import { calories, hasPositions } from './recorder.js';

export const FIT_EPOCH = 631065600; // 1989-12-31T00:00:00Z
export const PRODUCT_NAME = 'Spindown';
export const SOFTWARE_VERSION = 100; // 1.00

const T = { enumeration: 0x00, uint8: 0x02, uint16: 0x84, sint32: 0x85, uint32: 0x86, string: 0x07, uint32z: 0x8c };
const SIZE = { 0x00: 1, 0x02: 1, 0x07: 1, 0x84: 2, 0x85: 4, 0x86: 4, 0x8c: 4 };
const INVALID = { 0x00: 0xff, 0x02: 0xff, 0x84: 0xffff, 0x85: 0x7fffffff, 0x86: 0xffffffff, 0x8c: 0, 0x07: 0 };

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const field = (number, type, value, string = null, stringSize = 0) => ({ number, type, value, string, stringSize });

export const F = {
  u8: (n, v) => field(n, T.uint8, v == null ? null : clamp(v, 0, 0xfe)),
  u16: (n, v) => field(n, T.uint16, v == null ? null : clamp(v, 0, 0xfffe)),
  u32: (n, v) => field(n, T.uint32, v == null ? null : clamp(v, 0, 0xfffffffe)),
  u32z: (n, v) => field(n, T.uint32z, v >>> 0),
  s32: (n, v) => field(n, T.sint32, v == null ? null : clamp(v, -0x7fffffff, 0x7ffffffe)),
  enumeration: (n, v) => field(n, T.enumeration, v),
  text: (n, s, size = 20) => field(n, T.string, null, s, size),
};

const fieldSize = (f) => (f.type === T.string ? f.stringSize : SIZE[f.type]);

export function fitTimestamp(dateMs) {
  return clamp(Math.floor(dateMs / 1000 - FIT_EPOCH), 0, 0xffffffff);
}

const CRC_TABLE = [
  0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401,
  0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400,
];

export function fitCRC(bytes, seed = 0) {
  let crc = seed;
  for (const byte of bytes) {
    let tmp = CRC_TABLE[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[byte & 0xf];
    tmp = CRC_TABLE[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[(byte >> 4) & 0xf];
  }
  return crc;
}

/** 14-byte header, definition and data records, little-endian, CRC-16 trailer. */
export class FITWriter {
  constructor() {
    this.body = [];
    this.definitions = new Map();
    this.nextLocal = 0;
  }

  write(global, fields) {
    const signature = `${global}:` + fields.map((f) => `${f.number}/${f.type}/${fieldSize(f)}`).join(',');
    let local;
    if (this.definitions.has(signature)) {
      local = this.definitions.get(signature);
    } else {
      local = this.nextLocal;
      this.nextLocal = (this.nextLocal + 1) % 16;
      for (const [k, v] of this.definitions) if (v === local) this.definitions.delete(k);
      this.definitions.set(signature, local);
      const w = new ByteWriter();
      w.u8(0x40 | local);
      w.u8(0); // reserved
      w.u8(0); // little-endian
      w.u16(global);
      w.u8(fields.length);
      for (const f of fields) {
        w.u8(f.number);
        w.u8(fieldSize(f));
        w.u8(f.type);
      }
      this.body.push(...w.bytes);
    }

    const w = new ByteWriter();
    w.u8(local);
    for (const f of fields) {
      if (f.type === T.string) {
        const enc = Array.from(new TextEncoder().encode(f.string ?? '')).slice(0, f.stringSize - 1);
        while (enc.length < f.stringSize) enc.push(0);
        w.append(enc);
        continue;
      }
      const v = f.value ?? INVALID[f.type];
      switch (SIZE[f.type]) {
        case 1: w.u8(v); break;
        case 2: w.u16(v); break;
        default: w.u32(v);
      }
    }
    this.body.push(...w.bytes);
  }

  finish() {
    const header = new ByteWriter();
    header.u8(14);
    header.u8(0x20); // protocol 2.0
    header.u16(2160); // profile 21.60
    header.u32(this.body.length);
    header.append(Array.from('.FIT', (c) => c.charCodeAt(0)));
    header.u16(fitCRC(header.bytes));
    const file = new Uint8Array(header.bytes.length + this.body.length + 2);
    file.set(header.bytes, 0);
    file.set(this.body, header.bytes.length);
    const crc = fitCRC(file.subarray(0, file.length - 2));
    file[file.length - 2] = crc & 0xff;
    file[file.length - 1] = crc >> 8;
    return file;
  }
}

function serialFor(id) {
  const v = parseInt(String(id).replace(/-/g, '').slice(0, 8), 16) >>> 0;
  return v === 0 || Number.isNaN(v) ? 1 : v;
}

const r = roundHalfAway;
const opt = (x, f) => (x == null ? null : f(x));

/** Degrees to FIT semicircles (2^31 per 180°). */
export const semicircles = (deg) => Math.round((deg * 2 ** 31) / 180);
/** Metres to FIT altitude (scale 5, offset 500), used by altitude and enhanced_altitude. */
const fitAltitude = (m) => Math.round((m + 500) * 5);

export const SUB_SPORT = { indoorCycling: 6, virtualActivity: 58 };

/** A ride in Spindown World: a virtual ride with a GPS track on the real course. */
export const isVirtualRide = (ride) => !!ride.record.world || hasPositions(ride.track.samples);

/**
 * FIT activity. A plain ride is sport cycling / sub-sport indoor cycling, so Garmin files it as "Indoor
 * Cycling" and Strava as an indoor ride. A ride in Spindown World is sub-sport virtual activity (58), which
 * Garmin and Strava file as a Virtual Ride, and its records carry the rider's real latitude, longitude and
 * altitude on the course, so it shows on a map. `ride` = {record, track}; dates in record are ISO strings or ms.
 */
export function exportFIT(ride, tzOffsetSeconds = null) {
  const rec = ride.record;
  const s = rec.summary;
  const startMs = toMs(rec.startDate);
  const endMs = toMs(rec.endDate);
  const startTS = fitTimestamp(startMs);
  const endTS = Math.max(fitTimestamp(endMs), startTS + Math.floor(Math.max(0, s.elapsedTime)));
  const w = new FITWriter();
  const virtual = isVirtualRide(ride);
  const subSport = virtual ? SUB_SPORT.virtualActivity : SUB_SPORT.indoorCycling;
  // GPS summary of the records written (virtual rides only).
  const gps = { first: null, last: null, n: -90, s: 90, e: -180, w: 180, ascent: 0, descent: 0, lastAlt: null };

  // file_id
  w.write(0, [F.enumeration(0, 4), F.u16(1, 255), F.u16(2, 1), F.u32z(3, serialFor(rec.id)), F.u32(4, startTS), F.text(8, PRODUCT_NAME)]);

  // device_info: the creator (this app) and the trainer.
  w.write(23, [F.u32(253, startTS), F.u8(0, 0), F.u16(2, 255), F.u16(4, 1), F.u16(5, SOFTWARE_VERSION), F.text(27, PRODUCT_NAME)]);
  w.write(23, [F.u32(253, startTS), F.u8(0, 1), F.u16(2, 290), F.u16(4, 0), F.u16(5, null), F.text(27, rec.trainer?.model ?? 'inRide')]);
  const hrm = rec.trainer?.heartRateMonitor;
  if (hrm) {
    const polar = hrm.toLowerCase().includes('polar');
    w.write(23, [F.u32(253, startTS), F.u8(0, 2), F.u16(2, polar ? 123 : 255), F.u16(4, 0), F.u16(5, null), F.text(27, hrm), F.enumeration(25, 3)]);
  }

  // Timer events and records, merged in time order.
  const events = ride.track.timerEvents.map((e) => ({ t: e.t, start: e.kind === 'start' }));
  if (!(events.length && events[0].t === 0 && events[0].start)) events.unshift({ t: 0, start: true });
  let eventIndex = 0;
  let lastRecordTS = null;
  const writeEvent = (e) => {
    w.write(21, [F.u32(253, startTS + Math.floor(e.t)), F.enumeration(0, 0), F.enumeration(1, e.start ? 0 : 4), F.u8(4, 0)]);
  };

  for (const sample of ride.track.samples) {
    while (eventIndex < events.length && events[eventIndex].t <= sample.t) writeEvent(events[eventIndex++]);
    const ts = startTS + Math.max(0, r(sample.t));
    if (lastRecordTS != null && ts <= lastRecordTS) continue; // strictly increasing seconds
    lastRecordTS = ts;
    const fields = [
      F.u32(253, ts),
      F.u32(5, r(sample.distance * 100)),
      F.u16(6, opt(sample.speed, (v) => r(v * 1000))),
      F.u16(7, sample.power),
      F.u8(4, opt(sample.cadence, (v) => r(v))),
      F.u8(3, sample.heartRate),
    ];
    if (virtual) {
      const has = sample.lat != null && sample.lon != null;
      if (has) noteGPS(gps, sample);
      const alt = has && sample.alt != null ? fitAltitude(sample.alt) : null;
      fields.push(
        F.s32(0, has ? semicircles(sample.lat) : null),
        F.s32(1, has ? semicircles(sample.lon) : null),
        F.u16(2, alt),
        F.u32(78, alt),
      );
    }
    w.write(20, fields);
  }
  while (eventIndex < events.length) writeEvent(events[eventIndex++]);
  if (events.length === 0 || events[events.length - 1].start) writeEvent({ t: endTS - startTS, start: false });

  const elapsed = r(s.elapsedTime * 1000);
  const timer = r(s.timerTime * 1000);
  const moving = r(s.movingTime * 1000);
  const distance = r(s.distance * 100);
  const avgSpeed = r(s.averageSpeed * 1000);
  const maxSpeed = r(s.maxSpeed * 1000);
  const avgPower = opt(s.averagePower, r);
  const np = opt(s.normalizedPower, r);
  const avgCad = opt(s.averageCadence, r);
  const maxCad = opt(s.maxCadence, r);
  const kcal = r(calories(s));
  const avgHR = opt(s.averageHeartRate, r);
  const work = r(s.work);

  // lap
  w.write(19, [
    F.u32(253, endTS), F.enumeration(0, 9), F.enumeration(1, 1), F.u32(2, startTS),
    F.u32(7, elapsed), F.u32(8, timer), F.u32(9, distance), F.u16(11, kcal),
    F.u16(13, avgSpeed), F.u16(14, maxSpeed), F.u8(17, avgCad), F.u8(18, maxCad),
    F.u16(19, avgPower), F.u16(20, s.maxPower), F.enumeration(24, 7), F.enumeration(25, 2),
    F.u16(33, np), F.enumeration(39, subSport), F.u32(41, work), F.u32(52, moving), F.u16(254, 0),
    F.u8(15, avgHR), F.u8(16, s.maxHeartRate),
    ...(virtual ? [
      F.s32(3, opt(gps.first?.lat, semicircles)), F.s32(4, opt(gps.first?.lon, semicircles)),
      F.s32(5, opt(gps.last?.lat, semicircles)), F.s32(6, opt(gps.last?.lon, semicircles)),
      F.u16(21, gps.first ? r(gps.ascent) : null), F.u16(22, gps.first ? r(gps.descent) : null),
    ] : []),
  ]);

  // session
  w.write(18, [
    F.u32(253, endTS), F.enumeration(0, 8), F.enumeration(1, 1), F.u32(2, startTS),
    F.enumeration(5, 2), F.enumeration(6, subSport), F.u32(7, elapsed), F.u32(8, timer), F.u32(9, distance),
    F.u16(11, kcal), F.u16(14, avgSpeed), F.u16(15, maxSpeed), F.u8(18, avgCad), F.u8(19, maxCad),
    F.u16(20, avgPower), F.u16(21, s.maxPower), F.u16(25, 0), F.u16(26, 1), F.enumeration(28, 0),
    F.u16(34, np), F.u32(48, work), F.u32(59, moving), F.u16(254, 0),
    F.u8(16, avgHR), F.u8(17, s.maxHeartRate),
    ...(virtual ? [
      F.s32(3, opt(gps.first?.lat, semicircles)), F.s32(4, opt(gps.first?.lon, semicircles)),
      F.u16(22, gps.first ? r(gps.ascent) : null), F.u16(23, gps.first ? r(gps.descent) : null),
      // Bounding box: north-east and south-west corners.
      F.s32(29, gps.first ? semicircles(gps.n) : null), F.s32(30, gps.first ? semicircles(gps.e) : null),
      F.s32(31, gps.first ? semicircles(gps.s) : null), F.s32(32, gps.first ? semicircles(gps.w) : null),
    ] : []),
  ]);

  // activity
  const tz = tzOffsetSeconds ?? -new Date(endMs).getTimezoneOffset() * 60;
  w.write(34, [F.u32(253, endTS), F.u32(0, timer), F.u16(1, 1), F.enumeration(2, 0), F.enumeration(3, 26), F.enumeration(4, 1), F.u32(5, endTS + tz)]);

  return w.finish();
}

function noteGPS(g, sample) {
  if (!g.first) g.first = { lat: sample.lat, lon: sample.lon };
  g.last = { lat: sample.lat, lon: sample.lon };
  g.n = Math.max(g.n, sample.lat);
  g.s = Math.min(g.s, sample.lat);
  g.e = Math.max(g.e, sample.lon);
  g.w = Math.min(g.w, sample.lon);
  if (sample.alt != null) {
    if (g.lastAlt != null) {
      const dh = sample.alt - g.lastAlt;
      if (dh > 0) g.ascent += dh;
      else g.descent -= dh;
    }
    g.lastAlt = sample.alt;
  }
}

function toMs(d) {
  return typeof d === 'number' ? d : Date.parse(d);
}

function iso(ms) {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

const fmt = (v, places) => Number(v).toFixed(places);

export function exportTCX(ride) {
  const rec = ride.record;
  const s = rec.summary;
  const start = toMs(rec.startDate);
  let x =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2">\n` +
    `  <Activities>\n` +
    `    <Activity Sport="Biking">\n` +
    `      <Id>${iso(start)}</Id>\n` +
    `      <Lap StartTime="${iso(start)}">\n` +
    `        <TotalTimeSeconds>${fmt(s.timerTime, 1)}</TotalTimeSeconds>\n` +
    `        <DistanceMeters>${fmt(s.distance, 1)}</DistanceMeters>\n` +
    `        <MaximumSpeed>${fmt(s.maxSpeed, 3)}</MaximumSpeed>\n` +
    `        <Calories>${r(calories(s))}</Calories>\n`;
  if (s.averageHeartRate != null) x += `          <AverageHeartRateBpm><Value>${r(s.averageHeartRate)}</Value></AverageHeartRateBpm>\n`;
  if (s.maxHeartRate != null) x += `          <MaximumHeartRateBpm><Value>${s.maxHeartRate}</Value></MaximumHeartRateBpm>\n`;
  x += `          <Intensity>Active</Intensity>\n`;
  if (s.averageCadence != null) x += `          <Cadence>${r(s.averageCadence)}</Cadence>\n`;
  x += `        <TriggerMethod>Manual</TriggerMethod>\n        <Track>\n`;
  let lastSecond = -1;
  for (const sample of ride.track.samples) {
    const second = r(sample.t);
    if (!(second > lastSecond)) continue;
    lastSecond = second;
    x += `            <Trackpoint>\n`;
    x += `              <Time>${iso(start + second * 1000)}</Time>\n`;
    if (sample.lat != null && sample.lon != null) {
      x += `              <Position><LatitudeDegrees>${fmt(sample.lat, 7)}</LatitudeDegrees><LongitudeDegrees>${fmt(sample.lon, 7)}</LongitudeDegrees></Position>\n`;
      if (sample.alt != null) x += `              <AltitudeMeters>${fmt(sample.alt, 1)}</AltitudeMeters>\n`;
    }
    x += `              <DistanceMeters>${fmt(sample.distance, 2)}</DistanceMeters>\n`;
    if (sample.heartRate != null) x += `              <HeartRateBpm><Value>${sample.heartRate}</Value></HeartRateBpm>\n`;
    if (sample.cadence != null) x += `              <Cadence>${Math.min(254, r(sample.cadence))}</Cadence>\n`;
    if (sample.speed != null || sample.power != null) {
      x += `              <Extensions><ns3:TPX>`;
      if (sample.speed != null) x += `<ns3:Speed>${fmt(sample.speed, 3)}</ns3:Speed>`;
      if (sample.power != null) x += `<ns3:Watts>${sample.power}</ns3:Watts>`;
      x += `</ns3:TPX></Extensions>\n`;
    }
    x += `            </Trackpoint>\n`;
  }
  x +=
    `        </Track>\n` +
    `      </Lap>\n` +
    `      <Notes>Indoor trainer ride recorded with ${PRODUCT_NAME} (Kinetic inRide)</Notes>\n` +
    `      <Creator xsi:type="Device_t" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><Name>${PRODUCT_NAME}</Name><UnitId>0</UnitId><ProductID>0</ProductID></Creator>\n` +
    `    </Activity>\n` +
    `  </Activities>\n` +
    `</TrainingCenterDatabase>\n`;
  return new TextEncoder().encode(x);
}

export function exportCSV(ride) {
  const start = toMs(ride.record.startDate);
  let out = 'elapsed_s,timestamp_utc,power_w,speed_kph,cadence_rpm,distance_m,heart_rate_bpm\n';
  for (const s of ride.track.samples) {
    const fields = [
      fmt(s.t, 1),
      iso(start + s.t * 1000),
      s.power != null ? String(s.power) : '',
      s.speed != null ? fmt(s.speed * 3.6, 2) : '',
      s.cadence != null ? fmt(s.cadence, 1) : '',
      fmt(s.distance, 2),
      s.heartRate != null ? String(s.heartRate) : '',
    ];
    out += fields.join(',') + '\n';
  }
  return new TextEncoder().encode(out);
}

export const ExportFormats = [
  { id: 'fit', name: 'FIT (Garmin, Strava, TrainingPeaks)', ext: 'fit' },
  { id: 'tcx', name: 'TCX (Training Center XML)', ext: 'tcx' },
  { id: 'csv', name: 'CSV (spreadsheet)', ext: 'csv' },
];

export function exportRide(ride, format) {
  switch (format) {
    case 'fit': return exportFIT(ride);
    case 'tcx': return exportTCX(ride);
    case 'csv': return exportCSV(ride);
    default: throw new Error(`Unknown format ${format}`);
  }
}

export function exportFileName(ride, format) {
  const d = new Date(toMs(ride.record.startDate));
  const p = (n) => String(n).padStart(2, '0');
  return `Spindown-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.${format}`;
}
