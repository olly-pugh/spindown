// Everything there is to unlock and earn in Spindown World: rider tiers, kit, bikes, power-ups,
// achievements and challenges. Plain data so it can be tested and shown in menus.

/** Bot rider tiers by sustainable power-to-weight (W/kg at roughly FTP). */
export const TIERS = [
  { id: 'rookie', name: 'Rookie', short: 'R', color: '#9aa4ad', wkg: [1.6, 2.2] },
  { id: 'club', name: 'Club', short: 'C', color: '#34c759', wkg: [2.2, 2.8] },
  { id: 'sportive', name: 'Sportive', short: 'S', color: '#0a84ff', wkg: [2.8, 3.4] },
  { id: 'racer', name: 'Racer', short: 'Ra', color: '#ff9f0a', wkg: [3.4, 4.1] },
  { id: 'elite', name: 'Elite', short: 'E', color: '#ff453a', wkg: [4.1, 4.9] },
  { id: 'pro', name: 'Pro', short: 'P', color: '#bf5af2', wkg: [4.9, 5.8] },
];

export function tierFor(wkg) {
  for (let i = TIERS.length - 1; i >= 0; i--) if (wkg >= TIERS[i].wkg[0]) return TIERS[i];
  return TIERS[0];
}

/**
 * Jerseys: body, sleeves and accent colours, plus a pattern drawn by the rider model
 * (plain | band | stripes | hoops | sash | dots | halves).
 */
export const JERSEYS = [
  { id: 'classic', name: 'Spindown Classic', level: 1, body: '#1d7f46', sleeve: '#145a32', accent: '#ffffff', pattern: 'band' },
  { id: 'white-rose', name: 'White Rose', level: 2, body: '#f4f4f0', sleeve: '#1f3c88', accent: '#f5c400', pattern: 'band' },
  { id: 'minster', name: 'Minster Stone', level: 3, body: '#d8c7a0', sleeve: '#6e5b3a', accent: '#3b2f1c', pattern: 'hoops' },
  { id: 'dales', name: 'Dales Green', level: 4, body: '#4f7d3a', sleeve: '#2f4d22', accent: '#e9dfc4', pattern: 'sash' },
  { id: 'pillar-box', name: 'Pillar Box', level: 6, body: '#d0021b', sleeve: '#111111', accent: '#ffd400', pattern: 'band' },
  { id: 'tea-time', name: 'Tea Time', level: 8, body: '#8a5a2b', sleeve: '#f1e6d2', accent: '#ffffff', pattern: 'halves' },
  { id: 'racing-green', name: 'Racing Green', level: 10, body: '#00422b', sleeve: '#00422b', accent: '#c9a227', pattern: 'stripes' },
  { id: 'climber', name: 'Climber Spots', level: 12, body: '#ffffff', sleeve: '#ffffff', accent: '#e10600', pattern: 'dots' },
  { id: 'heather', name: 'Moorland Heather', level: 14, body: '#7b4b94', sleeve: '#4a2d5a', accent: '#c7b8d6', pattern: 'hoops' },
  { id: 'midnight', name: 'Midnight', level: 17, body: '#0d1b2a', sleeve: '#0d1b2a', accent: '#5bc0eb', pattern: 'stripes' },
  { id: 'sunset', name: 'Sunset Fade', level: 20, body: '#ff7b25', sleeve: '#c81d77', accent: '#ffd23f', pattern: 'halves' },
  { id: 'laurel', name: 'Laurel (race winner)', level: 1, achievement: 'race-win', body: '#f7f3e3', sleeve: '#1d5c2e', accent: '#d4af37', pattern: 'sash' },
  { id: 'gold', name: 'Gold Standard', level: 30, body: '#d4af37', sleeve: '#8c6d1f', accent: '#111111', pattern: 'band' },
];

export const HELMETS = [
  { id: 'basic', name: 'Road Lid', level: 1, color: '#f2f2f2', aero: 1.0 },
  { id: 'black', name: 'Stealth', level: 2, color: '#1c1c1e', aero: 1.0 },
  { id: 'red', name: 'Post Box', level: 5, color: '#d0021b', aero: 1.0 },
  { id: 'aero', name: 'Aero Shell', level: 9, color: '#ffd400', aero: 0.98 },
  { id: 'green', name: 'Racing Green', level: 13, color: '#00422b', aero: 0.98 },
  { id: 'gold', name: 'Gold Aero', level: 25, color: '#d4af37', aero: 0.97 },
];

