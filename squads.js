// Current squads (2026). Builds a new player table from the game's original one: each 2006 squad member's
// record becomes a 2026 player, and the team's squad list and captain are rewritten. Runs in the page (it is
// passed in as source text by names.js) and in Node for tests, so it uses no Node or browser APIs.
//
// Player table layout (same as the community Player Editor07's "PS2 roster"): 1200 records of 360 bytes from
// offset 4, then 67 team blocks of 2808 bytes from 432004. Abilities are 6-bit values packed into little-endian
// 32-bit words; the 0-100 numbers the game shows come from the UP table.
//
// A new player starts as a copy of the existing player whose style is closest (same role, bowling type and
// batting hand, similar level), so actions and shot habits fit. Then: name, commentary name, ratings, age,
// role, batting position, bowling type and batting hand are set; career stats are cleared; nationality and face stay with the
// record (licensed real faces are swapped for a generic one from the same country).
function applySquads(orig, out, SQUADS) {
  const REC = 360, BASE = 4, PLAYERS = 1200, TEAMS = 432004, TEAM = 2808;
  const UP = [0, 2, 4, 6, 7, 8, 10, 11, 12, 14, 16, 17, 19, 21, 23, 24, 25, 26, 28, 29, 31, 32, 34, 35, 37, 38, 40, 41, 43, 44, 46,
    47, 49, 50, 52, 54, 55, 57, 59, 60, 62, 64, 65, 67, 69, 70, 72, 74, 75, 77, 79, 80, 82, 84, 86, 88, 90, 92, 94, 96, 98, 99, 100];
  const raw = (v) => { v = Math.max(20, Math.min(99, Math.round(v))); let b = 0; for (let i = 1; i < UP.length; i++) if (Math.abs(UP[i] - v) < Math.abs(UP[b] - v)) b = i; return b; };
  const u16 = (d, o) => d[o] | d[o + 1] << 8;
  const i16 = (d, o) => (u16(d, o) << 16) >> 16;
  const u32 = (d, o) => (d[o] | d[o + 1] << 8 | d[o + 2] << 16 | d[o + 3] << 24) >>> 0;
  const put16 = (d, o, v) => { d[o] = v & 255; d[o + 1] = v >> 8 & 255; };
  const put32 = (d, o, v) => { for (let k = 0; k < 4; k++) d[o + k] = v >>> (8 * k) & 255; };
  const six = (d, o, k) => Math.floor(u32(d, o) / 2 ** (6 * k)) % 64;
  const setSix = (d, o, k, v) => { const w = u32(d, o), m = 2 ** (6 * k); put32(d, o, w - six(d, o, k) * m + v * m); };
  const BAT = [[100, 0], [100, 1], [100, 2], [100, 3], [100, 4], [104, 0], [104, 1], [104, 2], [108, 1], [108, 3]];
  const BOWL = [[116, 1], [116, 2], [116, 3], [116, 4], [120, 0], [120, 1], [120, 2], [120, 3], [120, 4], [124, 0], [124, 1]];
  const TYPE = { BAT: 1, OB: 2, BWL: 3, SB: 4, ARS: 5, WK: 6, WKB: 7, OWK: 8, AR: 9, OBW: 10 };
  const BOWLT = { LS: 0, CH: 1, OS: 2, SLA: 3, LM: 4, RM: 5, LFM: 6, RFM: 7, LF: 8, RF: 9 };

  const at = (i) => BASE + i * REC;
  const byId = new Map();
  const info = [];
  for (let i = 0; i < PLAYERS; i++) {
    const s = at(i), id = i16(orig, s);
    if (!id || !orig[s + 4]) continue;
    if (!byId.has(id)) byId.set(id, i);
    info.push({ i, type: orig[s + 351] & 15, bowl: orig[s + 132] & 15, left: orig[s + 133] & 1,
      bat: UP[six(orig, s + 108, 1)], bowling: (UP[six(orig, s + 116, 1)] + UP[six(orig, s + 116, 2)]) / 2,
      nat: u32(orig, s + 216), face: u16(orig, s + 356) });
  }
  // generic faces used by a country's players, handed out in turn (so stand-ins don't all look the same)
  const faces = new Map();
  for (const p of info) if (p.face >= 40000) { const f = faces.get(p.nat) || []; if (!f.includes(p.face)) f.push(p.face); faces.set(p.nat, f); }
  let nextFace = 0;
  // Copy only from players in the 2006 international squads: their hidden values are tuned (a county keeper as
  // the model made new keepers open the batting)
  const intl = new Set();
  for (const t of SQUADS.teams) for (let k = 0; k < 20; k++) intl.add(byId.get(i16(orig, TEAMS + t.team * TEAM + 2 * k)));
  const pool = info.filter((p) => intl.has(p.i));
  const genericFace = (nat) => { const f = faces.get(nat) || [...faces.values()][0]; return f[nextFace++ % f.length]; };

  for (const team of SQUADS.teams) {
    const b = TEAMS + team.team * TEAM;
    const old = [];
    for (let k = 0; k < 20; k++) old.push(i16(orig, b + 2 * k));
    if (old.some((id) => !byId.has(id))) throw new Error(`team ${team.team}: unexpected squad`);
    team.players.forEach(([name, role, hand, bowlType, bat, bowl, dob, comm], k) => {
      const want = { type: TYPE[role], bowl: BOWLT[bowlType], left: hand === 'L' ? 1 : 0 };
      let best = null, score = -1e9;
      for (const p of pool) {
        const sc = (p.type === want.type) * 100 + (p.bowl === want.bowl) * 60 + (p.left === want.left) * 40
          - Math.abs(p.bat - bat) - Math.abs(p.bowling - bowl);
        if (sc > score) { score = sc; best = p; }
      }
      const r = at(byId.get(old[k])), t = at(best.i);
      const nat = u32(orig, r + 216), face = u16(orig, r + 356);
      out.set(orig.subarray(t, t + REC), r);
      put16(out, r, old[k]);                                  // keep the record's id (squads point at it)
      put16(out, r + 2, comm ?? 0xffff);                      // commentary name (none unless the game has one)
      out.fill(0, r + 4, r + 20);
      for (let c = 0; c < name.length && c < 15; c++) out[r + 4 + c] = name.charCodeAt(c);
      out.fill(0, r + 20, r + 100);                           // career stats: start fresh
      const tBat = UP[six(orig, t + 108, 1)], tBowl = best.bowling;
      for (const [o, f] of BAT) setSix(out, r + o, f, raw(UP[six(orig, t + o, f)] + bat - tBat));
      // the game sends a keeper with an overall batting skill above 79 in to open (as Gilchrist did), so
      // keepers who don't open keep their shot ratings but have the overall skill held at 79
      if (role === 'WK' || role === 'WKB') setSix(out, r + 108, 1, Math.min(six(out, r + 108, 1), raw(79)));
      for (const [o, f] of BOWL) setSix(out, r + o, f, raw(UP[six(orig, t + o, f)] + bowl - tBowl));
      out[r + 351] = (out[r + 351] & 0xf0) | want.type;
      out[r + 132] = (out[r + 132] & 0xf0) | want.bowl;
      out[r + 133] = (out[r + 133] & 0xfe) | want.left;
      // batting position (the game orders the batting from it): opener, middle, lower order or tail
      const pos = role === 'OB' || role === 'OWK' ? 0 : ['OBW', 'BWL', 'SB'].includes(role) ? (bat >= 50 ? 2 : 3) : 1;
      out[r + 130] = (out[r + 130] & 0x7f) | (pos === 1 || pos === 2 ? 0x80 : 0);
      out[r + 131] = (out[r + 131] & 0xfe) | (pos >= 2 ? 1 : 0);
      put32(out, r + 216, nat);
      put16(out, r + 356, face >= 40000 ? face : genericFace(nat));
      if (dob) { const [y, m, d] = dob.split('-').map(Number); out[r + 348] = d; out[r + 349] = m - 1; out[r + 350] = y - 1900; }
    });
    const cap = team.players.findIndex((p) => p[0] === team.captain);
    if (cap >= 0) put16(out, b + 46, old[cap]);
  }
  return out;
}

if (typeof module !== 'undefined') module.exports = { applySquads };
