/**
 * The card's configuration (README.md#options), checked when it is set. A value that can't be used throws, so Home
 * Assistant shows what is wrong in place of the card instead of a map quietly drawn some other way.
 */
import { browserLanguage, translate } from "./localize/localize";

export const MAP_STYLES = ["default", "colorful", "natural", "muted", "gray", "toner"] as const;
export type MapStyle = (typeof MAP_STYLES)[number];

export const SOURCE_TYPES = ["wms", "rainviewer"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const RAINVIEWER_LAYERS = ["radar", "satellite"] as const;

/** Seven grid rows of a sections view, so the card ends on the rows unless told otherwise. */
export const DEFAULT_MAP_HEIGHT = 440;
export const DEFAULT_ZOOM = 8;
export const DEFAULT_REGION_ZOOM = 5;
export const MAX_ZOOM = 18;
/** Minutes of the sources' time played in a second. */
export const DEFAULT_SPEED = 10;
export const DEFAULT_HISTORY_MINUTES = 120;
/** How many of its steps a source may go without a new frame before its chip warns. */
export const DEFAULT_STALE_STEPS = 3;
/** The step of a source whose times give no period, such as a WMS range with only a start and an end. */
export const DEFAULT_STEP_MINUTES = 5;

const ENTITY_ID = /^[a-z_]+\.[a-z0-9_]+$/;

export interface SourceOptions {
    type: SourceType;
    /** The name on its chip. */
    name: string;
    /** An mdi icon for its chip, or "" for the type's own. */
    icon: string;
    url: string;
    /** A WMS layer's name, or a RainViewer API's `radar` or `satellite`. */
    layer: string;
    /** A WMS server's style to draw with, or "" for the first it lists. */
    style: string;
    /** A RainViewer API's colour scheme, or null for the first it lists. */
    colorScheme: number | null;
    /** The deepest zoom its server has tiles for, drawn enlarged past it, or null for any. */
    maxZoom: number | null;
    historyMinutes: number;
    opacity: number;
    /** A legend image of the user's own, false for none, or null for the source's own. */
    legend: string | false | null;
    /** Credits of the user's own, or "" for what the source gives. */
    attribution: string;
    staleSteps: number;
    stepMinutes: number;
}

export interface CardOptions {
    /** The zone the map centres on, or "" for Home Assistant's home. */
    zone: string;
    zoom: number;
    regionZoom: number;
    mapStyle: MapStyle;
    mapHeight: number;
    speed: number;
    sources: SourceOptions[];
}

/** An error for a value that can't be used, in the browser's language: the card has no `hass` yet when it is configured. */
export function invalid(key: string, values: Record<string, string | number> = {}): Error {
    const text = translate(browserLanguage(), `config.invalid_${key}`);
    return new Error(text.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? "")));
}

export function parseOptions(raw: unknown): CardOptions {
    const config = isRecord(raw) ? raw : {};
    if (!Array.isArray(config.sources)) throw invalid("sources");
    return {
        zone: parseZone(config.zone),
        zoom: parseZoom(config.zoom, DEFAULT_ZOOM, "zoom"),
        regionZoom: parseZoom(config.region_zoom, DEFAULT_REGION_ZOOM, "region_zoom"),
        mapStyle: parseChoice(config.map_style, MAP_STYLES, "default", "map_style"),
        mapHeight: parseNumber(config.map_height, DEFAULT_MAP_HEIGHT, (value) => value >= 200, "map_height"),
        speed: parseNumber(config.speed, DEFAULT_SPEED, (value) => value > 0, "speed"),
        sources: config.sources.map((entry, index) => parseSource(isRecord(entry) ? entry : {}, index)),
    };
}

function parseSource(source: Record<string, unknown>, index: number): SourceOptions {
    const where = { n: index + 1 };
    const type = parseChoice(source.type, SOURCE_TYPES, undefined, "type", where);
    const url = typeof source.url === "string" ? source.url.trim() : "";
    if (!/^https?:\/\/\S+$/.test(url)) throw invalid("url", where);
    const layer =
        type === "rainviewer"
            ? parseChoice(source.layer, RAINVIEWER_LAYERS, "radar", "rainviewer_layer", where)
            : typeof source.layer === "string"
              ? source.layer.trim()
              : "";
    if (!layer) throw invalid("layer", where);
    return {
        type,
        name: text(source.name) || layer,
        icon: text(source.icon),
        url,
        layer,
        style: text(source.style),
        colorScheme: parseOptional(source.color_scheme, (value) => Number.isInteger(value) && value >= 0, "color_scheme", where),
        maxZoom: parseOptional(source.max_zoom, (value) => Number.isInteger(value) && value >= 0 && value <= 22, "max_zoom", where),
        historyMinutes: parseNumber(source.history_minutes, DEFAULT_HISTORY_MINUTES, (value) => value >= 0, "history_minutes", where),
        opacity: parseNumber(source.opacity, 1, (value) => value > 0 && value <= 1, "opacity", where),
        legend: parseLegend(source.legend, where),
        attribution: text(source.attribution),
        staleSteps: parseNumber(source.stale_steps, DEFAULT_STALE_STEPS, (value) => value >= 1, "stale_steps", where),
        stepMinutes: parseNumber(source.step_minutes, DEFAULT_STEP_MINUTES, (value) => value >= 1, "step_minutes", where),
    };
}

function parseZone(value: unknown): string {
    if (value === undefined || value === null || value === "") return "";
    if (typeof value === "string" && ENTITY_ID.test(value.trim()) && value.trim().startsWith("zone.")) return value.trim();
    throw invalid("zone", { value: String(value) });
}

function parseZoom(value: unknown, fallback: number, name: string): number {
    return parseNumber(value, fallback, (zoom) => zoom >= 0 && zoom <= MAX_ZOOM, "zoom", { name, max: MAX_ZOOM });
}

function parseLegend(value: unknown, where: { n: number }): string | false | null {
    if (value === undefined || value === null || value === true) return null;
    if (value === false) return false;
    if (typeof value === "string" && /^https?:\/\/\S+$/.test(value.trim())) return value.trim();
    throw invalid("legend", where);
}

function parseChoice<T extends string>(
    value: unknown,
    choices: readonly T[],
    fallback: T | undefined,
    key: string,
    values: Record<string, string | number> = {},
): T {
    if ((value === undefined || value === null) && fallback !== undefined) return fallback;
    if ((choices as readonly unknown[]).includes(value)) return value as T;
    throw invalid(key, { ...values, values: choices.join(", ") });
}

function parseNumber(
    value: unknown,
    fallback: number,
    valid: (value: number) => boolean,
    key: string,
    values: Record<string, string | number> = {},
): number {
    if (value === undefined || value === null || value === "") return fallback;
    const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
    if (Number.isFinite(parsed) && valid(parsed)) return parsed;
    throw invalid(key, values);
}

/** A number left out, or left empty in YAML, is null. */
function parseOptional(
    value: unknown,
    valid: (value: number) => boolean,
    key: string,
    values: Record<string, string | number>,
): number | null {
    if (value === undefined || value === null || value === "") return null;
    return parseNumber(value, 0, valid, key, values);
}

function text(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