/**
 * Bikes. mass in kg; cda and crr are multipliers on the rider default. Each bike has a perk that changes how
 * power-ups work or gives one at the start of a race.
 */
export const BIKES = [
  { id: 'tourer', name: 'Steel Tourer', level: 1, color: '#2b5f8a', mass: 10.5, cda: 1.03, crr: 1.05, cobbles: 0.75,
    perk: { id: 'pannier', name: 'Panniers', text: 'Carry two power-ups at once. Smoother on cobbles.' } },
  { id: 'sportive', name: 'Dales Sportive', level: 3, color: '#b03a2e', mass: 8.6, cda: 1.0, crr: 1.0,
    perk: { id: 'longlife', name: 'Long Haul', text: 'Power-ups last 30% longer.' } },
  { id: 'climber', name: 'Fell Climber', level: 7, color: '#e8e8e8', mass: 6.9, cda: 1.0, crr: 1.0,
    perk: { id: 'start-hillhopper', name: 'Mountain Goat', text: 'Start every race with a Hill Hopper.' } },
  { id: 'aero', name: 'Ouse Aero', level: 11, color: '#111111', mass: 7.9, cda: 0.93, crr: 1.0,
    perk: { id: 'draft', name: 'Wheel Sucker', text: 'Drafting saves 15% more.' } },
  { id: 'gravel', name: 'Moor Gravel', level: 15, color: '#6b8e23', mass: 9.1, cda: 1.02, crr: 1.0, cobbles: 0.55,
    perk: { id: 'magnet', name: 'Magnet', text: 'Collect power-ups from further across the road.' } },
  { id: 'sprinter', name: 'Minster Sprinter', level: 19, color: '#d0021b', mass: 7.4, cda: 0.95, crr: 0.98,
    perk: { id: 'start-brew', name: 'Fast Start', text: 'Start every race with a Builder\'s Brew.' } },
  { id: 'gold', name: 'Gold Edition', level: 28, color: '#d4af37', mass: 6.8, cda: 0.92, crr: 0.97,
    perk: { id: 'lucky', name: 'Lucky', text: 'Rarer power-ups turn up more often.' } },
];

export const WHEELS = [
  { id: 'training', name: 'Training Alloy', level: 1, mass: 1.95, cda: 1.0, depth: 0.02 },
  { id: 'climbing', name: 'Light Climbing', level: 5, mass: 1.35, cda: 1.0, depth: 0.025 },
  { id: 'deep45', name: 'Deep 45', level: 8, mass: 1.55, cda: 0.975, depth: 0.045 },
  { id: 'deep65', name: 'Deep 65', level: 16, mass: 1.7, cda: 0.96, depth: 0.065 },
  { id: 'gold', name: 'Gold Deep 55', level: 26, mass: 1.4, cda: 0.965, depth: 0.055 },
];

export const ITEMS = { jersey: JERSEYS, helmet: HELMETS, bike: BIKES, wheels: WHEELS };

/** Power-ups picked up on the road. effect multipliers apply to physics while active. */
export const POWERUPS = [
  { id: 'tailwind', name: 'Tailwind', icon: '🍃', color: '#7fdbff', duration: 20, effect: { cda: 0.72 }, rarity: 1,
    text: 'A gust at your back: 28% less drag for 20 s.' },
  { id: 'hillhopper', name: 'Hill Hopper', icon: '🪶', color: '#ffffff', duration: 20, effect: { mass: -8 }, rarity: 1,
    text: '8 kg lighter for 20 s. Best on a climb.' },
  { id: 'slipstream', name: 'Slipstream', icon: '🌀', color: '#b18cff', duration: 30, effect: { draft: 1.5 }, rarity: 1,
    text: 'Drafting saves 50% more for 30 s.' },
  { id: 'brew', name: "Builder's Brew", icon: '☕', color: '#c8833a', duration: 12, effect: { power: 1.1 }, rarity: 2,
    text: 'A proper cuppa: 10% more power for 12 s.' },
  { id: 'umbrella', name: 'Brolly', icon: '☂️', color: '#ffd400', duration: 25, effect: { shield: true }, rarity: 2,
    text: 'Nobody can draft off you for 25 s.' },
];

