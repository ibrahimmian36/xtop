/* Pure terminal-rendering toolkit: ANSI escapes, color ramps, a braille
 * canvas, and small gauge/tree helpers. No application state, no I/O —
 * safe to import anywhere. (Braille core adapted from airtop's render.js.) */

export const ESC = "\x1b[";
export const HOME = `${ESC}H`;
export const CLEAR = `${ESC}2J${ESC}H`;
export const HIDE = `${ESC}?25l`;
export const SHOW = `${ESC}?25h`;
export const RESET = `${ESC}0m`;
export const EOL = `${ESC}K`;            /* erase to end of line */
export const bold = `${ESC}1m`;
export const dim = `${ESC}2m`;
export const ital = `${ESC}3m`;
export const fg = (n) => `${ESC}38;5;${n}m`;
export const bg = (n) => `${ESC}48;5;${n}m`;

/* low→high heat ramp (256-color) and a silent/background slot */
export const HEAT = [17, 18, 19, 20, 26, 32, 39, 45, 51, 50, 48, 46, 82, 118,
  154, 190, 226, 220, 214, 208, 202, 196, 197, 231];
export const SILENT_BG = 234;
export const EIGHTH = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/* a stable categorical palette for per-source / per-row coloring */
export const PALETTE = [82, 45, 213, 220, 208, 51, 141, 119, 203, 117, 186, 75];

/* semantic colors for the three event kinds + alert/calm */
export const C_FORK = 109;   /* muted teal — structural, low-signal */
export const C_EXEC = 84;    /* bright green — the headline event */
export const C_EXIT = 203;   /* soft red — teardown */
export const C_ALERT = 196;  /* hot red — flagged */
export const C_CALM = 71;    /* green — "nothing flagged" */
export const C_CONT = 75;    /* blue — container tag */
export const C_DIM = 240;
export const C_AXIS = 238;

export function mmss(ms) {
  const t = Math.floor(ms / 1000);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const p = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${p(h)}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

export function compactNum(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + "G";
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
  if (n >= 1e4) return (n / 1e3).toFixed(0) + "k";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(Math.round(n));
}

/* visible length of a string with ANSI SGR sequences stripped */
export function vlen(s) {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").length;
}

/* truncate a *plain* (un-colored) string to n cells with an ellipsis */
export function clip(s, n) {
  s = String(s ?? "");
  if (n <= 0) return "";
  if (s.length <= n) return s;
  if (n === 1) return "…";
  return s.slice(0, n - 1) + "…";
}

/* pad a string that may contain ANSI codes to a target *visible* width */
export function padVis(s, n) {
  const pad = n - vlen(s);
  return pad > 0 ? s + " ".repeat(pad) : s;
}

/* clip a string that contains ANSI SGR codes to n *visible* cells,
 * copying escape sequences through without counting them */
export function clipAnsi(s, n) {
  let out = "", vis = 0, i = 0;
  while (i < s.length) {
    if (s[i] === "\x1b") {
      const m = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(s.slice(i));
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    if (vis >= n) break;
    out += s[i]; vis++; i++;
  }
  return out + RESET;
}

/* force an (ANSI-containing) string to exactly w visible cells:
 * pad short with spaces, clip long. Used to build zip-able columns. */
export function fixw(s, w) {
  const v = vlen(s);
  if (v < w) s = s + " ".repeat(w - v);
  return clipAnsi(s, w);
}

/* one heat cell: v<0 → idle (dark bg), else a bg-colored block */
export function heatCell(v) {
  if (v < 0) return bg(SILENT_BG) + " " + RESET;
  return bg(HEAT[Math.min(HEAT.length - 1, Math.floor(v * HEAT.length))]) + " " + RESET;
}

/* horizontal gauge: filled ▰ to count, ▱ for the remainder */
export function gauge(frac, width, color) {
  const n = Math.max(0, Math.min(width, Math.round(frac * width)));
  return fg(color) + "▰".repeat(n) + fg(237) + "▱".repeat(width - n) + RESET;
}

/* tree connector glyphs */
export const TREE = {
  TEE: "├─", ELL: "└─", BAR: "│ ", GAP: "  ",
};

/* Braille canvas: each cell packs a 2×4 dot grid, so cw×ch cells give
 * 2cw×4ch pixels. One fg color per cell (last writer wins). (0,0) top-left. */
const BRAILLE_DOT = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]];
export function brailleCanvas(cw, ch) {
  const PW = cw * 2, PH = ch * 4;
  const mask = new Int32Array(cw * ch);
  const color = new Array(cw * ch).fill(0);
  return {
    PW, PH,
    set(px, py, col) {
      if (px < 0 || px >= PW || py < 0 || py >= PH) return;
      const i = (py >> 2) * cw + (px >> 1);
      mask[i] |= BRAILLE_DOT[py & 3][px & 1];
      if (col) color[i] = col;
    },
    rows() {
      const out = [];
      for (let cy = 0; cy < ch; cy++) {
        let line = "";
        for (let cx = 0; cx < cw; cx++) {
          const i = cy * cw + cx, m = mask[i];
          line += m === 0 ? " " : fg(color[i] || 51) + String.fromCodePoint(0x2800 + m) + RESET;
        }
        out.push(line);
      }
      return out;
    },
  };
}

/* braille line/area chart: series = [{data:[0..1|null], color}].
 * Lines connect vertically between samples; fill draws to the baseline. */
export function brailleChart(cw, ch, series, fill) {
  const cv = brailleCanvas(cw, ch);
  const PW = cv.PW, PH = cv.PH;
  for (const s of series) {
    const d = s.data, n = d.length;
    if (!n) continue;
    let prev = null;
    for (let px = 0; px < PW; px++) {
      const t = n === 1 ? 0 : (px / (PW - 1)) * (n - 1);
      const i0 = Math.floor(t), i1 = Math.min(n - 1, i0 + 1), f = t - i0;
      const a = d[i0], b = d[i1];
      if (a == null || b == null) { prev = null; continue; }
      const v = Math.max(0, Math.min(1, a + (b - a) * f));
      const py = Math.round((1 - v) * (PH - 1));
      if (fill) { for (let y = py; y < PH; y++) cv.set(px, y, s.color); }
      else {
        cv.set(px, py, s.color);
        if (prev != null) {
          const lo = Math.min(prev, py), hi = Math.max(prev, py);
          for (let y = lo; y <= hi; y++) cv.set(px, y, s.color);
        }
        prev = py;
      }
    }
  }
  return cv.rows();
}
