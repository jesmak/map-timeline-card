/**
 * XYZ tiles with the time in their address, such as `…/USCOMP-N0Q-{time:YYYYMMDDHHmm}/{z}/{x}/{y}.png`. Nothing lists
 * which times exist, so the frames are the source's steps from its history up to a delay behind now.
 */

const TIME_PLACEHOLDER = /\{time:([^}]+)\}/g;

/** Whether an address has what the card fills in: MapLibre's {z}, {x} and {y}, and at least one time. */
export function validXyzUrl(url: string): boolean {
    return ["{z}", "{x}", "{y}"].every((part) => url.includes(part)) && /\{time:[^}]+\}/.test(url);
}

/**
 * The frames from `delay` seconds behind now back over `history` seconds, oldest first, on whole steps of the clock in
 * UTC, as a server that keeps a frame every five minutes keeps one at :00, :05 and so on. The history is counted from
 * the newest frame, so a delay longer than it still leaves frames.
 */
export function xyzFrames(now: number, step: number, delay: number, history: number): number[] {
    const newest = Math.floor((now - delay) / step) * step;
    const frames: number[] = [];
    for (let time = newest; time >= newest - history; time -= step) frames.unshift(time);
    return frames;
}

/** A frame's tiles: each `{time:…}` in the address written in its pattern, of YYYY, MM, DD, HH, mm and ss, in UTC. */
export function xyzUrl(url: string, time: number): string {
    const date = new Date(time * 1000);
    const parts: Record<string, string> = {
        YYYY: String(date.getUTCFullYear()),
        MM: pad(date.getUTCMonth() + 1),
        DD: pad(date.getUTCDate()),
        HH: pad(date.getUTCHours()),
        mm: pad(date.getUTCMinutes()),
        ss: pad(date.getUTCSeconds()),
    };
    return url.replace(TIME_PLACEHOLDER, (_, pattern: string) => pattern.replace(/YYYY|MM|DD|HH|mm|ss/g, (token) => parts[token]));
}

function pad(value: number): string {
    return String(value).padStart(2, "0");
}