/** Achievements. `xp` is awarded once. */
export const ACHIEVEMENTS = [
  { id: 'first-km', name: 'First Pedal', text: 'Ride your first kilometre.', xp: 50 },
  { id: 'ten-km', name: 'Getting Going', text: 'Ride 10 km in total.', xp: 100 },
  { id: 'hundred-km', name: 'Century', text: 'Ride 100 km in total.', xp: 400 },
  { id: 'thousand-km', name: 'Mile Muncher', text: 'Ride 1,000 km in total.', xp: 1500 },
  { id: 'hour', name: 'Power Hour', text: 'Ride for an hour in one go.', xp: 300 },
  { id: 'everest-lite', name: 'Fell Runner', text: 'Climb 1,000 m in total.', xp: 300 },
  { id: 'speed-50', name: 'Half Ton', text: 'Hit 50 km/h.', xp: 100 },
  { id: 'speed-65', name: 'Ton Up', text: 'Hit 65 km/h.', xp: 250 },
  { id: 'york-lap', name: 'Minster Tour', text: 'Ride a full lap of York.', xp: 150 },
  { id: 'dales-lap', name: 'Dales Explorer', text: 'Ride a full lap of the Dales.', xp: 200 },
  { id: 'race-finish', name: 'Race Day', text: 'Finish a race.', xp: 150 },
  { id: 'race-podium', name: 'Podium', text: 'Finish a race in the top three.', xp: 300 },
  { id: 'race-win', name: 'Winner', text: 'Win a race. Unlocks the Laurel jersey.', xp: 500 },
  { id: 'gold-zone', name: 'Speed Demon', text: 'Earn gold in a speed zone.', xp: 200 },
  { id: 'gold-kom', name: 'King of the Fell', text: 'Earn gold on a climb.', xp: 250 },
  { id: 'all-zones', name: 'Full House', text: 'Earn a medal in every zone on a route.', xp: 300 },
  { id: 'draft-5', name: 'Wheel Sucker', text: 'Spend 5 minutes drafting.', xp: 150 },
  { id: 'powerups-10', name: 'Collector', text: 'Use 10 power-ups.', xp: 150 },
  { id: 'pr', name: 'Personal Best', text: 'Set a new PR on a segment.', xp: 100 },
  { id: 'ghost', name: 'Ghost Buster', text: 'Beat your own ghost to the line.', xp: 200 },
  { id: 'overtake-50', name: 'Through the Field', text: 'Overtake 50 riders.', xp: 200 },
  { id: 'level-10', name: 'Regular', text: 'Reach level 10.', xp: 0 },
  { id: 'level-20', name: 'Veteran', text: 'Reach level 20.', xp: 0 },
  { id: 'level-30', name: 'Legend', text: 'Reach level 30.', xp: 0 },
  { id: 'early-bird', name: 'Early Bird', text: 'Ride before 7 am.', xp: 100 },
  { id: 'streak-3', name: 'Habit', text: 'Ride on three days in a row.', xp: 250 },
];

/**
 * Challenges: three are active at a time; finishing one replaces it. `metric` is what counts, `goal` how much.
 */
export const CHALLENGES = [
  { id: 'ride-10', name: 'Ride 10 km', metric: 'distance', goal: 10000, xp: 250 },
  { id: 'ride-25', name: 'Ride 25 km', metric: 'distance', goal: 25000, xp: 500 },
  { id: 'climb-150', name: 'Climb 150 m', metric: 'climb', goal: 150, xp: 250 },
  { id: 'climb-400', name: 'Climb 400 m', metric: 'climb', goal: 400, xp: 500 },
  { id: 'powerups-3', name: 'Use 3 power-ups', metric: 'powerupsUsed', goal: 3, xp: 200 },
  { id: 'draft-3', name: 'Draft for 3 minutes', metric: 'draftTime', goal: 180, xp: 200 },
  { id: 'medals-3', name: 'Win 3 zone medals', metric: 'medals', goal: 3, xp: 300 },
  { id: 'overtake-15', name: 'Overtake 15 riders', metric: 'overtakes', goal: 15, xp: 250 },
  { id: 'race-1', name: 'Finish a race', metric: 'races', goal: 1, xp: 400 },
  { id: 'time-30', name: 'Ride for 30 minutes', metric: 'time', goal: 1800, xp: 300 },
];

