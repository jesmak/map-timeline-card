/**
 * A GeoJSON document's features: its points drawn as geo_location's are, and its lines and areas as shapes in the
 * colours of their simplestyle properties (`fill`, `fill-opacity`, `stroke`, `stroke-width`, `stroke-opacity`).
 */
import type { Feature, Geometry } from "geojson";

import type { GeoEvent } from "./geolocation";
import { parseTime } from "./time";

interface Shape {
    /** In seconds, or null without one. */
    time: number | null;
    feature: Feature;
}

export interface GeoJsonData {
    points: GeoEvent[];
    shapes: Shape[];
}

/** A feature's time in milliseconds when it is this large: as seconds it would be thousands of years ahead. */
const MILLISECONDS = 1e11;

/**
 * The features of a FeatureCollection or a single Feature, each at the time in its property `timeProperty`, when one
 * is named: seconds or milliseconds since the epoch, or ISO 8601. Throws when the document isn't GeoJSON.
 */
export function readGeoJson(json: unknown, timeProperty: string): GeoJsonData {
    const document = record(json);
    const features =
        document?.type === "FeatureCollection" && Array.isArray(document.features)
            ? document.features
            : document?.type === "Feature"
              ? [document]
              : null;
    if (!features) throw new Error("the answer isn't a GeoJSON feature collection");
    const data: GeoJsonData = { points: [], shapes: [] };
    features.forEach((entry, index) => {
        const feature = record(entry);
        const geometry = record(feature?.geometry) as Geometry | null;
        if (!feature || !geometry) return;
        const properties = record(feature.properties) ?? {};
        // A feature without an id is named by its place, marked so it can't meet one whose id is that number.
        const key = typeof feature.id === "string" || typeof feature.id === "number" ? String(feature.id) : `#${index}`;
        const time = timeProperty ? timeOf(properties[timeProperty]) : null;
        const color = typeof properties["marker-color"] === "string" ? properties["marker-color"] : "";
        if (geometry.type === "Point") {
            if (isPosition(geometry.coordinates)) data.points.push({ key, position: lonLat(geometry.coordinates), time, color });
        } else if (geometry.type === "MultiPoint") {
            if (!Array.isArray(geometry.coordinates)) return;
            geometry.coordinates.filter(isPosition).forEach((position, n) => {
                data.points.push({ key: `${key}:${n}`, position: lonLat(position), time, color });
            });
        } else {
            data.shapes.push({ time, feature: { type: "Feature", geometry, properties } });
        }
    });
    return data;
}

function timeOf(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value >= MILLISECONDS ? value / 1000 : value);
    return typeof value === "string" ? parseTime(value) : null;
}

function isPosition(value: unknown): value is number[] {
    return Array.isArray(value) && value.length >= 2 && value.every((part) => typeof part === "number" && Number.isFinite(part));
}

function lonLat(position: number[]): [number, number] {
    return [position[0], position[1]];
}

function record(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
