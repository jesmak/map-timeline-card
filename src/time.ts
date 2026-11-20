/**
 * Times as sources give them, and the timeline built from them. All times are in seconds since the epoch, as frames
 * never need finer.
 */

// The shortest step the timeline takes, whatever a source offers.
export const MIN_STEP = 60;

/** A source's times: frames listed one by one, and ranges from a start to an end in steps of a period. */
export interface TimeExtent {
    times: number[];
    /** `step` is null for a range that gives no period, such as `2026-11-19T12:00Z/2026-11-19T13:00Z`. */
    ranges: { start: number; end: number; step: number | null }[];
}

const DURATION = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

/**
 * An ISO 8601 duration in seconds, such as PT5M or P1D, or null when it isn't one. Years and months aren't taken, as
 * they have no fixed length, and no source offering radar or satellite frames uses them.
 */
export function parseDuration(text: string): number | null {
    const match = DURATION.exec(text.trim());
    if (!match || text.trim() === "P" || text.trim().endsWith("T")) return null;
    const [, days, hours, minutes, seconds] = match.map((part) => Number(part ?? 0));
    return Math.round(days * 86400 + hours * 3600 + minutes * 60 + seconds);
}

/** An ISO 8601 time in seconds, or null. A time without a zone is read as UTC, as WMS times are. */
export function parseTime(text: string): number | null {
    const value = text.trim();
    if (!/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
    const zoned = /T.*(Z|[+-]\d{2}:?\d{2})$/.test(value) || !value.includes("T") ? value : `${value}Z`;
    const ms = Date.parse(zoned);
    return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

/** A time as WMS and WMTS servers take it, such as 2026-11-19T12:05:00Z. */
export function isoTime(time: number): string {
    return new Date(time * 1000).toISOString().replace(".000Z", "Z");
}

/** A time of day as the clock shows it, in `timeZone` or the browser's own zone. */
export function clock(time: number, language: string, timeZone?: string): string {
    return new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit", timeZone }).format(time * 1000);
}

/**
 * A WMS time dimension's value: times and `start/end/period` ranges separated by commas, as WMS 1.3.0's annex C
 * describes. Throws on anything else, so a source that can't be read says so instead of showing nothing.
 */
export function parseTimeDimension(text: string): TimeExtent {
    const extent: TimeExtent = { times: [], ranges: [] };
    for (const part of text.split(",")) {
        const value = part.trim();
        if (!value) continue;
        const pieces = value.split("/");
        if (pieces.length === 1) {
            const time = parseTime(value);
            if (time === null) throw new Error(`"${value}" isn't a time`);
            extent.times.push(time);
            continue;
        }
        const start = parseTime(pieces[0]);
        const end = parseTime(pieces[1]);
        if (pieces.length > 3 || start === null || end === null || end < start) throw new Error(`"${value}" isn't a time range`);
        const period = pieces.length === 3 ? parseDuration(pieces[2]) : 0;
        if (period === null) throw new Error(`"${pieces[2]}" isn't a period`);
        // A period of zero means the range has no steps, as a missing one does.
        extent.ranges.push({ start, end, step: period || null });
    }
    extent.times.sort((a, b) => a - b);
    return extent;
}

/**
 * The frames of an extent from `from` to `to`, oldest first. A range without a period steps by `defaultStep` back from
 * its end, so its newest time is always among them.
 */
export function framesBetween(extent: TimeExtent, from: number, to: number, defaultStep: number): number[] {
    const frames = new Set(extent.times.filter((time) => time >= from && time <= to));
    for (const { start, end, step } of extent.ranges) {
        const last = Math.min(end, to);
        if (last < from || last < start) continue;
        if (step === null) {
            for (let time = end; time >= Math.max(start, from); time -= defaultStep) if (time <= to) frames.add(time);
        } else {
            // The range's own times, start plus whole steps, never a time between them.
            const first = start + Math.max(0, Math.ceil((from - start) / step)) * step;
            for (let time = first; time <= last; time += step) frames.add(time);
        }
    }
    return [...frames].sort((a, b) => a - b);
}

/** A source's step: its shortest period, or the shortest gap between its frames, or `fallback` when it has neither. */
export function stepOf(extent: TimeExtent, frames: number[], fallback: number): number {
    const periods = extent.ranges.map((range) => range.step ?? fallback);
    const gaps = frames
        .slice(1)
        .map((time, i) => time - frames[i])
        .filter((gap) => gap > 0);
    const steps = [...periods, ...gaps];
    return steps.length ? Math.min(...steps) : fallback;
}

/** The newest frame at or before `time`, or null when there is none. `frames` is sorted, oldest first. */
export function frameAt(frames: number[], time: number): number | null {
    let low = 0;
    let high = frames.length - 1;
    let found: number | null = null;
    while (low <= high) {
        const middle = (low + high) >> 1;
        if (frames[middle] <= time) {
            found = frames[middle];
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }
    return found;
}

/**
 * A source's frame to show at `time`: its newest at or before it, but ahead of `now` only when the source has frames
 * ahead of its own. A source of observations alone shows nothing in the forecast, so the map never shows an
 * observation under another source's forecast as if both were of the same moment.
 */
export function frameFor(frames: number[], time: number, now: number): number | null {
    if (time > now && !(frames[frames.length - 1] > now)) return null;
    return frameAt(frames, time);
}

export interface Timeline {
    /** The timeline's times, oldest first, `step` apart. */
    times: number[];
    step: number;
}

/**
 * The timeline over the sources that are on: from the oldest frame of any of them to the newest, in the shortest step
 * any of them has, never under MIN_STEP. Its times are whole steps, so they don't drift as frames come and go.
 */
export function buildTimeline(sources: { frames: number[]; step: number }[]): Timeline | null {
    const withFrames = sources.filter((source) => source.frames.length);
    if (!withFrames.length) return null;
    const step = Math.max(MIN_STEP, Math.min(...withFrames.map((source) => source.step)));
    const first = Math.min(...withFrames.map((source) => source.frames[0]));
    const last = Math.max(...withFrames.map((source) => source.frames[source.frames.length - 1]));
    const times: number[] = [];
    for (let time = Math.floor(first / step) * step; time <= last; time += step) times.push(time);
    // A last frame between two steps still gets a time of its own, or the newest forecast would never be shown.
    if (times[times.length - 1] < last) times.push(last);
    return { times, step };
}

/** The window played by default: the last hour up to now and everything ahead, as indexes into the timeline. */
export function defaultWindow(timeline: Timeline, now: number): [number, number] {
    const last = timeline.times.length - 1;
    const start = timeline.times.findIndex((time) => time >= now - 3600);
    const first = start < 0 ? last : start;
    // A window needs two frames to play; a timeline of one frame plays that one.
    return [Math.min(first, Math.max(0, last - 1)), last];
}
