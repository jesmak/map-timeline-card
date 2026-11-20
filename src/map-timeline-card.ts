/**
 * A dashboard card that shows map layers live, each at its newest frame, or plays them on one timeline from the past
 * into the forecast.
 */
import { LitElement, css, html, nothing, unsafeCSS } from "lit";
import type { PropertyValues, TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";
import maplibreCss from "maplibre-gl/dist/maplibre-gl.css?raw";

import type { GeoJsonData } from "./geojson";
import "./editor";
import { eventOpacity, geoEvents } from "./geolocation";
import type { HomeAssistant } from "./hass";
import { gridMinRows } from "./height";
import { browserLanguage, translate } from "./localize/localize";
import { frameKey, TimelineMap, type DrawnFrame, type DrawnPoint, type DrawnShape, type MapView } from "./map";
import { ensureToken, MapError } from "./map-tiles";
import { readThemeColors } from "./map-theme";
import { isFeatureSource, parseOptions, type CardOptions, type SourceOptions } from "./options";
import { fillLimit, filledHeight, filledStyle, validRowStep, type RowStepConfig } from "./rows";
import { loadSource, type LoadedSource } from "./sources";
import { buildTimeline, defaultWindow, frameAt, frameFor, MIN_STEP, type Timeline } from "./time";

/** Replaced at build time with the version in package.json. */
declare const __CARD_VERSION__: string;

/** Home Assistant's own primary colour, for a theme that sets none. */
const DEFAULT_PRIMARY = "#03a9f4";
/** The card's border, above and below. */
const BORDER_PX = 2;
/**
 * The least height that still shows the bar while playing, the chips, and some map above them. The bar is drawn over
 * the map, so the map is never shorter than this.
 */
const MIN_HEIGHT_PX = 260;
/** How often the ages on the chips are redrawn between the sources' own updates. */
const TICK_MS = 30_000;
/** A source that couldn't be read is asked again after this long, whatever its step. */
const RETRY_S = 60;

console.info(
    `%c  MAP-TIMELINE-CARD \n%c  ${__CARD_VERSION__}    `,
    "color: orange; font-weight: bold; background: black",
    "color: white; font-weight: bold; background: dimgray",
);

const registry = window as unknown as { customCards?: Array<Record<string, unknown>> };
registry.customCards = registry.customCards ?? [];
if (!registry.customCards.some((card) => card.type === "map-timeline-card")) {
    registry.customCards.push({
        type: "map-timeline-card",
        name: translate(browserLanguage(), "card.name"),
        description: translate(browserLanguage(), "card.description"),
        documentationURL: "https://github.com/jesmak/map-timeline-card",
        preview: true,
    });
}

/** A source as the card holds it: what was read, and when its newest frame last changed. */
interface SourceState {
    loaded: LoadedSource | null;
    error: string;
    /** When its newest frame last changed, or when it was first read, in milliseconds. */
    advancedAt: number;
}

type Mode = "live" | "play";

export class MapTimelineCard extends LitElement {
    @property({ attribute: false }) public hass?: HomeAssistant;
    /** "grid" in a sections view, where the rows set in its layout tab hold the card to a height. */
    @property({ attribute: false }) public layout?: string;

    @state() private options?: CardOptions;
    @state() private sources: SourceState[] = [];
    @state() private enabled: boolean[] = [];
    @state() private mode: Mode = "live";
    @state() private playing = false;
    /** The time shown while playing, and the window played, in seconds. */
    @state() private at = 0;
    @state() private window: [number, number] = [0, 0];
    @state() private legendOpen = false;
    @state() private region = false;
    @state() private mapError = "";
    /** When a source was last read, in milliseconds. */
    @state() private updatedAt = 0;

    private config: RowStepConfig = {};
    private map?: TimelineMap;
    private mapStarting = false;
    private ticker?: ReturnType<typeof setInterval>;
    private player?: ReturnType<typeof setInterval>;
    private theme?: { key: string; colors: Record<string, string> | null };
    private sourcesKey = "";
    /** The next read of each source, by its place, and the sources being read now. Replaced when the sources change. */
    private timers = new Map<number, ReturnType<typeof setTimeout>>();
    private reading = new Set<number>();

    public static getConfigElement(): HTMLElement {
        return document.createElement("map-timeline-card-editor");
    }

    public static getStubConfig(): Record<string, unknown> {
        return { sources: [] };
    }

    public setConfig(config: Record<string, unknown>): void {
        const options = parseOptions(config);
        if (!validRowStep(config as RowStepConfig)) throw new Error(translate(browserLanguage(), "config.invalid_row_step"));
        // Only what places the card in the grid: map_height is its height, so the shared height modes aren't taken.
        const { grid_options, layout_options, row_step } = config as RowStepConfig;
        this.config = { grid_options, layout_options, row_step };
        const previous = this.options;
        this.options = options;
        // New sources are read again from the start; a change that leaves them as they were keeps what was read.
        const key = JSON.stringify(options.sources);
        if (key !== this.sourcesKey) {
            this.sourcesKey = key;
            this.stopSources();
            // A read still on its way finishes into the set it started in, not this one.
            this.reading = new Set();
            this.map?.clear();
            this.sources = options.sources.map(() => ({ loaded: null, error: "", advancedAt: 0 }));
            this.enabled = options.sources.map(() => true);
            this.goLive();
            if (this.isConnected && this.hass) this.startSources();
        }
        void this.map?.setStyle(options.mapStyle, this.dark(), this.themeColors());
        if (previous && (previous.zoom !== options.zoom || previous.regionZoom !== options.regionZoom || previous.zone !== options.zone)) {
            this.moveMap();
        }
    }

    public getCardSize(): number {
        return Math.ceil((this.options?.mapHeight ?? 440) / 50);
    }

    public getGridOptions(): Record<string, unknown> {
        return { columns: "full", min_columns: 6, rows: "auto", min_rows: gridMinRows(MIN_HEIGHT_PX) };
    }

    public connectedCallback(): void {
        super.connectedCallback();
        this.ticker = setInterval(() => this.requestUpdate(), TICK_MS);
        if (this.hass && this.options) this.startSources();
    }

    public disconnectedCallback(): void {
        super.disconnectedCallback();
        clearInterval(this.ticker);
        this.stopSources();
        this.pause();
        this.map?.destroy();
        this.map = undefined;
    }

    protected updated(changed: PropertyValues): void {
        if (changed.has("hass") && this.hass && !changed.get("hass")) this.startSources();
        if (this.hass && !this.map && !this.mapStarting && !this.mapError && this.renderRoot.querySelector(".map")) void this.startMap();
        if (changed.has("hass") && this.map) void this.map.setStyle(this.options!.mapStyle, this.dark(), this.themeColors());
        this.draw();
    }

    protected render(): TemplateResult | typeof nothing {
        if (!this.options || !this.hass) return nothing;
        const legends = this.options.sources
            .map((source, i) => ({ name: source.name, legend: this.enabled[i] ? this.sources[i]?.loaded?.legend : null }))
            .filter((entry) => entry.legend);
        const fill = fillLimit(this.config, this.layout, MIN_HEIGHT_PX) ? filledHeight(this.options.mapHeight + BORDER_PX, this.config) : 0;
        const held = filledStyle(this.config, this.layout, MIN_HEIGHT_PX, fill);
        return html`
            <ha-card style="--map-height:${this.options.mapHeight}px;${held}">
                <div class="map"></div>
                ${this.mapError ? html`<div class="map-error">${this.mapError}</div>` : nothing}
                <div class="corner">
                    ${
                        legends.length
                            ? html`<button
                                  class="round"
                                  @click=${() => (this.legendOpen = !this.legendOpen)}
                                  title=${this.text("controls.legend")}
                              >
                                  <ha-icon icon="mdi:palette-outline"></ha-icon>
                              </button>`
                            : nothing
                    }
                    <button class="round" @click=${this.toggleView} title=${this.text(this.region ? "controls.local" : "controls.region")}>
                        <ha-icon icon=${this.region ? "mdi:home-map-marker" : "mdi:map-outline"}></ha-icon>
                    </button>
                </div>
                ${
                    this.legendOpen && legends.length
                        ? html`<div class="legends">
                              ${legends.map(
                                  (entry) =>
                                      html`<h4>${entry.name}</h4>
                                          <img src=${entry.legend!} alt="" />`,
                              )}
                          </div>`
                        : nothing
                }
                <div class="overlay">${this.mode === "live" ? this.liveBar() : this.playBar()}${this.chips()}</div>
            </ha-card>
        `;
    }

    /* ---------------- the bar ---------------- */

    private liveBar(): TemplateResult {
        return html`<div class="bar">
            <button class="play" @click=${this.startPlaying} title=${this.text("controls.play")}>
                <ha-icon icon="mdi:play"></ha-icon>
            </button>
            <span class="badge live"><span class="dot"></span>${this.text("bar.live")}</span>
            <span class="updated">${this.updatedAt ? this.text("bar.updated", { time: this.clock(this.updatedAt / 1000) }) : ""}</span>
        </div>`;
    }

    private playBar(): TemplateResult {
        const timeline = this.timeline();
        const now = Date.now() / 1000;
        const ahead = this.at > now;
        const minutes = Math.round((this.at - now) / 60);
        const relative =
            Math.abs(minutes) < 1
                ? this.text("bar.now")
                : ahead
                  ? this.text("bar.ahead", { n: minutes })
                  : this.text("bar.ago", { n: -minutes });
        return html`<div class="bar">
                <button
                    class="play"
                    @click=${() => (this.playing ? this.pause() : this.play())}
                    title=${this.text(this.playing ? "controls.pause" : "controls.play")}
                >
                    <ha-icon icon=${this.playing ? "mdi:pause" : "mdi:play"}></ha-icon>
                </button>
                <span class=${classMap({ time: true, forecast: ahead })}
                    ><b>${this.clock(this.at)}</b><span class="relative">${relative}</span></span
                >
                <span class="window">${this.windowText()}</span>
                <button class="badge back" @click=${this.goLive} title=${this.text("controls.back_live")}>
                    <span class="dot"></span>${this.text("bar.live")}
                </button>
            </div>
            ${timeline ? this.track(timeline, now) : nothing}`;
    }

    private track(timeline: Timeline, now: number): TemplateResult {
        const first = timeline.times[0];
        const span = Math.max(1, timeline.times[timeline.times.length - 1] - first);
        const at = (time: number) => `${(Math.min(Math.max(time - first, 0), span) / span) * 100}%`;
        const nowAt = Math.min(Math.max(now, first), first + span);
        const [start, end] = this.window;
        return html`<div class="track-wrap">
            <div class="track" @pointerdown=${this.grab}>
                <div class="rail"><span class="past" style="width:${at(nowAt)}"></span><span class="ahead"></span></div>
                <div class="chosen" style="left:${at(start)};width:calc(${at(end)} - ${at(start)})">
                    <span
                        class="past"
                        style="width:${end > start ? (Math.min(Math.max(nowAt - start, 0), end - start) / (end - start)) * 100 : 0}%"
                    ></span
                    ><span class="ahead"></span>
                </div>
                ${now > first && now < first + span ? html`<span class="now-tick" style="left:${at(now)}"></span>` : nothing}
                ${this.options!.sources.flatMap((source, i) =>
                    this.enabled[i] && isFeatureSource(source.type) && source.timelineMarks
                        ? this.featureTimes(i)
                              .filter((time) => time >= first && time <= first + span)
                              .map((time) => html`<span class="mark" style="left:${at(time)};${colorStyle(source.color)}"></span>`)
                        : [],
                )}
                <span class="handle" data-handle="0" style="left:${at(start)}"></span>
                <span class="handle" data-handle="1" style="left:${at(end)}"></span>
                <span class="knob" style="left:${at(this.at)}"></span>
                <span class="label first">${this.clock(first)}</span>
                <span class="label last">${this.clock(first + span)}</span>
            </div>
        </div>`;
    }

    private chips(): TemplateResult {
        const now = Date.now() / 1000;
        if (!this.options!.sources.length) return html`<div class="chips empty">${this.text("bar.no_sources")}</div>`;
        return html`<div class="chips">
            ${this.options!.sources.map((source, i) => {
                const state = this.sources[i];
                const on = this.enabled[i];
                let note = "";
                let title = "";
                let warn = false;
                // A source that can't be read says so while playing too; its age and its loading are for live only.
                if (on && state.error) {
                    note = this.text("chip.failed");
                    title = this.text("chip.error", { reason: state.error });
                    warn = true;
                } else if (on && this.mode === "live" && isFeatureSource(source.type)) {
                    // Features have no frames to fall behind on, so their chip shows only how old the newest is.
                    const times = this.featureTimes(i);
                    if (source.type === "geojson" && !state.loaded) note = this.text("chip.loading");
                    else if (times.length) note = this.age(now - Math.max(...times));
                } else if (on && this.mode === "live") {
                    const loaded = state.loaded;
                    if (loaded?.kind !== "images") {
                        note = this.text("chip.loading");
                    } else {
                        const newest = frameAt(loaded.frames, now);
                        if (newest === null) {
                            note = this.text("chip.only_ahead");
                        } else {
                            note = this.age(now - newest);
                            const quiet = Date.now() - state.advancedAt;
                            if (quiet > source.staleSteps * loaded.step * 1000) {
                                warn = true;
                                title = this.text("chip.stale", { age: this.age(quiet / 1000) });
                            }
                        }
                    }
                }
                return html`<button class=${classMap({ chip: true, on, warn })} title=${title} @click=${() => this.toggleSource(i)}>
                    <ha-icon icon=${warn ? "mdi:alert-outline" : source.icon || "mdi:layers-outline"}></ha-icon>${source.name}${
                        note ? html`<span class="note">${note}</span>` : nothing
                    }
                </button>`;
            })}
        </div>`;
    }

    /* ---------------- live and playing ---------------- */

    private startPlaying = (): void => {
        const timeline = this.timeline();
        if (!timeline) return;
        const now = Date.now() / 1000;
        const [start, end] = defaultWindow(timeline, now);
        this.window = [timeline.times[start], timeline.times[end]];
        this.at = this.window[0];
        this.mode = "play";
        this.play();
    };

    private play(): void {
        clearInterval(this.player);
        this.playing = true;
        const timeline = this.timeline();
        if (!timeline) return;
        // A step of the timeline takes as long as the speed gives it: at 10 minutes a second, a five minute step half a second.
        const ms = (timeline.step / (this.options!.speed * 60)) * 1000;
        this.player = setInterval(() => {
            const times = this.timeline()?.times ?? [];
            const next = times.find((time) => time > this.at && time <= this.window[1]);
            this.at = next ?? times.find((time) => time >= this.window[0]) ?? this.window[0];
        }, ms);
    }

    private pause(): void {
        clearInterval(this.player);
        this.player = undefined;
        this.playing = false;
    }

    private goLive = (): void => {
        this.pause();
        this.mode = "live";
    };

    /** The timeline over the sources that are on and have been read. */
    private timeline(): Timeline | null {
        const images = this.sources.flatMap((source, i) => (this.enabled[i] && source.loaded?.kind === "images" ? [source.loaded] : []));
        // A feature source with times reaches from its history to now, past an image source's newest frame, which lags
        // behind now, so the newest features are played too. Its step counts only without image sources, as features have
        // no frames of their own.
        const now = Date.now() / 1000;
        const points = this.options!.sources.flatMap((source, i) =>
            this.enabled[i] && timed(source)
                ? [{ frames: [now - source.historyMinutes * 60, now], step: images.length ? Infinity : source.stepMinutes * 60 }]
                : [],
        );
        return buildTimeline([...images, ...points]);
    }

    /** Puts on the map what the card shows now: each source's newest frame live, or its frame at the time played. */
    private draw(): void {
        if (!this.map || !this.options) return;
        const now = Date.now() / 1000;
        const time = this.mode === "live" ? now : this.at;
        const timeline = this.mode === "play" ? this.timeline() : null;
        const next = timeline?.times.find((candidate) => candidate > this.at && candidate <= this.window[1]);
        const frames: DrawnFrame[] = [];
        const ahead: DrawnFrame[] = [];
        this.sources.forEach((source, i) => {
            const loaded = source.loaded;
            if (!this.enabled[i] || loaded?.kind !== "images") return;
            const frame = frameFor(loaded.frames, time, now);
            const options = this.options!.sources[i];
            const drawn = (at: number): DrawnFrame => ({
                key: frameKey(i, at),
                source: i,
                url: loaded.url(at),
                opacity: options.opacity,
                maxZoom: options.maxZoom ?? loaded.maxZoom,
            });
            if (frame !== null) frames.push(drawn(frame));
            const coming = next === undefined ? null : frameFor(loaded.frames, next, now);
            if (coming !== null && coming !== frame) ahead.push(drawn(coming));
        });
        this.map.show(frames, ahead);

        const points: DrawnPoint[] = [];
        const shapes: DrawnShape[] = [];
        const live = this.mode === "live";
        let primary = "";
        this.options.sources.forEach((source, i) => {
            if (!this.enabled[i] || !isFeatureSource(source.type)) return;
            const visibleFor = source.visibleMinutes * 60;
            const features = this.features(i);
            // Points and shapes are drawn by MapLibre, which can't read a CSS variable, so the theme's primary colour is
            // looked up for those that have no colour of their own.
            const colorOf = (own: string) => own || source.color || (primary ||= this.primaryColor());
            for (const event of features.points) {
                const opacity = eventOpacity(event, time, visibleFor, live, timed(source));
                if (opacity > 0) {
                    points.push({
                        key: `${i}:${event.key}`,
                        position: event.position,
                        icon: source.icon,
                        color: colorOf(event.color),
                        opacity,
                    });
                }
            }
            // A shape doesn't fade, as one half faded would look half over.
            for (const shape of features.shapes) {
                if (eventOpacity(shape, time, visibleFor, live, timed(source)) > 0)
                    shapes.push({ feature: shape.feature, color: colorOf("") });
            }
        });
        this.map.setPoints(points);
        this.map.setShapes(shapes);

        this.map.setAttribution(
            this.options.sources.flatMap((source, i) => {
                const credit = !this.enabled[i]
                    ? ""
                    : source.type === "geo_location"
                      ? source.attribution
                      : this.sources[i]?.loaded?.attribution;
                return credit ? [escapeHtml(credit)] : [];
            }),
        );
    }

    private primaryColor(): string {
        return getComputedStyle(this).getPropertyValue("--primary-color").trim() || DEFAULT_PRIMARY;
    }

    /** A feature source's points and shapes: a geo_location source's entities as they are in Home Assistant now, a GeoJSON source's as last read. */
    private features(i: number): GeoJsonData {
        const source = this.options!.sources[i];
        if (source.type === "geo_location") {
            return { points: this.hass ? geoEvents(this.hass.states, source.entitySource, source.timeAttribute) : [], shapes: [] };
        }
        const loaded = this.sources[i]?.loaded;
        return loaded?.kind === "features" ? loaded.data : { points: [], shapes: [] };
    }

    /** The times of a feature source's points and shapes, those that have one. */
    private featureTimes(i: number): number[] {
        const { points, shapes } = this.features(i);
        return [...points, ...shapes].flatMap((feature) => (feature.time === null ? [] : [feature.time]));
    }

    private toggleSource(i: number): void {
        this.enabled = this.enabled.map((on, j) => (j === i ? !on : on));
        if (this.mode === "play" && !this.timeline()) this.goLive();
        else if (this.playing) this.play();
    }

    /* ---------------- the window's handles and the playhead ---------------- */

    private grab = (event: PointerEvent): void => {
        const track = event.currentTarget as HTMLElement;
        const timeline = this.timeline();
        if (!timeline) return;
        const handle = (event.target as HTMLElement).closest<HTMLElement>(".handle");
        const which = handle ? Number(handle.dataset.handle) : -1;
        const wasPlaying = this.playing;
        this.pause();
        track.setPointerCapture(event.pointerId);
        const times = timeline.times;
        const timeAt = (x: number) => {
            const box = track.getBoundingClientRect();
            const share = Math.min(Math.max((x - box.left) / box.width, 0), 1);
            const target = times[0] + share * (times[times.length - 1] - times[0]);
            return times.reduce((best, time) => (Math.abs(time - target) < Math.abs(best - target) ? time : best));
        };
        const move = (x: number) => {
            const time = timeAt(x);
            if (which === 0) this.window = [Math.min(time, previousOf(times, this.window[1])), this.window[1]];
            else if (which === 1) this.window = [this.window[0], Math.max(time, nextOf(times, this.window[0]))];
            // The map shows the frame at the handle being moved, so the window's start shows what the map looked like then.
            this.at =
                which === 0 ? this.window[0] : which === 1 ? this.window[1] : Math.min(Math.max(time, this.window[0]), this.window[1]);
        };
        move(event.clientX);
        const onMove = (moved: PointerEvent) => move(moved.clientX);
        track.addEventListener("pointermove", onMove);
        // Lost when the pointer is lifted and when the browser cancels the drag for a gesture of its own alike.
        track.addEventListener(
            "lostpointercapture",
            () => {
                track.removeEventListener("pointermove", onMove);
                if (wasPlaying && which >= 0) this.play();
            },
            { once: true },
        );
    };

    /* ---------------- sources ---------------- */

    /**
     * Reads every source that has no read due and none on its way. The card is taken off the page and put back when its
     * dashboard is edited or another view is shown, and its sources stop meanwhile, so they are read again at once.
     */
    private startSources(): void {
        this.sources.forEach((_source, i) => {
            // A geo_location source is Home Assistant's own state, which comes with every update of the card.
            if (this.options!.sources[i].type === "geo_location") return;
            if (!this.timers.has(i) && !this.reading.has(i)) void this.readSource(i);
        });
    }

    private stopSources(): void {
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
    }

    private async readSource(i: number): Promise<void> {
        const options = this.options!.sources[i];
        const key = this.sourcesKey;
        const reading = this.reading;
        reading.add(i);
        let next = RETRY_S;
        try {
            const loaded = await loadSource(options, Date.now() / 1000);
            if (key !== this.sourcesKey) return;
            const step = this.timeline()?.step;
            const before = this.sources[i];
            const newest = (source: LoadedSource | null) =>
                source?.kind === "images" ? source.frames[source.frames.length - 1] : undefined;
            const advanced = !before.loaded || newest(before.loaded) !== newest(loaded);
            this.sources = this.sources.map((source, j) =>
                j === i ? { ...source, loaded, error: "", advancedAt: advanced ? Date.now() : source.advancedAt } : source,
            );
            this.updatedAt = Date.now();
            next = Math.max(MIN_STEP, loaded.step);
            // A source read for the first time can change the timeline's step, and the speed is kept in source time.
            if (this.playing && this.timeline()?.step !== step) this.play();
        } catch (error) {
            if (key !== this.sourcesKey) return;
            const reason = error instanceof Error ? error.message : String(error);
            console.warn(`map-timeline-card: ${options.name} couldn't be read:`, reason);
            this.sources = this.sources.map((source, j) => (j === i ? { ...source, error: reason } : source));
        } finally {
            reading.delete(i);
        }
        if (!this.isConnected) return;
        this.timers.set(
            i,
            setTimeout(() => {
                this.timers.delete(i);
                void this.readSource(i);
            }, next * 1000),
        );
    }

    /* ---------------- the map ---------------- */

    private async startMap(): Promise<void> {
        this.mapStarting = true;
        const map = new TimelineMap(
            this.renderRoot.querySelector<HTMLElement>(".map")!,
            this.options!.mapStyle,
            this.dark(),
            this.themeColors(),
            {
                "CooperativeGesturesHandler.WindowsHelpText": this.text("gestures.windows"),
                "CooperativeGesturesHandler.MacHelpText": this.text("gestures.mac"),
                "CooperativeGesturesHandler.MobileHelpText": this.text("gestures.mobile"),
            },
            this.view(),
        );
        try {
            await ensureToken(this.hass!);
            await map.init();
            if (!this.isConnected) {
                map.destroy();
                return;
            }
            this.map = map;
            this.mapError = "";
            this.requestUpdate();
        } catch (error) {
            map.destroy();
            this.mapError = this.text(`map_error.${error instanceof MapError ? error.reason : "style"}`);
            console.error("map-timeline-card:", error);
        } finally {
            this.mapStarting = false;
        }
    }

    private toggleView = (): void => {
        this.region = !this.region;
        this.moveMap();
    };

    private moveMap(): void {
        this.map?.jumpTo(this.view(), this.home());
    }

    private view(): MapView {
        return { center: this.home(), zoom: this.region ? this.options!.regionZoom : this.options!.zoom };
    }

    /** The zone's centre, or Home Assistant's home, as [longitude, latitude]. */
    private home(): [number, number] {
        const zone = this.options?.zone ? this.hass?.states[this.options.zone]?.attributes : undefined;
        const latitude = typeof zone?.latitude === "number" ? zone.latitude : this.hass?.config?.latitude;
        const longitude = typeof zone?.longitude === "number" ? zone.longitude : this.hass?.config?.longitude;
        return typeof latitude === "number" && typeof longitude === "number" ? [longitude, latitude] : [0, 0];
    }

    /** Read inside the card's shadow root: a probe in the card's own light DOM isn't rendered, so the browser computes nothing for it. */
    private themeColors(): Record<string, string> | null {
        const theme = `${this.hass?.themes?.theme}|${this.hass?.selectedTheme?.theme}|${this.dark()}`;
        if (theme === this.theme?.key) return this.theme.colors;
        const card = this.renderRoot?.querySelector?.("ha-card");
        if (!(card instanceof HTMLElement)) return null;
        this.theme = { key: theme, colors: readThemeColors(card) };
        return this.theme.colors;
    }

    private dark(): boolean {
        return this.hass?.themes?.darkMode === true;
    }

    /* ---------------- texts ---------------- */

    private text(key: string, values: Record<string, string | number> = {}): string {
        const language = this.hass?.locale?.language ?? this.hass?.language ?? browserLanguage();
        return translate(language, key).replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ""));
    }

    private clock(seconds: number): string {
        const language = this.hass?.locale?.language ?? this.hass?.language ?? browserLanguage();
        return new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit" }).format(seconds * 1000);
    }

    private age(seconds: number): string {
        const minutes = Math.max(0, Math.round(seconds / 60));
        if (minutes < 60) return this.text("age.minutes", { n: minutes });
        const [h, m] = [Math.floor(minutes / 60), minutes % 60];
        return m ? this.text("age.hours_minutes", { h, m }) : this.text("age.hours", { h });
    }

    private windowText(): string {
        const [start, end] = this.window;
        return this.text("bar.window", { from: this.clock(start), to: this.clock(end), length: this.age(end - start) });
    }

    static styles = [
        unsafeCSS(maplibreCss),
        css`
            :host {
                display: block;
                height: 100%;
            }
            ha-card {
                position: relative;
                overflow: hidden;
                height: var(--map-height);
                box-sizing: border-box;
                container-type: inline-size;
                --mtc-forecast: var(--accent-color, #b48ead);
                --mtc-live: var(--success-color, #43a047);
                --mtc-bar: color-mix(in srgb, var(--card-background-color, var(--ha-card-background, #fff)) 85%, transparent);
            }
            .map {
                position: absolute;
                inset: 0;
                background: var(--secondary-background-color);
            }
            .map-error {
                position: absolute;
                inset: 0;
                display: grid;
                place-items: center;
                padding: 16px;
                text-align: center;
                color: var(--secondary-text-color);
            }
            .home-marker {
                color: var(--primary-text-color);
                --mdc-icon-size: 22px;
                filter: drop-shadow(0 0 2px var(--card-background-color, #000));
            }
            .mark {
                position: absolute;
                top: 1px;
                width: 4px;
                height: 6px;
                margin-left: -2px;
                border-radius: 1px;
                background: var(--point-color, var(--primary-color));
            }
            button {
                font: inherit;
                color: inherit;
                cursor: pointer;
            }
            .corner {
                position: absolute;
                z-index: 2;
                top: 44px;
                right: 10px;
                display: flex;
                flex-direction: column;
                gap: 8px;
            }
            .round {
                width: 29px;
                height: 29px;
                padding: 0;
                border: none;
                border-radius: 50%;
                display: grid;
                place-items: center;
                background: var(--mtc-bar);
                --mdc-icon-size: 18px;
            }
            .legends {
                position: absolute;
                z-index: 3;
                top: 10px;
                right: 48px;
                max-width: calc(100% - 64px);
                max-height: calc(100% - 140px);
                overflow: auto;
                padding: 8px 10px;
                border-radius: 6px;
                /* Servers draw their legends for a white page. */
                background: #fff;
                color: #212121;
                font-size: 12px;
            }
            .legends h4 {
                margin: 6px 0 4px;
                font-weight: 500;
            }
            .legends h4:first-child {
                margin-top: 0;
            }
            .legends img {
                display: block;
                max-width: 100%;
            }
            .overlay {
                position: absolute;
                z-index: 2;
                left: 0;
                right: 0;
                bottom: 0;
                background: var(--mtc-bar);
            }
            .bar {
                display: flex;
                align-items: center;
                gap: 8px;
                min-height: 44px;
                padding: 4px 10px 0 4px;
            }
            .play {
                flex: none;
                width: 36px;
                height: 36px;
                padding: 0;
                border: none;
                border-radius: 50%;
                background: none;
                display: grid;
                place-items: center;
            }
            .badge {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                padding: 3px 10px;
                border-radius: 14px;
                font-size: 13px;
                font-weight: 500;
                white-space: nowrap;
            }
            .badge .dot {
                width: 8px;
                height: 8px;
                border-radius: 50%;
                background: var(--mtc-live);
            }
            .badge.live {
                color: var(--mtc-live);
                background: color-mix(in srgb, var(--mtc-live) 18%, transparent);
            }
            .badge.live .dot {
                animation: pulse 2s infinite;
            }
            .badge.back {
                margin-left: auto;
                border: 1px solid var(--divider-color);
                background: none;
            }
            .badge.back .dot {
                background: none;
                border: 2px solid var(--mtc-live);
                width: 6px;
                height: 6px;
            }
            @keyframes pulse {
                50% {
                    opacity: 0.3;
                }
            }
            @media (prefers-reduced-motion: reduce) {
                .badge.live .dot {
                    animation: none;
                }
            }
            .updated,
            .window {
                font-size: 12px;
                color: var(--secondary-text-color);
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                min-width: 0;
            }
            .window {
                flex: 1;
                text-align: right;
            }
            /* On a narrow card the window's times don't fit beside the time played, and its handles on the track show it. */
            @container (max-width: 600px) {
                .window {
                    display: none;
                }
                .badge.back {
                    margin-left: auto;
                }
            }
            .time {
                white-space: nowrap;
                font-variant-numeric: tabular-nums;
            }
            .time b {
                font-size: 16px;
                font-weight: 500;
            }
            .time .relative {
                margin-left: 6px;
                font-size: 13px;
                color: var(--secondary-text-color);
            }
            .time.forecast b,
            .time.forecast .relative {
                color: var(--mtc-forecast);
            }
            .track-wrap {
                padding: 0 14px;
            }
            .track {
                position: relative;
                height: 38px;
                touch-action: none;
                user-select: none;
                cursor: pointer;
            }
            .rail,
            .chosen {
                position: absolute;
                top: 13px;
                height: 4px;
                display: flex;
                overflow: hidden;
                border-radius: 2px;
            }
            .rail {
                left: 0;
                right: 0;
                opacity: 0.3;
            }
            .past {
                background: var(--state-icon-color, var(--primary-color));
            }
            .ahead {
                flex: 1;
                background: var(--mtc-forecast);
            }
            .chosen .ahead {
                background: repeating-linear-gradient(
                    90deg,
                    var(--mtc-forecast) 0 6px,
                    color-mix(in srgb, var(--mtc-forecast) 45%, transparent) 6px 9px
                );
            }
            .now-tick {
                position: absolute;
                top: 8px;
                width: 2px;
                height: 14px;
                margin-left: -1px;
                background: var(--primary-text-color);
            }
            .handle {
                position: absolute;
                top: 6px;
                width: 10px;
                height: 18px;
                margin-left: -5px;
                border-radius: 3px;
                background: var(--primary-text-color);
                cursor: ew-resize;
            }
            .knob {
                position: absolute;
                top: 8px;
                width: 14px;
                height: 14px;
                margin-left: -7px;
                border-radius: 50%;
                background: var(--primary-text-color);
                box-shadow: 0 0 3px rgb(0 0 0 / 50%);
                pointer-events: none;
            }
            .label {
                position: absolute;
                top: 22px;
                font-size: 10px;
                color: var(--secondary-text-color);
            }
            .label.last {
                right: 0;
            }
            .chips {
                display: flex;
                gap: 6px;
                overflow-x: auto;
                padding: 4px 12px 10px;
                scrollbar-width: none;
            }
            .chips.empty {
                font-size: 13px;
                color: var(--secondary-text-color);
            }
            .chip {
                display: inline-flex;
                align-items: center;
                gap: 4px;
                flex: none;
                padding: 3px 10px 3px 7px;
                border: 1px solid var(--divider-color);
                border-radius: 16px;
                background: none;
                font-size: 13px;
                white-space: nowrap;
                --mdc-icon-size: 16px;
            }
            .chip.on {
                border-color: var(--primary-color);
                background: color-mix(in srgb, var(--primary-color) 35%, transparent);
            }
            .chip .note {
                margin-left: 2px;
                font-size: 12px;
                color: var(--secondary-text-color);
            }
            .chip.warn {
                border-color: var(--warning-color, #ffa600);
            }
            .chip.warn .note,
            .chip.warn ha-icon {
                color: var(--warning-color, #ffa600);
            }
            .maplibregl-ctrl-attrib {
                font-size: 11px;
            }
        `,
    ];
}

function previousOf(times: number[], time: number): number {
    return [...times].reverse().find((candidate) => candidate < time) ?? time;
}

function nextOf(times: number[], time: number): number {
    return times.find((candidate) => candidate > time) ?? time;
}

/** Whether a feature source's features have times: a geo_location entity's from its attribute, a GeoJSON feature's from its property. */
function timed(source: SourceOptions): boolean {
    return source.type === "geo_location" || (source.type === "geojson" && source.timeProperty !== "");
}

/** A colour of the user's own, or the theme's primary colour through the stylesheet. */
function colorStyle(color: string): string {
    return color ? `--point-color:${color}` : "";
}

function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

// A copy loaded twice, such as one installed by hand beside the Marketplace's, registers only once.
if (!customElements.get("map-timeline-card")) customElements.define("map-timeline-card", MapTimelineCard);
