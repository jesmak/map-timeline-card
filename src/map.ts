/**
 * The map: MapLibre on Home Assistant's base map (map-tiles.ts), with each frame of each source as a raster layer of
 * its own. A frame's layer stays after it is shown, hidden, so playing a loop again doesn't fetch its tiles again.
 */
import { AttributionControl, Map as MapLibreMap, Marker, setWorkerUrl } from "maplibre-gl";
import type { GeoJSONSource, StyleSpecification } from "maplibre-gl";
import type { Feature, FeatureCollection } from "geojson";
// The worker is carried as text and started from a blob, so the card stays one file, as HACS installs it.
import workerSource from "maplibre-gl/dist/maplibre-gl-worker.mjs?raw";

import { loadStyle, MapError, onTokenChange, refreshToken, transformRequest } from "./map-tiles";
import type { MapStyle } from "./options";

/** A frame to draw: `key` names it across the card, `source` is its source's place in the config, the lowest first. */
export interface DrawnFrame {
    key: string;
    source: number;
    url: string;
    opacity: number;
    /** The deepest zoom its server has tiles for, drawn enlarged past it, or null for any. */
    maxZoom: number | null;
}

/** A point to draw, such as a lightning strike: an icon, or a dot without one. */
export interface DrawnPoint {
    key: string;
    /** [longitude, latitude]. */
    position: [number, number];
    icon: string;
    /** A CSS colour, drawn into the point's image. */
    color: string;
    opacity: number;
}

/** A line or an area to draw, in the colour given where its simplestyle properties name none. */
export interface DrawnShape {
    feature: Feature;
    color: string;
}

export interface MapView {
    center: [number, number];
    zoom: number;
}

const FRAME_KEY = /^s\d+-\d+$/;

/** Every source's lines and areas are one GeoJSON source, drawn above the frames and under the base map's labels. */
const SHAPES = "shapes";
const SHAPE_FILL = "shapes-fill";
const SHAPE_LINE = "shapes-line";
/** Every source's points are one GeoJSON source, drawn above everything else, as markers were. */
const POINTS = "points";

/** A point's icon in CSS pixels, its shadow's margin around it, and how much finer than that its image is drawn. */
const ICON_PX = 20;
const SHADOW_PX = 3;
const PIXEL_RATIO = 2;
/** How long Home Assistant gets to find an icon before its point is drawn as a dot. */
const ICON_TIMEOUT_MS = 5000;

/** A frame's name on the map: its source's place in the config and its time. */
export function frameKey(source: number, time: number): string {
    return `s${source}-${time}`;
}

/** How many frames' layers are kept, shown or not. A loop of three hours in five minute steps of two sources fits. */
const KEPT_FRAMES = 80;

/** After a refused tile, how long before another refusal may ask for a new token again. */
const RECOVERY_THROTTLE_MS = 30_000;

let workerReady = false;