/** XP needed to reach level n (level 1 at 0 XP). Gentle at first: level 2 after about 20 km. */
export function xpForLevel(n) {
  if (n <= 1) return 0;
  return Math.round((500 * (n - 1) ** 1.45) / 10) * 10;
}

export const MAX_LEVEL = 30;

export function levelFor(xp) {
  let n = 1;
  while (n < MAX_LEVEL && xp >= xpForLevel(n + 1)) n++;
  return n;
}

/** XP rates while riding. */
export const XP_RATES = {
  perKm: 20,
  perMinute: 2,
  perMetreClimbed: 0.5,
  medal: { bronze: 25, silver: 50, gold: 100 },
  pr: 50,
  race: { finish: 150, place: [400, 250, 150] },
};

/**
 * The regulars: named riders who fill most of every ride and race. `tier` is where they ride in free ride;
 * in races the field is set around your level, but Og Pog is always the strongest rider there.
 */
export const REGULARS = [
  { name: 'Og Pog', tier: 'pro', mass: 70, fastest: true },
  { name: 'Pootle', tier: 'rookie', mass: 74 },
  { name: 'Tashtotstical', tier: 'sportive', mass: 72 },
  { name: 'Eggy', tier: 'club', mass: 78 },
  { name: 'Moggis', tier: 'club', mass: 66 },
  { name: 'Bippy', tier: 'sportive', mass: 63 },
  { name: 'Wheezy', tier: 'rookie', mass: 84 },
  { name: 'Big Al', tier: 'racer', mass: 102 },
  { name: 'Ness Noss', tier: 'sportive', mass: 69 },
  { name: 'Grandma', tier: 'elite', mass: 61 },
  { name: 'The Big One', tier: 'club', mass: 118 },
  { name: 'Mark Lightfoot', tier: 'elite', mass: 60 },
  { name: 'Stone Thrower', tier: 'racer', mass: 81 },
  { name: 'Wot Worrit', tier: 'club', mass: 76 },
  { name: 'N**i Terry', tier: 'sportive', mass: 88 },
  { name: 'Bobby Davro', tier: 'club', mass: 80 },
  { name: 'Taggart', tier: 'racer', mass: 79 },
  { name: 'Magnum PI', tier: 'sportive', mass: 85 },
];

export const BOT_FIRST = ['Alf', 'Bea', 'Cyril', 'Dot', 'Ernie', 'Flo', 'Gerald', 'Hattie', 'Ivor', 'Joan', 'Ken', 'Lil', 'Mavis', 'Norm',
  'Olive', 'Percy', 'Queenie', 'Reg', 'Sid', 'Thelma', 'Una', 'Vic', 'Winnie', 'Wilf', 'Yvonne', 'Arthur', 'Edith', 'Stan', 'Mabel', 'Bert',
  'Priya', 'Tomasz', 'Aisha', 'Kofi', 'Mei', 'Dev', 'Niamh', 'Rhys', 'Ewan', 'Sofia'];
export const BOT_LAST = ['Ackroyd', 'Bairstow', 'Cawthorne', 'Dawson', 'Ellerby', 'Fawcett', 'Gaunt', 'Holroyd', 'Illingworth', 'Jagger',
  'Kitching', 'Lister', 'Metcalfe', 'Nettleton', 'Oldroyd', 'Pickersgill', 'Rawnsley', 'Sowerby', 'Thackray', 'Umpleby', 'Varley', 'Waddington',
  'Wainwright', 'Yeadon', 'Booth', 'Hirst', 'Whiteley', 'Sutcliffe'];
