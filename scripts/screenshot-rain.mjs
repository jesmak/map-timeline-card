/**
 * Made-up rain for the README's screenshots: a server in the shape of RainViewer's API, its catalogue and its tiles,
 * written into docs/rain, which the screenshot tool serves from /local/rain. Frames around the screenshots' clock, past
 * and ahead, of rain cells drifting east over Tampere, the tool's made-up home. The same every run.
 *
 *     node scripts/screenshot-rain.mjs
 */
import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import zlib from "node:zlib";

// The screenshots' clock, docs/screenshots.json's, and the frames around it.
const NOW = Date.parse("2026-10-14T15:00:00+03:00") / 1000;
const STEP = 600;
const PAST = 6;
const AHEAD = 6;
// The tool serves Home Assistant here, and the folder from /local/rain.
const HOST = "http://127.0.0.1:18123";
const ROOT = "/local/rain";
// MapLibre asks for 256 pixel tiles a zoom deeper than the map's, which is 7 in the screenshots.
const ZOOM = 8;
const AREA = { west: 20.8, east: 26.8, south: 60.4, north: 62.6 };

const OUT = path.join(import.meta.dirname, "..", "docs", "rain");

/** Radar colours from light rain to heavy, as most radars draw them. */
const PALETTE = [
    [0.15, [150, 210, 255, 150]],
    [0.3, [60, 150, 240, 190]],
    [0.45, [40, 190, 90, 210]],
    [0.6, [250, 220, 40, 225]],
    [0.75, [250, 140, 30, 235]],
    [0.9, [220, 40, 40, 240]],
];

/** A front of rain lying south-west to north-east across the area: a point on its line at the clock, and its width. */
const FRONT = { lon: 23.6, lat: 61.5, angle: (35 * Math.PI) / 180, width: 0.28 };
/** Heavier showers inside the front: where each is at the clock, its size in degrees, and how heavy. */
const SHOWERS = [
    [23.45, 61.58, 0.09, 0.05, 0.55],
    [23.95, 61.72, 0.07, 0.04, 0.4],
];
// Drift in degrees an hour, to the east and a little north.
const DRIFT = [0.45, 0.08];

function rain(lon, lat, time) {
    const hours = (time - NOW) / 3600;
    const x = lon - DRIFT[0] * hours;
    const y = lat - DRIFT[1] * hours;
    // Warped noise, so the front's edges and the gaps in it are ragged rather than round.
    const wx = x * 6 + 1.5 * fractal(x * 3 + 7.3, y * 6);
    const wy = y * 12 + 1.5 * fractal(x * 3, y * 6 + 2.1);
    const noise = fractal(wx, wy);
    // Across the front, in degrees of latitude, as a degree of longitude is half as long up here.
    const across = (y - FRONT.lat) * Math.cos(FRONT.angle) - (x - FRONT.lon) * 0.48 * Math.sin(FRONT.angle);
    let value = Math.exp(-((across / FRONT.width) ** 2)) * noise ** 1.4 * 1.5;
    for (const [sx, sy, w, h, peak] of SHOWERS) {
        const dx = (x - sx) / w;
        const dy = (y - sy) / h;
        value += peak * Math.exp(-(dx * dx + dy * dy)) * (0.6 + 0.8 * noise);
    }
    // Mostly light rain, a few showers, and the heaviest only in their cores.
    return value * 0.72 - 0.08;
}

function colour(value) {
    let found = null;
    for (const [from, rgba] of PALETTE) if (value >= from) found = rgba;
    return found;
}

/** Value noise in four octaves, from 0 to 1, the same for the same point every run. */
function fractal(x, y) {
    let sum = 0;
    let weight = 0.5;
    let total = 0;
    for (let octave = 0; octave < 4; octave++) {
        sum += smooth(x, y) * weight;
        total += weight;
        x *= 2;
        y *= 2;
        weight /= 2;
    }
    return sum / total;
}

function smooth(x, y) {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const ease = (t) => t * t * (3 - 2 * t);
    const a = hash(x0, y0);
    const b = hash(x0 + 1, y0);
    const c = hash(x0, y0 + 1);
    const d = hash(x0 + 1, y0 + 1);
    const top = a + (b - a) * ease(fx);
    const bottom = c + (d - c) * ease(fx);
    return top + (bottom - top) * ease(fy);
}

function hash(x, y) {
    let h = (x * 374761393 + y * 668265263) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

const tileX = (lon) => Math.floor(((lon + 180) / 360) * 2 ** ZOOM);
const tileY = (lat) => {
    const radians = (lat * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2) * 2 ** ZOOM);
};
const lonOf = (x) => (x / 2 ** ZOOM) * 360 - 180;
const latOf = (y) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** ZOOM))) * 180) / Math.PI;

function tile(x, y, time) {
    const pixels = Buffer.alloc(256 * 256 * 4);
    for (let py = 0; py < 256; py++) {
        const lat = latOf(y + (py + 0.5) / 256);
        for (let px = 0; px < 256; px++) {
            const rgba = colour(rain(lonOf(x + (px + 0.5) / 256), lat, time));
            if (rgba) pixels.set(rgba, (py * 256 + px) * 4);
        }
    }
    return png(256, 256, pixels);
}

/** An RGBA PNG, written by hand, as Node has zlib but no image library. */
function png(width, height, pixels) {
    const rows = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) pixels.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header.set([8, 6, 0, 0, 0], 8);
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk("IHDR", header),
        chunk("IDAT", zlib.deflateSync(rows, { level: 9 })),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
}

fs.rmSync(OUT, { recursive: true, force: true });
const frames = Array.from({ length: PAST + 1 + AHEAD }, (_, i) => NOW + (i - PAST) * STEP);
const entry = (time) => ({ time, path: `${ROOT}/v2/radar/${time}` });
let written = 0;
for (const time of frames) {
    for (let x = tileX(AREA.west); x <= tileX(AREA.east); x++) {
        for (let y = tileY(AREA.north); y <= tileY(AREA.south); y++) {
            const file = path.join(OUT, "v2", "radar", String(time), "256", String(ZOOM), String(x), String(y), "0", "1_1.png");
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, tile(x, y, time));
            written++;
        }
    }
}
const catalogue = {
    version: "2.0",
    generated: NOW,
    host: HOST,
    radar: { past: frames.filter((time) => time <= NOW).map(entry), nowcast: frames.filter((time) => time > NOW).map(entry) },
    satellite: { infrared: [] },
};
fs.mkdirSync(path.join(OUT, "public"), { recursive: true });
fs.writeFileSync(path.join(OUT, "public", "weather-maps.json"), `${JSON.stringify(catalogue, null, 4)}\n`);
console.log(`${frames.length} frames, ${written} tiles in ${path.relative(process.cwd(), OUT)}`);
