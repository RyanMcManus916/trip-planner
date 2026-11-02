
/* -------------------------------------------------------------------------
   MiniLeaflet: an embedded compatibility fallback for locally opened files
   -------------------------------------------------------------------------
   Some iOS browsers block external map-library files when an HTML file is opened locally. This embedded compatibility engine keeps the map available. Some iOS browsers
   open downloaded HTML files inside an edge:// or file:// security context
   that blocks external CDN JavaScript. When that happens, this compact map
   engine supplies the small subset of the Leaflet API used by this planner.
   Online OpenStreetMap/Topo tiles and online routing/geocoding still require
   internet access.
*/
(function installEmbeddedMapFallback(global) {
  "use strict";
  if (global.L) return;

  const TILE_SIZE = 256;
  const MIN_ZOOM = 2;
  let layerSequence = 0;

  const clampValue = (value, min, max) => Math.min(max, Math.max(min, value));
  const toLatLng = (value) => {
    if (Array.isArray(value)) return { lat: Number(value[0]), lng: Number(value[1]) };
    return { lat: Number(value.lat), lng: Number(value.lng) };
  };

  function project(latLng, zoom) {
    const lat = clampValue(Number(latLng.lat), -85.05112878, 85.05112878);
    const lng = Number(latLng.lng);
    const scale = TILE_SIZE * Math.pow(2, zoom);
    const sin = Math.sin(lat * Math.PI / 180);
    return {
      x: (lng + 180) / 360 * scale,
      y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale
    };
  }

  function unproject(point, zoom) {
    const scale = TILE_SIZE * Math.pow(2, zoom);
    const lng = point.x / scale * 360 - 180;
    const n = Math.PI - 2 * Math.PI * point.y / scale;
    const lat = 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    return { lat: clampValue(lat, -85.05112878, 85.05112878), lng };
  }

  function positionElement(element, x, y) {
    element.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
  }

  class Bounds {
    constructor(points) {
      this.minLat = Infinity;
      this.minLng = Infinity;
      this.maxLat = -Infinity;
      this.maxLng = -Infinity;
      (points || []).forEach((point) => this.extend(point));
    }

    extend(point) {
      if (!point) return this;
      const ll = toLatLng(point);
      if (!Number.isFinite(ll.lat) || !Number.isFinite(ll.lng)) return this;
      this.minLat = Math.min(this.minLat, ll.lat);
      this.minLng = Math.min(this.minLng, ll.lng);
      this.maxLat = Math.max(this.maxLat, ll.lat);
      this.maxLng = Math.max(this.maxLng, ll.lng);
      return this;
    }

    isValid() {
      return Number.isFinite(this.minLat) && Number.isFinite(this.minLng)
        && Number.isFinite(this.maxLat) && Number.isFinite(this.maxLng);
    }

    getCenter() {
      if (!this.isValid()) return { lat: 0, lng: 0 };
      return { lat: (this.minLat + this.maxLat) / 2, lng: (this.minLng + this.maxLng) / 2 };
    }

    getSouthWest() { return { lat: this.minLat, lng: this.minLng }; }
    getNorthEast() { return { lat: this.maxLat, lng: this.maxLng }; }
  }

  class Evented {
    constructor() { this._events = new Map(); }
    on(type, handler) {
      if (typeof handler !== "function") return this;
      if (!this._events.has(type)) this._events.set(type, new Set());
      this._events.get(type).add(handler);
      return this;
    }
    _emit(type, detail) {
      const handlers = this._events.get(type);
      if (!handlers) return;
      handlers.forEach((handler) => {
        try { handler(detail || {}); } catch (error) { console.warn("Map event handler failed", error); }
      });
    }
  }

  class TileLayer extends Evented {
    constructor(urlTemplate, options) {
      super();
      this.urlTemplate = String(urlTemplate || "");
      this.options = options || {};
      this._id = `tile-${++layerSequence}`;
      this._map = null;
    }
    addTo(map) {
      this._map = map;
      map._setBaseLayer(this);
      return this;
    }
    _tileUrl(z, x, y) {
      const subdomains = this.options.subdomains || "abc";
      const subdomain = String(subdomains)[Math.abs(x + y) % Math.max(1, String(subdomains).length)] || "a";
      return this.urlTemplate
        .replace(/\{s\}/g, subdomain)
        .replace(/\{z\}/g, String(z))
        .replace(/\{x\}/g, String(x))
        .replace(/\{y\}/g, String(y));
    }
  }

  class LayerGroup {
    constructor() {
      this._layers = new Set();
      this._map = null;
    }
    addTo(map) {
      this._map = map;
      this._layers.forEach((layer) => map._attachLayer(layer));
      return this;
    }
    addLayer(layer) {
      if (!layer) return this;
      this._layers.add(layer);
      layer._parentGroup = this;
      if (this._map) this._map._attachLayer(layer);
      return this;
    }
    removeLayer(layer) {
      if (!layer || !this._layers.has(layer)) return this;
      if (this._map) this._map._detachLayer(layer);
      this._layers.delete(layer);
      return this;
    }
    clearLayers() {
      Array.from(this._layers).forEach((layer) => this.removeLayer(layer));
      return this;
    }
    hasLayer(layer) { return this._layers.has(layer); }
  }

  class Marker {
    constructor(latLng, options) {
      this.latLng = toLatLng(latLng);
      this.options = options || {};
      this._map = null;
      this._element = null;
      this._popupHtml = "";
    }
    bindPopup(html) { this._popupHtml = String(html || ""); return this; }
    addTo(target) {
      if (target instanceof LayerGroup) target.addLayer(this);
      else target._attachLayer(this);
      return this;
    }
    _onAdd(map) {
      if (this._map === map && this._element) return;
      this._map = map;
      const element = document.createElement("div");
      element.className = `leaflet-marker-icon leaflet-zoom-animated leaflet-interactive ${this.options.icon?.options?.className || ""}`.trim();
      element.setAttribute("role", "button");
      element.setAttribute("tabindex", "0");
      element.setAttribute("aria-label", "Open map location details");
      element.innerHTML = this.options.icon?.options?.html || "";
      const iconSize = this.options.icon?.options?.iconSize || [30, 30];
      element.style.width = `${iconSize[0]}px`;
      element.style.height = `${iconSize[1]}px`;
      element.style.zIndex = String(600 + (Number(this.options.zIndexOffset) || 0));
      const open = (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.openPopup();
      };
      element.addEventListener("click", open);
      element.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") open(event);
      });
      this._element = element;
      map._markerPane.appendChild(element);
      this._render();
    }
    _render() {
      if (!this._map || !this._element) return;
      const point = this._map._latLngToPoint(this.latLng);
      const anchor = this.options.icon?.options?.iconAnchor || [15, 29];
      positionElement(this._element, point.x - anchor[0], point.y - anchor[1]);
      this._element.style.zIndex = String(Math.round(point.y) + 600 + (Number(this.options.zIndexOffset) || 0));
      if (this._map._popupMarker === this) this._map._positionPopup();
    }
    _onRemove() {
      if (this._map?._popupMarker === this) this._map._closePopup();
      this._element?.remove();
      this._element = null;
      this._map = null;
    }
    openPopup() {
      if (this._map && this._popupHtml) this._map._openPopup(this, this._popupHtml);
      return this;
    }
  }

  class Polyline {
    constructor(latLngs, options) {
      this.latLngs = (latLngs || []).map(toLatLng);
      this.options = options || {};
      this._map = null;
      this._path = null;
    }
    addTo(target) {
      if (target instanceof LayerGroup) target.addLayer(this);
      else target._attachLayer(this);
      return this;
    }
    _onAdd(map) {
      if (this._map === map && this._path) return;
      this._map = map;
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", this.options.color || "#3388ff");
      path.setAttribute("stroke-width", String(this.options.weight || 3));
      path.setAttribute("stroke-opacity", String(this.options.opacity ?? 1));
      path.setAttribute("stroke-linecap", this.options.lineCap || "round");
      path.setAttribute("stroke-linejoin", this.options.lineJoin || "round");
      if (this.options.dashArray) path.setAttribute("stroke-dasharray", String(this.options.dashArray));
      this._path = path;
      map._overlayPane.appendChild(path);
      this._render();
    }
    _render() {
      if (!this._map || !this._path || !this.latLngs.length) return;
      let pathData = "";
      let previous = null;
      this.latLngs.forEach((latLng, index) => {
        const point = this._map._latLngToPoint(latLng);
        const isLast = index === this.latLngs.length - 1;
        if (previous && !isLast && Math.abs(point.x - previous.x) < 0.7 && Math.abs(point.y - previous.y) < 0.7) return;
        pathData += `${pathData ? "L" : "M"}${point.x.toFixed(1)} ${point.y.toFixed(1)} `;
        previous = point;
      });
      this._path.setAttribute("d", pathData.trim());
    }
    _onRemove() {
      this._path?.remove();
      this._path = null;
      this._map = null;
    }
    getBounds() { return new Bounds(this.latLngs); }
  }

  class Control {
    constructor(options) {
      this.options = options || {};
      this.onAdd = null;
      this._container = null;
      this._map = null;
    }
    addTo(map) {
      this._map = map;
      const container = typeof this.onAdd === "function" ? this.onAdd(map) : document.createElement("div");
      this._container = container;
      if (!container.classList.contains("leaflet-control")) container.classList.add("leaflet-control");
      map._addControlElement(container, this.options.position || "topright");
      return this;
    }
  }

  class LayersControl extends Control {
    constructor(baseLayers, overlays, options) {
      super(options || {});
      this.baseLayers = baseLayers || {};
      this.overlays = overlays || {};
      this._layerInputs = [];
    }
    _syncSelection() {
      this._layerInputs.forEach(({ input, layer }) => {
        input.checked = layer === this._map?._baseLayer;
      });
    }
    addTo(map) {
      this._map = map;
      const details = document.createElement("details");
      details.className = "leaflet-control leaflet-control-layers";
      const summary = document.createElement("summary");
      summary.className = "leaflet-control-layers-toggle";
      summary.setAttribute("aria-label", "Choose map layer");
      summary.textContent = "Layers";
      const list = document.createElement("div");
      list.className = "leaflet-control-layers-list";
      const groupName = `mini-map-layer-${Math.random().toString(36).slice(2)}`;
      Object.entries(this.baseLayers).forEach(([name, layer], index) => {
        const label = document.createElement("label");
        const input = document.createElement("input");
        input.type = "radio";
        input.name = groupName;
        input.checked = layer === map._baseLayer || (!map._baseLayer && index === 0);
        input.disabled = Boolean(layer?.options?.disabled);
        if (input.disabled && layer?.options?.disabledReason) label.title = layer.options.disabledReason;
        this._layerInputs.push({ input, layer });
        input.addEventListener("change", () => {
          if (input.checked) {
            map._setBaseLayer(layer);
            details.open = false;
          }
        });
        const text = document.createElement("span");
        text.textContent = name;
        label.append(input, text);
        list.appendChild(label);
      });
      details.append(summary, list);
      ["click", "dblclick", "pointerdown", "touchstart", "wheel"].forEach((type) => {
        details.addEventListener(type, (event) => event.stopPropagation(), { passive: type === "touchstart" });
      });
      this._container = details;
      map._layerControls?.add(this);
      this._syncSelection();
      map._addControlElement(details, this.options.position || "topright");
      return this;
    }
  }

  class MiniMap {
    constructor(containerOrId, options) {
      this.options = options || {};
      this._container = typeof containerOrId === "string" ? document.getElementById(containerOrId) : containerOrId;
      if (!this._container) throw new Error("Map container not found");
      this._container.innerHTML = "";
      this._container.classList.add("leaflet-container", "mini-leaflet");
      this._container.setAttribute("data-map-engine", "embedded-fallback");
      this._zoom = Number.isFinite(Number(this.options.zoom)) ? Number(this.options.zoom) : 6;
      this._center = toLatLng(this.options.center || [0, 0]);
      this._renderables = new Set();
      this._baseLayer = null;
      this._layerControls = new Set();
      this._tiles = new Map();
      this._tileGeneration = 0;
      this._popup = null;
      this._popupMarker = null;
      this._renderFrame = 0;
      this._pointers = new Map();
      this._dragState = null;
      this._pinchState = null;

      this._buildDom();
      this._bindInteractions();
      if (this.options.zoomControl !== false) this._addZoomControl();
      (this.options.layers || []).forEach((layer) => layer.addTo(this));
      this.setView(this._center, this._zoom);
    }

    _buildDom() {
      const mapPane = document.createElement("div");
      mapPane.className = "leaflet-pane leaflet-map-pane";
      const tilePane = document.createElement("div");
      tilePane.className = "leaflet-pane leaflet-tile-pane";
      const overlayPane = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      overlayPane.setAttribute("class", "leaflet-pane leaflet-overlay-pane");
      overlayPane.setAttribute("aria-hidden", "true");
      const markerPane = document.createElement("div");
      markerPane.className = "leaflet-pane leaflet-marker-pane";
      const popupPane = document.createElement("div");
      popupPane.className = "leaflet-pane leaflet-popup-pane";
      mapPane.append(tilePane, overlayPane, markerPane, popupPane);
      this._container.appendChild(mapPane);
      this._mapPane = mapPane;
      this._tilePane = tilePane;
      this._overlayPane = overlayPane;
      this._markerPane = markerPane;
      this._popupPane = popupPane;

      const controlContainer = document.createElement("div");
      controlContainer.className = "leaflet-control-container";
      const positions = ["topleft", "topright", "bottomleft", "bottomright"];
      this._controlCorners = {};
      positions.forEach((position) => {
        const corner = document.createElement("div");
        corner.className = `leaflet-${position.startsWith("top") ? "top" : "bottom"} leaflet-${position.endsWith("left") ? "left" : "right"}`;
        controlContainer.appendChild(corner);
        this._controlCorners[position] = corner;
      });
      this._container.appendChild(controlContainer);
      this._controlContainer = controlContainer;

      const attribution = document.createElement("div");
      attribution.className = "leaflet-control leaflet-control-attribution";
      attribution.innerHTML = "Map data &copy; <a href=\"https://www.openstreetmap.org/copyright\" target=\"_blank\" rel=\"noopener noreferrer\">OpenStreetMap contributors</a>";
      this._attributionElement = attribution;
      this._addControlElement(attribution, "bottomright");
    }

    _addZoomControl() {
      const wrapper = document.createElement("div");
      wrapper.className = "leaflet-control leaflet-bar leaflet-control-zoom";
      const plus = document.createElement("button");
      plus.type = "button";
      plus.className = "leaflet-control-zoom-in";
      plus.setAttribute("aria-label", "Zoom in");
      plus.textContent = "+";
      const minus = document.createElement("button");
      minus.type = "button";
      minus.className = "leaflet-control-zoom-out";
      minus.setAttribute("aria-label", "Zoom out");
      minus.textContent = "−";
      plus.addEventListener("click", (event) => { event.stopPropagation(); this.setView(this._center, this._zoom + 1); });
      minus.addEventListener("click", (event) => { event.stopPropagation(); this.setView(this._center, this._zoom - 1); });
      wrapper.append(plus, minus);
      this._addControlElement(wrapper, "topleft");
    }

    _addControlElement(element, position) {
      const corner = this._controlCorners[position] || this._controlCorners.topright;
      corner.appendChild(element);
    }

    _bindInteractions() {
      const ignoreDragTarget = (target) => Boolean(target?.closest?.(".leaflet-control, .leaflet-marker-icon, .leaflet-popup, button, a, input, select, textarea, label"));

      this._container.addEventListener("pointerdown", (event) => {
        if (ignoreDragTarget(event.target)) return;
        this._pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        try { this._container.setPointerCapture(event.pointerId); } catch (_) { /* optional */ }
        if (this._pointers.size === 1) {
          this._dragState = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            centerWorld: project(this._center, this._zoom)
          };
          this._container.classList.add("is-dragging");
        } else if (this._pointers.size === 2) {
          const points = Array.from(this._pointers.values());
          this._pinchState = { distance: Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) };
          this._dragState = null;
        }
        event.preventDefault();
      });

      this._container.addEventListener("pointermove", (event) => {
        if (!this._pointers.has(event.pointerId)) return;
        this._pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (this._pointers.size >= 2 && this._pinchState) {
          const points = Array.from(this._pointers.values());
          const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
          if (distance > this._pinchState.distance * 1.35) {
            this._pinchState.distance = distance;
            this.setView(this._center, this._zoom + 1);
          } else if (distance < this._pinchState.distance * 0.74) {
            this._pinchState.distance = distance;
            this.setView(this._center, this._zoom - 1);
          }
          event.preventDefault();
          return;
        }
        if (!this._dragState || this._dragState.pointerId !== event.pointerId) return;
        const dx = event.clientX - this._dragState.x;
        const dy = event.clientY - this._dragState.y;
        this._center = unproject({ x: this._dragState.centerWorld.x - dx, y: this._dragState.centerWorld.y - dy }, this._zoom);
        this._scheduleRender();
        event.preventDefault();
      });

      const endPointer = (event) => {
        this._pointers.delete(event.pointerId);
        if (this._pointers.size < 2) this._pinchState = null;
        if (this._pointers.size === 0) {
          this._dragState = null;
          this._container.classList.remove("is-dragging");
        }
      };
      this._container.addEventListener("pointerup", endPointer);
      this._container.addEventListener("pointercancel", endPointer);

      this._container.addEventListener("wheel", (event) => {
        if (ignoreDragTarget(event.target)) return;
        event.preventDefault();
        this.setView(this._center, this._zoom + (event.deltaY < 0 ? 1 : -1));
      }, { passive: false });

      this._container.addEventListener("dblclick", (event) => {
        if (ignoreDragTarget(event.target)) return;
        event.preventDefault();
        this.setView(this._center, this._zoom + 1);
      });

      this._container.addEventListener("click", (event) => {
        if (!event.target.closest(".leaflet-popup, .leaflet-marker-icon, .leaflet-control")) this._closePopup();
      });
    }

    _setBaseLayer(layer) {
      if (!layer) return;
      if (this._baseLayer === layer) return;
      if (this._baseLayer) this._baseLayer._map = null;
      this._baseLayer = layer;
      layer._map = this;
      if (this._attributionElement) {
        this._attributionElement.innerHTML = layer.options?.attribution || "Map data";
      }
      this._layerControls.forEach((control) => control._syncSelection?.());
      this._container.dispatchEvent(new CustomEvent("tripplanner:baselayerchange", {
        detail: { providerKey: layer.options?.providerKey || "" }
      }));
      this._tiles.forEach((tile) => tile.remove());
      this._tiles.clear();
      this._renderTiles();
    }

    _attachLayer(layer) {
      if (!layer || this._renderables.has(layer)) return;
      this._renderables.add(layer);
      layer._onAdd?.(this);
      this._scheduleRender();
    }

    _detachLayer(layer) {
      if (!layer || !this._renderables.has(layer)) return;
      this._renderables.delete(layer);
      layer._onRemove?.();
      this._scheduleRender();
    }

    _latLngToPoint(latLng) {
      const size = this._getSize();
      const centerWorld = project(this._center, this._zoom);
      const point = project(toLatLng(latLng), this._zoom);
      return { x: point.x - centerWorld.x + size.width / 2, y: point.y - centerWorld.y + size.height / 2 };
    }

    _getSize() {
      return {
        width: Math.max(1, this._container.clientWidth || this._container.getBoundingClientRect().width || 800),
        height: Math.max(1, this._container.clientHeight || this._container.getBoundingClientRect().height || 600)
      };
    }

    _scheduleRender() {
      if (this._renderFrame) return;
      this._renderFrame = global.requestAnimationFrame(() => {
        this._renderFrame = 0;
        this._renderAll();
      });
    }

    _renderAll() {
      this._renderTiles();
      const size = this._getSize();
      this._overlayPane.setAttribute("width", String(size.width));
      this._overlayPane.setAttribute("height", String(size.height));
      this._overlayPane.setAttribute("viewBox", `0 0 ${size.width} ${size.height}`);
      this._renderables.forEach((layer) => layer._render?.());
      this._positionPopup();
    }

    _renderTiles() {
      if (!this._baseLayer) return;
      const size = this._getSize();
      const z = clampValue(Math.round(this._zoom), MIN_ZOOM, Number(this._baseLayer.options.maxZoom) || 19);
      if (z !== this._zoom) this._zoom = z;
      const centerWorld = project(this._center, z);
      const topLeft = { x: centerWorld.x - size.width / 2, y: centerWorld.y - size.height / 2 };
      const minX = Math.floor(topLeft.x / TILE_SIZE) - 1;
      const maxX = Math.floor((topLeft.x + size.width) / TILE_SIZE) + 1;
      const minY = Math.floor(topLeft.y / TILE_SIZE) - 1;
      const maxY = Math.floor((topLeft.y + size.height) / TILE_SIZE) + 1;
      const tileCount = Math.pow(2, z);
      const needed = new Set();
      for (let ty = minY; ty <= maxY; ty += 1) {
        if (ty < 0 || ty >= tileCount) continue;
        for (let tx = minX; tx <= maxX; tx += 1) {
          const wrappedX = ((tx % tileCount) + tileCount) % tileCount;
          const key = `${this._baseLayer._id}:${z}:${tx}:${ty}`;
          needed.add(key);
          let image = this._tiles.get(key);
          if (!image) {
            const activeLayer = this._baseLayer;
            image = document.createElement("img");
            image.className = "leaflet-tile leaflet-tile-loading";
            image.alt = "";
            image.width = TILE_SIZE;
            image.height = TILE_SIZE;
            image.draggable = false;
            if (activeLayer.options?.referrerPolicy) image.referrerPolicy = activeLayer.options.referrerPolicy;
            if (activeLayer.options?.crossOrigin) {
              image.crossOrigin = typeof activeLayer.options.crossOrigin === "string"
                ? activeLayer.options.crossOrigin
                : "anonymous";
            }
            if (activeLayer.options?.providerKey) image.dataset.tileProvider = activeLayer.options.providerKey;
            const url = activeLayer._tileUrl(z, wrappedX, ty);
            image.addEventListener("load", () => {
              image.classList.remove("leaflet-tile-loading");
              image.classList.add("leaflet-tile-loaded");
              activeLayer._emit("tileload", { tile: image, url });
            }, { once: true });
            image.addEventListener("error", () => {
              image.classList.remove("leaflet-tile-loading");
              activeLayer._emit("tileerror", { tile: image, url });
            }, { once: true });
            image.src = url;
            this._tilePane.appendChild(image);
            this._tiles.set(key, image);
          }
          positionElement(image, tx * TILE_SIZE - topLeft.x, ty * TILE_SIZE - topLeft.y);
        }
      }
      Array.from(this._tiles.entries()).forEach(([key, image]) => {
        if (!needed.has(key)) {
          image.remove();
          this._tiles.delete(key);
        }
      });
    }

    _openPopup(marker, html) {
      this._closePopup();
      const popup = document.createElement("div");
      popup.className = "leaflet-popup leaflet-zoom-animated";
      const wrapper = document.createElement("div");
      wrapper.className = "leaflet-popup-content-wrapper";
      const content = document.createElement("div");
      content.className = "leaflet-popup-content";
      content.innerHTML = html;
      const close = document.createElement("button");
      close.type = "button";
      close.className = "leaflet-popup-close-button";
      close.setAttribute("aria-label", "Close popup");
      close.textContent = "×";
      close.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); this._closePopup(); });
      const tipContainer = document.createElement("div");
      tipContainer.className = "leaflet-popup-tip-container";
      const tip = document.createElement("div");
      tip.className = "leaflet-popup-tip";
      tipContainer.appendChild(tip);
      wrapper.append(content, close);
      popup.append(wrapper, tipContainer);
      popup.addEventListener("pointerdown", (event) => event.stopPropagation());
      popup.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });
      this._popupPane.appendChild(popup);
      this._popup = popup;
      this._popupMarker = marker;
      this._positionPopup();
      global.setTimeout(() => close.focus({ preventScroll: true }), 0);
    }

    _positionPopup() {
      if (!this._popup || !this._popupMarker) return;
      const point = this._latLngToPoint(this._popupMarker.latLng);
      this._popup.style.left = `${Math.round(point.x)}px`;
      this._popup.style.top = `${Math.round(point.y)}px`;
    }

    _closePopup() {
      this._popup?.remove();
      this._popup = null;
      this._popupMarker = null;
    }

    setView(latLng, zoom) {
      this._center = toLatLng(latLng);
      const maxZoom = Number(this._baseLayer?.options?.maxZoom) || 19;
      this._zoom = clampValue(Math.round(Number(zoom) || this._zoom || 6), MIN_ZOOM, maxZoom);
      this._scheduleRender();
      return this;
    }

    getZoom() { return this._zoom; }
    getContainer() { return this._container; }

    fitBounds(boundsInput, options) {
      const bounds = boundsInput instanceof Bounds ? boundsInput : new Bounds(boundsInput);
      if (!bounds.isValid()) return this;
      const size = this._getSize();
      const padding = Array.isArray(options?.padding) ? options.padding : [0, 0];
      const availableWidth = Math.max(64, size.width - padding[0] * 2);
      const availableHeight = Math.max(64, size.height - padding[1] * 2);
      const maximum = Math.min(Number(options?.maxZoom) || 19, Number(this._baseLayer?.options?.maxZoom) || 19);
      let selectedZoom = MIN_ZOOM;
      for (let z = MIN_ZOOM; z <= maximum; z += 1) {
        const nw = project({ lat: bounds.maxLat, lng: bounds.minLng }, z);
        const se = project({ lat: bounds.minLat, lng: bounds.maxLng }, z);
        if (Math.abs(se.x - nw.x) <= availableWidth && Math.abs(se.y - nw.y) <= availableHeight) selectedZoom = z;
        else break;
      }
      return this.setView(bounds.getCenter(), selectedZoom);
    }

    invalidateSize() {
      this._scheduleRender();
      return this;
    }
  }

  function divIcon(options) { return { options: options || {} }; }
  function createElement(tagName, className) {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    return element;
  }
  function stopEvents(element, types) {
    types.forEach((type) => element.addEventListener(type, (event) => event.stopPropagation(), { passive: type === "touchstart" }));
    return element;
  }

  const L = {
    version: "1.9.4-embedded-mobile-fallback",
    __embeddedFallback: true,
    map: (container, options) => new MiniMap(container, options),
    tileLayer: (url, options) => new TileLayer(url, options),
    layerGroup: () => new LayerGroup(),
    marker: (latLng, options) => new Marker(latLng, options),
    polyline: (latLngs, options) => new Polyline(latLngs, options),
    divIcon,
    latLngBounds: (points) => new Bounds(points),
    control: (options) => new Control(options),
    DomUtil: { create: createElement },
    DomEvent: {
      disableClickPropagation: (element) => stopEvents(element, ["click", "dblclick", "pointerdown", "touchstart"]),
      disableScrollPropagation: (element) => stopEvents(element, ["wheel", "touchmove"])
    }
  };
  L.control.layers = (baseLayers, overlays, options) => new LayersControl(baseLayers, overlays, options);
  global.L = L;
})(window);