function ensureWorker(): void {
    if (workerReady) return;
    workerReady = true;
    setWorkerUrl(URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" })));
}

interface FrameEntry {
    frame: DrawnFrame;
    /** When it was last shown or asked for, to drop the longest unused first. */
    used: number;
}

export class TimelineMap {
    private map?: MapLibreMap;
    private readonly frames = new Map<string, FrameEntry>();
    private shown = new Set<string>();
    private wantedPoints: DrawnPoint[] = [];
    private pointData: FeatureCollection = { type: "FeatureCollection", features: [] };
    private pointsKey = "";
    /** Each icon and colour's image, or null while it is being drawn. Kept for a new style, which drops them. */
    private readonly images = new Map<string, ImageData | null>();
    private shapes: FeatureCollection = { type: "FeatureCollection", features: [] };
    private drawnShapes: DrawnShape[] = [];
    /** The frames last asked to be shown, some of which may still be loading. */
    private wanted: DrawnFrame[] = [];
    private attribution?: AttributionControl;
    /** Undefined until the control is first added, so a map with no credits of its sources still gets the base map's. */
    private attributionText?: string;
    private home?: Marker;
    private style: MapStyle;
    private dark: boolean;
    private theme: Record<string, string> | null;
    private styleRequest = 0;
    private styleFailed = false;
    private refused = false;
    private lastRecovery = 0;
    private unsubscribe?: () => void;
    private resizer?: ResizeObserver;
    private destroyed = false;
    private styleReady = false;
    private uses = 0;

    constructor(
        private readonly container: HTMLElement,
        style: MapStyle,
        dark: boolean,
        theme: Record<string, string> | null,
        /** MapLibre's UI strings by its own IDs, read once when the map is made. */
        private readonly locale: Record<string, string>,
        private readonly start: MapView,
    ) {
        this.style = style;
        this.dark = dark;
        this.theme = theme;
    }

    /** Throws when the map can't be drawn: no WebGL, or no tiles from Home Assistant. */
    async init(): Promise<void> {
        if (!document.createElement("canvas").getContext("webgl2")) {
            throw new MapError("webgl", "WebGL 2 is not available");
        }
        ensureWorker();
        const style = await loadStyle(this.style, this.dark, this.theme);
        if (this.destroyed) return;

        const map = new MapLibreMap({
            container: this.container,
            style,
            center: this.start.center,
            zoom: this.start.zoom,
            attributionControl: false,
            // The wheel and a one-finger drag scroll the page, so the map doesn't trap it. Ctrl and two fingers move the map.
            cooperativeGestures: true,
            locale: this.locale,
            dragRotate: false,
            pitchWithRotate: false,
            touchPitch: false,
            transformRequest: (url) => transformRequest(url),
            trackResize: false,
        });
        this.map = map;
        this.resizer = new ResizeObserver(() => map.resize());
        this.resizer.observe(this.container);
        map.touchZoomRotate.disableRotation();
        map.keyboard.disableRotation();

        // A refused TileJSON isn't asked for again, so the style is set again once there is a new token. 403 is an old
        // token, 404 a proxy not registered yet after a restart, and no status a network error. Only the base map's
        // errors count: a source's refused frame is that source's business.
        map.on("error", (event) => {
            // A frame's, even one just dropped whose tile answered late, never reloads the base map.
            const sourceId = (event as { sourceId?: string }).sourceId;
            if (sourceId && FRAME_KEY.test(sourceId)) return;
            const status = (event.error as { status?: number } | undefined)?.status;
            if (status !== undefined && status !== 403 && status !== 404) return;
            if (Date.now() - this.lastRecovery < RECOVERY_THROTTLE_MS) return;
            this.lastRecovery = Date.now();
            this.refused = true;
            void refreshToken();
        });
        this.unsubscribe = onTokenChange(() => {
            if (!this.refused) return;
            this.refused = false;
            void this.setStyle(this.style, this.dark, this.theme, true);
        });
        // A new style drops every source and layer, so the frames are added again whenever one has loaded. The card keeps
        // its own flag: MapLibre's isStyleLoaded() is false while any source's tiles are still loading.
        const loaded = new Promise<void>((resolve) => {
            map.on("style.load", () => {
                this.styleReady = true;
                this.addShapes();
                this.addPoints();
                for (const { frame } of this.frames.values()) this.addFrame(frame);
                // They come back hidden, and what is shown is decided again rather than waiting for their tiles' events.
                this.shown = new Set();
                this.apply();
                resolve();
            });
        });
        // A frame waiting for its tiles is shown once they are in.
        map.on("sourcedata", (event) => {
            if (event.isSourceLoaded && this.wanted.some((frame) => frame.key === event.sourceId)) this.apply();
        });
        // Marks the map drawn, for whatever waits for it, such as the README's screenshots; MapLibre says so only in an event.
        map.on("idle", () => {
            this.apply();
            this.container.dataset.mapReady = "";
        });

        const icon = document.createElement("ha-icon");
        icon.setAttribute("icon", "mdi:home");
        icon.className = "home-marker";
        this.home = new Marker({ element: icon }).setLngLat(this.start.center).addTo(map);

        await loaded;
    }

    async setStyle(style: MapStyle, dark: boolean, theme: Record<string, string> | null, force = false): Promise<void> {
        const same =
            !this.styleFailed && style === this.style && dark === this.dark && JSON.stringify(theme) === JSON.stringify(this.theme);
        if (!this.map || (!force && same)) return;
        delete this.container.dataset.mapReady;
        this.style = style;
        this.dark = dark;
        this.theme = theme;
        const request = ++this.styleRequest;
        this.styleFailed = false;
        let loaded: StyleSpecification;
        try {
            loaded = await loadStyle(style, dark, theme);
        } catch (error) {
            // The map keeps the style it has, and the next update asks for this one again.
            if (request === this.styleRequest) {
                this.styleFailed = true;
                this.container.dataset.mapReady = "";
            }
            console.warn(`map-timeline-card: the ${style} map style couldn't be loaded`, error);
            return;
        }
        if (this.destroyed || request !== this.styleRequest) return;
        this.styleReady = false;
        this.map.setStyle(loaded, { diff: false });
    }

    /**
     * Shows these frames and hides the rest. `ahead` are frames to have ready, loaded but not shown, such as the next
     * ones of a loop.
     */
    show(frames: DrawnFrame[], ahead: DrawnFrame[] = []): void {
        if (!this.map) return;
        for (const frame of [...frames, ...ahead]) {
            const entry = this.frames.get(frame.key);
            if (entry) {
                entry.used = ++this.uses;
                entry.frame = frame;
            } else {
                this.frames.set(frame.key, { frame, used: ++this.uses });
            }
            if (this.styleReady) this.addFrame(frame);
        }
        this.wanted = frames;
        this.apply();
        this.dropUnused();
    }

    /** Forgets every frame, as when the sources change: a frame's key names its source by its place, not its settings. */
    clear(): void {
        for (const key of this.frames.keys()) {
            if (this.map?.getLayer(key)) this.map.removeLayer(key);
            if (this.map?.getSource(key)) this.map.removeSource(key);
        }
        this.frames.clear();
        this.shown = new Set();
        this.wanted = [];
    }

    /**
     * Shows the frames wanted, each once its tiles have loaded. Until then its source's frame shown before stays, so a
     * new frame never leaves the map blank while it loads. A source with nothing shown before shows its frame as it loads.
     */
    private apply(): void {
        const map = this.map;
        if (!map) return;
        const shown = new Set<string>();
        for (const frame of this.wanted) {
            const before = [...this.shown].find((key) => this.frames.get(key)?.frame.source === frame.source);
            const ready = map.getSource(frame.key) !== undefined && map.isSourceLoaded(frame.key);
            shown.add(ready || !before ? frame.key : before);
        }
        for (const [key, { frame }] of this.frames) {
            const visible = shown.has(key);
            if (!visible && !this.shown.has(key)) continue;
            if (map.getLayer(key)) map.setPaintProperty(key, "raster-opacity", visible ? frame.opacity : 0);
        }
        this.shown = shown;
    }

    /**
     * Draws these points, replacing those drawn before, as one symbol layer, so thousands of them still move with the
     * map. A point waits off the map until its image is ready, and is handed to MapLibre again only when something
     * about it changes, its fade included.
     */
    setPoints(points: DrawnPoint[]): void {
        this.wantedPoints = points;
        for (const point of points) this.loadImage(point.icon, point.color);
        this.updatePoints();
    }

    private updatePoints(): void {
        const ready = this.wantedPoints.filter((point) => this.images.get(imageName(point.icon, point.color)));
        const key = ready.map((point) => `${point.key}|${imageName(point.icon, point.color)}|${point.opacity.toFixed(2)}`).join(",");
        if (key === this.pointsKey) return;
        this.pointsKey = key;
        this.pointData = {
            type: "FeatureCollection",
            features: ready.map((point) => ({
                type: "Feature",
                geometry: { type: "Point", coordinates: point.position },
                properties: { image: imageName(point.icon, point.color), opacity: point.opacity },
            })),
        };
        if (this.styleReady) (this.map?.getSource(POINTS) as GeoJSONSource | undefined)?.setData(this.pointData);
    }

    /** Draws a point's image once per icon and colour, and adds it to the map when it is ready. */
    private loadImage(icon: string, color: string): void {
        const name = imageName(icon, color);
        if (this.images.has(name)) return;
        this.images.set(name, null);
        void iconPath(icon).then((path) => {
            if (this.destroyed) return;
            const image = drawPoint(path, color);
            this.images.set(name, image);
            if (this.styleReady && this.map && !this.map.hasImage(name)) this.map.addImage(name, image, { pixelRatio: PIXEL_RATIO });
            this.updatePoints();
        });
    }

    /**
     * Draws these lines and areas, replacing those drawn before. They are handed to MapLibre only when they change, as
     * playing moves the time far more often than it changes which features are shown. A source read again gives new
     * features, so they are compared as objects rather than by their keys.
     */
    setShapes(shapes: DrawnShape[]): void {
        const before = this.drawnShapes;
        const same =
            shapes.length === before.length &&
            shapes.every((shape, n) => shape.feature === before[n].feature && shape.color === before[n].color);
        if (same) return;
        this.drawnShapes = shapes;
        this.shapes = {
            type: "FeatureCollection",
            features: shapes.map((shape) => ({ ...shape.feature, properties: { ...shape.feature.properties, _color: shape.color } })),
        };
        if (this.styleReady) (this.map?.getSource(SHAPES) as GeoJSONSource | undefined)?.setData(this.shapes);
    }

    /** Credits as HTML, behind MapLibre's info button, which starts closed. The base map adds its own to them. */
    setAttribution(credits: string[]): void {
        const text = credits.join(" · ");
        if (!this.map || text === this.attributionText) return;
        this.attributionText = text;
        if (this.attribution) this.map.removeControl(this.attribution);
        this.attribution = new AttributionControl({ compact: true, customAttribution: text || undefined });
        this.map.addControl(this.attribution, "top-right");
        // MapLibre opens a compact attribution once its sources have loaded, and on a small card that hides much of the
        // map. It starts closed instead, behind its button. Closed is what MapLibre's own toggle leaves: `open` set,
        // `maplibregl-compact-show` gone.
        const element = this.map.getContainer().querySelector(".maplibregl-ctrl-attrib");
        if (!element) return;
        const close = (): boolean => {
            if (!element.classList.contains("maplibregl-compact-show")) return false;
            element.setAttribute("open", "");
            element.classList.remove("maplibregl-compact-show");
            return true;
        };
        if (close()) return;
        const observer = new MutationObserver(() => close() && observer.disconnect());
        observer.observe(element, { attributes: true, attributeFilter: ["class"] });
    }

    jumpTo(view: MapView, home: [number, number]): void {
        this.home?.setLngLat(home);
        this.map?.jumpTo(view);
    }

    destroy(): void {
        this.destroyed = true;
        this.resizer?.disconnect();
        this.unsubscribe?.();
        this.map?.remove();
        this.map = undefined;
        this.frames.clear();
        this.wantedPoints = [];
        this.wanted = [];
    }

    /**
     * The shapes' source and layers, under the base map's first label. A shape's own simplestyle colours win, and one that
     * names none, or names one MapLibre can't read, is drawn in its source's. Opacities and widths default as simplestyle's.
     */
    private addShapes(): void {
        const map = this.map!;
        if (map.getSource(SHAPES)) return;
        const label = map.getStyle().layers.find((layer) => layer.type === "symbol")?.id;
        map.addSource(SHAPES, { type: "geojson", data: this.shapes });
        map.addLayer(
            {
                id: SHAPE_FILL,
                type: "fill",
                source: SHAPES,
                filter: ["match", ["geometry-type"], ["Polygon", "MultiPolygon"], true, false],
                paint: {
                    "fill-color": ["to-color", ["get", "fill"], ["get", "_color"]],
                    "fill-opacity": ["number", ["get", "fill-opacity"], 0.6],
                },
            },
            label,
        );
        map.addLayer(
            {
                id: SHAPE_LINE,
                type: "line",
                source: SHAPES,
                filter: ["match", ["geometry-type"], ["LineString", "MultiLineString", "Polygon", "MultiPolygon"], true, false],
                paint: {
                    "line-color": ["to-color", ["get", "stroke"], ["get", "_color"]],
                    "line-width": ["number", ["get", "stroke-width"], 2],
                    "line-opacity": ["number", ["get", "stroke-opacity"], 1],
                },
            },
            label,
        );
    }

    /** The points' images, source and layer, above everything. The freshest points are drawn over the faded ones. */
    private addPoints(): void {
        const map = this.map!;
        for (const [name, image] of this.images) if (image && !map.hasImage(name)) map.addImage(name, image, { pixelRatio: PIXEL_RATIO });
        if (map.getSource(POINTS)) return;
        map.addSource(POINTS, { type: "geojson", data: this.pointData });
        map.addLayer({
            id: POINTS,
            type: "symbol",
            source: POINTS,
            layout: {
                "icon-image": ["get", "image"],
                "icon-allow-overlap": true,
                "icon-ignore-placement": true,
                "symbol-sort-key": ["get", "opacity"],
            },
            paint: { "icon-opacity": ["get", "opacity"] },
        });
    }

    /** Adds a frame's layer hidden, under the base map's labels and in its source's place among the others. */
    private addFrame(frame: DrawnFrame): void {
        const map = this.map!;
        if (map.getLayer(frame.key)) return;
        map.addSource(frame.key, {
            type: "raster",
            tiles: [frame.url],
            tileSize: 256,
            ...(frame.maxZoom === null ? {} : { maxzoom: frame.maxZoom }),
        });
        map.addLayer(
            {
                id: frame.key,
                type: "raster",
                source: frame.key,
                paint: {
                    // Added hidden: apply() shows it, once its tiles are in or when there is nothing to hold until then.
                    "raster-opacity": 0,
                    // A frame swaps in at once: a cross-fade would blur the rain's motion as it plays.
                    "raster-fade-duration": 0,
                    "raster-opacity-transition": { duration: 0, delay: 0 },
                },
            },
            this.beforeId(frame.source),
        );
    }

    /** The layer a source's frames go under: the lowest frame of a later source, or else the shapes, under the labels. */
    private beforeId(source: number): string | undefined {
        const layers = this.map!.getStyle().layers;
        const later = layers.find((layer) => {
            const entry = this.frames.get(layer.id);
            return entry !== undefined && entry.frame.source > source;
        });
        return later?.id ?? SHAPE_FILL;
    }

    private dropUnused(): void {
        if (this.frames.size <= KEPT_FRAMES) return;
        const unused = [...this.frames.entries()]
            .filter(([key]) => !this.shown.has(key))
            .sort((a, b) => a[1].used - b[1].used)
            .slice(0, this.frames.size - KEPT_FRAMES);
        for (const [key] of unused) {
            if (this.map?.getLayer(key)) this.map.removeLayer(key);
            if (this.map?.getSource(key)) this.map.removeSource(key);
            this.frames.delete(key);
        }
    }
}

function imageName(icon: string, color: string): string {
    return `point|${icon}|${color}`;
}

/**
 * An mdi icon's path, as Home Assistant's own ha-icon finds it, as the card can't carry every icon's. Null for no icon,
 * and for one Home Assistant doesn't find in time, which then is drawn as a dot.
 */
async function iconPath(icon: string): Promise<string | null> {
    if (!icon) return null;
    const element = document.createElement("ha-icon");
    element.setAttribute("icon", icon);
    element.style.cssText = "position:absolute;visibility:hidden;pointer-events:none";
    document.body.append(element);
    try {
        const started = Date.now();
        while (Date.now() - started < ICON_TIMEOUT_MS) {
            const path = (element.shadowRoot?.querySelector("ha-svg-icon") as { path?: string } | null)?.path;
            if (path) return path;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return null;
    } finally {
        element.remove();
    }
}

/** A point's image: its icon, or a dot without one, in its colour with a dark shadow that keeps it apart from the map. */
function drawPoint(path: string | null, color: string): ImageData {
    const size = (ICON_PX + 2 * SHADOW_PX) * PIXEL_RATIO;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d")!;
    context.scale(PIXEL_RATIO, PIXEL_RATIO);
    context.shadowColor = "rgb(0 0 0 / 70%)";
    context.shadowBlur = 2 * PIXEL_RATIO;
    context.fillStyle = color;
    if (path) {
        context.translate(SHADOW_PX, SHADOW_PX);
        // mdi's paths are drawn on a 24 pixel grid.
        context.scale(ICON_PX / 24, ICON_PX / 24);
        context.fill(new Path2D(path));
    } else {
        context.beginPath();
        context.arc(ICON_PX / 2 + SHADOW_PX, ICON_PX / 2 + SHADOW_PX, 4, 0, 2 * Math.PI);
        context.fill();
    }
    return context.getImageData(0, 0, size, size);
}
