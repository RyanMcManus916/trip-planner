"use strict";

/* ---------------------------------------------------------------------
       Route-aware questions and OpenStreetMap POI search
       --------------------------------------------------------------------- */
    const ROUTE_SEARCH_LABELS = {
      fuel: "Fuel",
      food: "Food & coffee",
      interesting: "Interesting stop",
      restroom: "Restroom",
      grocery: "Groceries",
      ev: "EV charging",
      lodging: "Lodging"
    };

    const ROUTE_SEARCH_SYMBOLS = {
      fuel: "⛽",
      food: "F",
      interesting: "★",
      restroom: "WC",
      grocery: "G",
      ev: "⚡",
      lodging: "☾"
    };

    function detectRouteSearchCategories(question) {
      const text = normalizePlaceText(question);
      const categories = [];
      const add = (key) => { if (!categories.includes(key)) categories.push(key); };
      if (/\b(fuel|gas|gasoline|petrol|diesel|service station|truck stop)\b/.test(text)) add("fuel");
      if (/\b(ev|electric vehicle|charger|charging)\b/.test(text)) add("ev");
      if (/\b(food|eat|restaurant|lunch|dinner|breakfast|cafe|coffee|fast food)\b/.test(text)) add("food");
      if (/\b(restroom|bathroom|toilet|wc)\b/.test(text)) add("restroom");
      if (/\b(grocery|groceries|supermarket|market|supplies|convenience store)\b/.test(text)) add("grocery");
      if (/\b(hotel|motel|lodging|accommodation|place to stay|overnight)\b/.test(text)) add("lodging");
      if (/\b(interesting|attraction|things to do|activity|activities|museum|historic|history|viewpoint|scenic|park|detour|alternative stop|something to do|stop along)\b/.test(text)) add("interesting");
      if (!categories.length) add("interesting");
      return categories.slice(0, 4);
    }

    function routeLegSignature(leg) {
      return `${leg?.from?.id || leg?.from?.name || ""}|${leg?.to?.id || leg?.to?.name || ""}`;
    }

    function inferRouteLegIndex(question, summary) {
      const words = new Set(normalizePlaceText(question).split(" ").filter((word) => word.length >= 4));
      if (!words.size) return -1;
      let bestIndex = -1;
      let bestScore = 0;
      summary.legs.forEach((leg, index) => {
        const endpointWords = normalizePlaceText(`${leg.from.name} ${leg.to.name}`).split(" ").filter((word) => word.length >= 4);
        const score = endpointWords.reduce((sum, word) => sum + (words.has(word) ? 1 : 0), 0);
        if (score > bestScore) {
          bestScore = score;
          bestIndex = index;
        }
      });
      return bestScore >= 1 ? bestIndex : -1;
    }

    function populateRouteQuestionLegs() {
      const select = $("routeQuestionLeg");
      if (!select) return;
      if (!state.routeCreated) {
        select.innerHTML = '<option value="">Create a route first</option>';
        select.disabled = true;
        return;
      }
      const summary = calculateRouteSummary();
      const previousSignature = select.selectedOptions[0]?.dataset.signature || state.routeSearchLegSignature;
      select.innerHTML = summary.legs.map((leg, index) => {
        const signature = routeLegSignature(leg);
        const dayText = leg.requiredDays > 1 ? ` · ${leg.requiredDays} drive days` : "";
        return `<option data-signature="${escapeHtml(signature)}" value="${index}">${index + 1}. ${escapeHtml(leg.from.name)} → ${escapeHtml(leg.to.name)} · ${round(leg.miles)} mi${dayText}</option>`;
      }).join("");
      select.disabled = !summary.legs.length;
      const matching = [...select.options].find((option) => option.dataset.signature === previousSignature);
      if (matching) select.value = matching.value;
      state.routeSearchLegSignature = select.selectedOptions[0]?.dataset.signature || "";
    }

    function sampleRoutePath(path, maximumPoints = 12) {
      if (!Array.isArray(path) || path.length <= maximumPoints) return path || [];
      const sampled = [];
      for (let i = 0; i < maximumPoints; i += 1) {
        const index = Math.round((i / (maximumPoints - 1)) * (path.length - 1));
        const point = path[index];
        const previous = sampled.at(-1);
        if (!previous || previous[0] !== point[0] || previous[1] !== point[1]) sampled.push(point);
      }
      return sampled;
    }

    function routePathMeasurements(path) {
      const cumulative = [0];
      for (let index = 1; index < path.length; index += 1) {
        cumulative.push(cumulative.at(-1) + haversineMiles(
          { lat: path[index - 1][0], lng: path[index - 1][1] },
          { lat: path[index][0], lng: path[index][1] }
        ));
      }
      return cumulative;
    }

    // Public Overpass servers handle small point-radius requests much more
    // reliably than one large buffered polyline. Create evenly spaced points
    // along the actual road geometry, while limiting total public requests.
    function buildRouteSearchAnchors(path, legMiles, radiusMiles, maximumAnchors = 14) {
      if (!Array.isArray(path) || path.length < 2) return [];
      const cumulative = routePathMeasurements(path);
      const measuredMiles = cumulative.at(-1) || Number(legMiles) || 1;
      const roadMiles = Number(legMiles) > 0 ? Number(legMiles) : measuredMiles;
      const spacing = clamp(Math.max(radiusMiles * 1.65, 18), 18, 48);
      const count = clamp(Math.ceil(roadMiles / spacing) + 1, 3, Math.min(maximumAnchors, path.length));
      const anchors = [];
      for (let anchorIndex = 0; anchorIndex < count; anchorIndex += 1) {
        const targetMeasured = (anchorIndex / (count - 1)) * measuredMiles;
        let pathIndex = 0;
        while (pathIndex < cumulative.length - 1 && cumulative[pathIndex] < targetMeasured) pathIndex += 1;
        const point = path[pathIndex];
        if (!point) continue;
        const previous = anchors.at(-1);
        if (!previous || previous[0] !== point[0] || previous[1] !== point[1]) anchors.push(point);
      }
      return anchors;
    }

    function chunkItems(items, size) {
      const chunks = [];
      for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
      return chunks;
    }

    function buildRoutePoiOverpassQuery(categories, anchors, radiusMeters) {
      const clauses = [];
      const radius = Math.round(radiusMeters);
      anchors.forEach(([lat, lng]) => {
        const around = `around:${radius},${Number(lat).toFixed(5)},${Number(lng).toFixed(5)}`;
        if (categories.includes("fuel")) clauses.push(`nwr(${around})["amenity"="fuel"];`);
        if (categories.includes("ev")) clauses.push(`nwr(${around})["amenity"="charging_station"];`);
        if (categories.includes("food")) clauses.push(`nwr(${around})["amenity"~"^(restaurant|cafe|fast_food|food_court)$"]["name"];`);
        if (categories.includes("restroom")) clauses.push(`nwr(${around})["amenity"="toilets"];`);
        if (categories.includes("grocery")) clauses.push(`nwr(${around})["shop"~"^(supermarket|convenience|grocery)$"]["name"];`);
        if (categories.includes("lodging")) clauses.push(`nwr(${around})["tourism"~"^(hotel|motel|hostel|guest_house)$"]["name"];`);
        if (categories.includes("interesting")) {
          clauses.push(`nwr(${around})["tourism"~"^(attraction|museum|viewpoint|gallery|zoo|theme_park)$"]["name"];`);
          clauses.push(`nwr(${around})["historic"]["name"];`);
          clauses.push(`nwr(${around})["leisure"~"^(park|nature_reserve)$"]["name"];`);
          clauses.push(`nwr(${around})["natural"~"^(waterfall|hot_spring|cave_entrance|beach|peak)$"]["name"];`);
        }
      });
      return `[out:json][timeout:14];(${clauses.join("\n")});out center tags qt 250;`;
    }

    function classifyRoutePoi(tags) {
      if (tags.amenity === "fuel") return "fuel";
      if (tags.amenity === "charging_station") return "ev";
      if (["restaurant", "cafe", "fast_food", "food_court"].includes(tags.amenity)) return "food";
      if (tags.amenity === "toilets") return "restroom";
      if (["supermarket", "convenience", "grocery"].includes(tags.shop)) return "grocery";
      if (["hotel", "motel", "hostel", "guest_house"].includes(tags.tourism)) return "lodging";
      return "interesting";
    }

    function routePoiName(tags, category) {
      return tags.name || tags.brand || tags.operator || {
        fuel: "Fuel station",
        ev: "EV charging station",
        restroom: "Public restroom",
        food: "Food stop",
        grocery: "Grocery stop",
        lodging: "Lodging",
        interesting: "Interesting stop"
      }[category];
    }

    function routePoiDetails(tags, category) {
      const parts = [];
      if (tags.brand && tags.brand !== tags.name) parts.push(tags.brand);
      if (tags.cuisine) parts.push(`Cuisine: ${tags.cuisine.replaceAll(";", ", ")}`);
      if (tags.opening_hours) parts.push(`Hours: ${tags.opening_hours}`);
      if (tags.historic && category === "interesting") parts.push(`Historic: ${tags.historic.replaceAll("_", " ")}`);
      if (tags.tourism && category === "interesting") parts.push(tags.tourism.replaceAll("_", " "));
      if (tags.natural && category === "interesting") parts.push(tags.natural.replaceAll("_", " "));
      if (tags["addr:city"]) parts.push(tags["addr:city"]);
      return parts.join(" · ");
    }

    function normalizeRoutePoiElements(elements, leg, categories) {
      const path = Array.isArray(leg.path) && leg.path.length > 1 ? leg.path : [[leg.from.lat, leg.from.lng], [leg.to.lat, leg.to.lng]];
      const unique = new Map();
      for (const element of elements || []) {
        const lat = Number(element.lat ?? element.center?.lat);
        const lng = Number(element.lon ?? element.center?.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        const tags = element.tags || {};
        const category = classifyRoutePoi(tags);
        if (!categories.includes(category) && !(categories.includes("interesting") && category === "interesting")) continue;
        const projection = projectPlaceOntoPath(path, { lat, lng }, leg.miles);
        if (!projection) continue;
        const name = routePoiName(tags, category);
        const dedupeKey = `${normalizePlaceText(name)}|${lat.toFixed(3)}|${lng.toFixed(3)}`;
        const result = {
          key: `${element.type}-${element.id}`,
          osmType: element.type,
          osmId: element.id,
          name,
          lat,
          lng,
          category,
          categoryLabel: ROUTE_SEARCH_LABELS[category],
          symbol: ROUTE_SEARCH_SYMBOLS[category],
          details: routePoiDetails(tags, category),
          alongMiles: projection.alongMiles,
          lateralMiles: projection.lateralMiles,
          routeLat: projection.routeLat,
          routeLng: projection.routeLng,
          fromName: leg.from.name,
          toName: leg.to.name,
          provider: "OpenStreetMap Overpass",
          tags
        };
        const existing = unique.get(dedupeKey);
        if (!existing || result.lateralMiles < existing.lateralMiles) unique.set(dedupeKey, result);
      }
      return [...unique.values()].sort((a, b) => a.alongMiles - b.alongMiles || a.lateralMiles - b.lateralMiles || a.name.localeCompare(b.name));
    }

    function routeSearchCacheKey(leg, categories, radiusMiles) {
      const path = leg.path || [];
      const pathKey = path.length ? `${path[0]?.join(",")}|${path.at(-1)?.join(",")}|${path.length}` : routeLegSignature(leg);
      return `${pathKey}|${categories.slice().sort().join(",")}|${radiusMiles}|point-v2`;
    }

    const OVERPASS_ENDPOINTS = [
      "https://overpass.private.coffee/api/interpreter",
      "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
      "https://overpass-api.de/api/interpreter"
    ];

    async function fetchOverpassEndpoint(endpoint, query, parentSignal) {
      if (parentSignal?.aborted) throw new DOMException("Search cancelled", "AbortError");
      const controller = new AbortController();
      const relayAbort = () => controller.abort();
      parentSignal?.addEventListener("abort", relayAbort, { once: true });
      const timeout = window.setTimeout(() => controller.abort(), 14500);
      try {
        const getUrl = `${endpoint}?data=${encodeURIComponent(query)}`;
        let response;
        if (getUrl.length < 7600) {
          response = await fetch(getUrl, {
            method: "GET",
            headers: { "Accept": "application/json" },
            signal: controller.signal
          });
        } else {
          response = await fetch(endpoint, {
            method: "POST",
            headers: {
              "Accept": "application/json",
              "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"
            },
            body: new URLSearchParams({ data: query }).toString(),
            signal: controller.signal
          });
        }
        if (!response.ok) throw new Error(`Search service returned ${response.status}.`);
        return await response.json();
      } finally {
        window.clearTimeout(timeout);
        parentSignal?.removeEventListener("abort", relayAbort);
      }
    }

    async function fetchRoutePoiData(query, parentSignal, endpointOffset = 0) {
      let lastError = null;
      for (let attempt = 0; attempt < OVERPASS_ENDPOINTS.length; attempt += 1) {
        const endpoint = OVERPASS_ENDPOINTS[(endpointOffset + attempt) % OVERPASS_ENDPOINTS.length];
        try {
          return await fetchOverpassEndpoint(endpoint, query, parentSignal);
        } catch (error) {
          if (parentSignal?.aborted) throw new DOMException("Search cancelled", "AbortError");
          lastError = error;
        }
      }
      if (lastError?.name === "AbortError") throw new Error("A route-search batch timed out.");
      throw lastError || new Error("The route search service is unavailable.");
    }

    async function fetchRoutePoiDataInSegments(categories, leg, radiusMiles, parentSignal, onProgress) {
      const anchors = buildRouteSearchAnchors(leg.path, leg.miles, radiusMiles, 14);
      const batches = chunkItems(anchors, categories.includes("interesting") ? 2 : 4);
      const elements = [];
      let failedSections = 0;
      let lastError = null;
      for (let index = 0; index < batches.length; index += 1) {
        if (parentSignal?.aborted) throw new DOMException("Search cancelled", "AbortError");
        onProgress?.(index + 1, batches.length, "OpenStreetMap");
        const query = buildRoutePoiOverpassQuery(categories, batches[index], radiusMiles * 1609.344);
        try {
          const data = await fetchRoutePoiData(query, parentSignal, index);
          elements.push(...(data.elements || []));
        } catch (error) {
          if (parentSignal?.aborted || error?.name === "AbortError") throw error;
          failedSections += 1;
          lastError = error;
        }
        if (index < batches.length - 1) await new Promise((resolve) => window.setTimeout(resolve, 120));
      }
      return {
        elements,
        sectionCount: batches.length,
        failedSections,
        allSectionsFailed: Boolean(batches.length && failedSections === batches.length),
        lastError
      };
    }

    function photonCategorySpec(category) {
      return {
        fuel: { query: "fuel station", osmTag: "amenity:fuel" },
        ev: { query: "EV charging station", osmTag: "amenity:charging_station" },
        food: { query: "restaurant cafe food" },
        restroom: { query: "public toilets restroom", osmTag: "amenity:toilets" },
        grocery: { query: "grocery supermarket" },
        lodging: { query: "hotel motel lodging" },
        interesting: { query: "museum attraction viewpoint historic scenic park" }
      }[category];
    }

    function boundingBoxAround(lat, lng, radiusMiles) {
      const latDelta = radiusMiles / 69;
      const lonDelta = radiusMiles / Math.max(20, 69 * Math.cos(lat * Math.PI / 180));
      return [lng - lonDelta, lat - latDelta, lng + lonDelta, lat + latDelta].map((value) => value.toFixed(5)).join(",");
    }

    function photonFeatureToRouteResult(feature, leg, category) {
      const coordinates = feature?.geometry?.coordinates || [];
      const lng = Number(coordinates[0]);
      const lat = Number(coordinates[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      const props = feature.properties || {};
      const projection = projectPlaceOntoPath(leg.path, { lat, lng }, leg.miles);
      if (!projection) return null;
      const osmTypeRaw = String(props.osm_type || "").toLowerCase();
      const osmType = { n: "node", w: "way", r: "relation" }[osmTypeRaw] || osmTypeRaw;
      const osmId = props.osm_id || "";
      const name = props.name || props.street || ROUTE_SEARCH_LABELS[category];
      const placeParts = [props.city, props.state, props.country].filter(Boolean);
      const detailParts = [];
      if (props.street) detailParts.push([props.housenumber, props.street].filter(Boolean).join(" "));
      if (placeParts.length) detailParts.push(placeParts.join(", "));
      if (props.osm_value) detailParts.push(String(props.osm_value).replaceAll("_", " "));
      return {
        key: osmId ? `${osmType || "osm"}-${osmId}` : `photon-${normalizePlaceText(name)}-${lat.toFixed(4)}-${lng.toFixed(4)}`,
        osmType,
        osmId,
        name,
        lat,
        lng,
        category,
        categoryLabel: ROUTE_SEARCH_LABELS[category],
        symbol: ROUTE_SEARCH_SYMBOLS[category],
        details: detailParts.join(" · "),
        alongMiles: projection.alongMiles,
        lateralMiles: projection.lateralMiles,
        routeLat: projection.routeLat,
        routeLng: projection.routeLng,
        fromName: leg.from.name,
        toName: leg.to.name,
        provider: "Photon OSM search",
        tags: {
          "addr:city": props.city || "",
          "addr:state": props.state || "",
          tourism: props.osm_key === "tourism" ? props.osm_value : "",
          amenity: props.osm_key === "amenity" ? props.osm_value : "",
          shop: props.osm_key === "shop" ? props.osm_value : ""
        }
      };
    }

    async function fetchPhotonRoutePoiData(categories, leg, radiusMiles, parentSignal, onProgress) {
      const allAnchors = buildRouteSearchAnchors(leg.path, leg.miles, radiusMiles, 5);
      const anchors = allAnchors.length > 3 ? [allAnchors[1], allAnchors[Math.floor(allAnchors.length / 2)], allAnchors.at(-2)] : allAnchors;
      const results = [];
      let requestCount = 0;
      let failedRequests = 0;
      for (let anchorIndex = 0; anchorIndex < anchors.length; anchorIndex += 1) {
        if (parentSignal?.aborted) throw new DOMException("Search cancelled", "AbortError");
        const [lat, lng] = anchors[anchorIndex];
        onProgress?.(anchorIndex + 1, anchors.length, "backup search");
        const settled = await Promise.allSettled(categories.map(async (category) => {
          const spec = photonCategorySpec(category);
          const params = new URLSearchParams({
            q: spec.query,
            lat: String(lat),
            lon: String(lng),
            bbox: boundingBoxAround(lat, lng, radiusMiles * 1.25),
            limit: "12",
            lang: "en",
            zoom: "10",
            location_bias_scale: "0.15"
          });
          if (spec.osmTag) params.set("osm_tag", spec.osmTag);
          const controller = new AbortController();
          const relayAbort = () => controller.abort();
          parentSignal?.addEventListener("abort", relayAbort, { once: true });
          const timeout = window.setTimeout(() => controller.abort(), 10500);
          requestCount += 1;
          try {
            const response = await fetch(`https://photon.komoot.io/api/?${params.toString()}`, {
              headers: { "Accept": "application/geo+json, application/json" },
              signal: controller.signal
            });
            if (!response.ok) throw new Error(`Backup search returned ${response.status}.`);
            const data = await response.json();
            return (data.features || []).map((feature) => photonFeatureToRouteResult(feature, leg, category)).filter(Boolean);
          } finally {
            window.clearTimeout(timeout);
            parentSignal?.removeEventListener("abort", relayAbort);
          }
        }));
        settled.forEach((item) => {
          if (item.status === "fulfilled") results.push(...item.value);
          else failedRequests += 1;
        });
        if (anchorIndex < anchors.length - 1) await new Promise((resolve) => window.setTimeout(resolve, 180));
      }
      return { results, requestCount, failedRequests };
    }

    function findBuiltInRouteAlternatives(leg, categories, radiusMiles) {
      if (!categories.includes("interesting")) return [];
      const selectedIds = new Set(state.routeStops.map((stop) => stop.id));
      const maximumDistance = Math.max(radiusMiles * 1.5, 24);
      return CANDIDATES
        .filter((stop) => !selectedIds.has(stop.id))
        .map((stop) => ({ stop, projection: projectPlaceOntoPath(leg.path, stop, leg.miles) }))
        .filter(({ projection }) => projection && projection.lateralMiles <= maximumDistance)
        .sort((a, b) => a.projection.alongMiles - b.projection.alongMiles || a.projection.lateralMiles - b.projection.lateralMiles)
        .slice(0, 16)
        .map(({ stop, projection }) => ({
          key: `candidate-${stop.id}`,
          osmType: "",
          osmId: "",
          name: stop.name,
          lat: stop.lat,
          lng: stop.lng,
          category: "interesting",
          categoryLabel: "Interesting stop",
          symbol: ROUTE_SEARCH_SYMBOLS.interesting,
          details: `${stop.category} · ${stop.description}`,
          alongMiles: projection.alongMiles,
          lateralMiles: projection.lateralMiles,
          routeLat: projection.routeLat,
          routeLng: projection.routeLng,
          fromName: leg.from.name,
          toName: leg.to.name,
          provider: "Built-in trip destinations",
          candidateId: stop.id,
          tags: { "addr:state": stop.region || "" }
        }));
    }

    function dedupeRouteSearchResults(results, radiusMiles) {
      const unique = new Map();
      for (const result of results) {
        if (!result || result.lateralMiles > Math.max(radiusMiles * 1.6, radiusMiles + 3)) continue;
        const key = result.osmId
          ? `${result.osmType}-${result.osmId}`
          : `${normalizePlaceText(result.name)}|${result.lat.toFixed(3)}|${result.lng.toFixed(3)}`;
        const existing = unique.get(key);
        if (!existing || result.lateralMiles < existing.lateralMiles) unique.set(key, result);
      }
      return [...unique.values()].sort((a, b) => a.alongMiles - b.alongMiles || a.lateralMiles - b.lateralMiles || a.name.localeCompare(b.name));
    }

    function clearRouteSearchFallbackLinks() {
      const container = $("routeQuestionFallback");
      if (!container) return;
      container.className = "route-search-fallback";
      container.innerHTML = "";
    }

    function renderRouteSearchFallbackLinks(leg, categories, question, message = "") {
      const container = $("routeQuestionFallback");
      if (!container || !leg) return;
      const categoryLinks = categories.map((category) => {
        const label = ROUTE_SEARCH_LABELS[category] || category;
        const query = `${label} between ${leg.from.name} and ${leg.to.name}`;
        const href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
        return `<a class="btn-light btn-small" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">Search ${escapeHtml(label)} in Google Maps</a>`;
      }).join("");
      const directionsUrl = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(`${leg.from.lat},${leg.from.lng}`)}&destination=${encodeURIComponent(`${leg.to.lat},${leg.to.lng}`)}&travelmode=driving`;
      const osmDirectionsUrl = `https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=${encodeURIComponent(`${leg.from.lat},${leg.from.lng};${leg.to.lat},${leg.to.lng}`)}`;
      container.className = "route-search-fallback show";
      container.innerHTML = `<p><strong>Use an external map search:</strong> ${escapeHtml(message || "Shared in-app search services did not return dependable results for this drive.")}</p>
        <div class="route-search-fallback-links">
          ${categoryLinks}
          <a class="btn-light btn-small" href="${escapeHtml(directionsUrl)}" target="_blank" rel="noopener noreferrer">Open drive in Google Maps</a>
          <a class="btn-light btn-small" href="${escapeHtml(osmDirectionsUrl)}" target="_blank" rel="noopener noreferrer">Open drive in OpenStreetMap</a>
        </div>`;
    }

    function setRouteSearchBusy(busy) {
      const button = $("askRouteBtn");
      if (button) {
        button.disabled = busy;
        button.textContent = busy ? "Searching route…" : "Search this drive";
      }
    }

    function markRouteSearchStaleIfNeeded() {
      if (!state.routeSearchResults.length || !state.routeSearchRouteKey || !state.routeCreated) return;
      const current = buildRouteKey(getRoutePoints());
      if (current !== state.routeSearchRouteKey) {
        state.routeSearchStale = true;
        renderRouteSearchResults();
      }
    }

    function clearRouteSearchResults({ silent = false } = {}) {
      if (state.routeSearchController) state.routeSearchController.abort();
      state.routeSearchResults = [];
      state.routeSearchRouteKey = "";
      state.routeSearchStale = false;
      state.routeSearchLegSignature = "";
      state.routeSearchMarkerIndex.clear();
      if (state.routeSearchLayer) state.routeSearchLayer.clearLayers();
      if ($("routeQuestionResults")) $("routeQuestionResults").innerHTML = "";
      if ($("routeQuestionSummary")) {
        $("routeQuestionSummary").className = "route-search-summary";
        $("routeQuestionSummary").textContent = "";
      }
      clearRouteSearchFallbackLinks();
      if (!silent) clearStatus("routeQuestionStatus");
    }

    function renderRouteSearchMarkers() {
      if (!state.map || !state.routeSearchLayer) return;
      state.routeSearchLayer.clearLayers();
      state.routeSearchMarkerIndex.clear();
      state.routeSearchResults.forEach((result, index) => {
        const alreadyPlanned = state.plannedDriveStops.some((stop) => stop.sourceKey === result.key);
        const popupAction = alreadyPlanned
          ? `<button class="btn-danger" type="button" data-map-action="remove-route-search-plan" data-route-result-index="${index}">Remove from drive day</button>`
          : `<button class="btn-primary" type="button" data-map-action="add-route-search-plan" data-route-result-index="${index}">+ Add to drive day</button>`;
        const marker = L.marker([result.lat, result.lng], {
          icon: createPinIcon("route-search", result.symbol || "?"),
          zIndexOffset: 900
        }).bindPopup(`
          <div class="popup-title">${escapeHtml(result.name)}</div>
          <div class="popup-meta">${escapeHtml(result.categoryLabel)} · about ${round(result.alongMiles)} mi from ${escapeHtml(result.fromName)}</div>
          <div>${escapeHtml(result.details || `Approximately ${round(result.lateralMiles, 1)} miles from the mapped route.`)}</div>
          <div class="popup-meta">${escapeHtml(result.provider || "OpenStreetMap data")} · verify hours, access, and availability.</div>
          <div class="popup-actions">${popupAction}</div>
          <div class="popup-meta">${alreadyPlanned ? "Already listed on this travel day." : "Adds this as a quick travel-day stop without reserving a full destination day."}</div>`)
          .addTo(state.routeSearchLayer);
        state.routeSearchMarkerIndex.set(String(index), marker);
      });
    }

    function renderRouteSearchResults() {
      const container = $("routeQuestionResults");
      const summaryEl = $("routeQuestionSummary");
      if (!container || !summaryEl) return;
      if (!state.routeSearchResults.length) {
        container.innerHTML = "";
        summaryEl.className = "route-search-summary";
        summaryEl.textContent = "";
        renderRouteSearchMarkers();
        return;
      }
      const limit = clamp(Number.parseInt($("routeSearchLimit").value, 10) || 20, 5, 50);
      const visible = state.routeSearchResults.slice(0, limit);
      const categoryCounts = {};
      state.routeSearchResults.forEach((result) => { categoryCounts[result.categoryLabel] = (categoryCounts[result.categoryLabel] || 0) + 1; });
      const countText = Object.entries(categoryCounts).map(([label, count]) => `${count} ${label.toLowerCase()}`).join(" · ");
      summaryEl.className = `route-search-summary show${state.routeSearchStale ? " stale" : ""}`;
      summaryEl.textContent = state.routeSearchStale
        ? `The route changed after this search. These ${state.routeSearchResults.length} results remain visible for reference; search again to refresh their route distances.`
        : `Found ${state.routeSearchResults.length} places along this drive: ${countText}. Results are ordered from the start of the selected leg.`;
      container.innerHTML = visible.map((result, index) => {
        const canBecomeDestination = ["interesting", "lodging"].includes(result.category);
        const alreadyDestination = state.customStops.some((stop) => stop.osmRef === result.key);
        const alreadyPlanned = state.plannedDriveStops.some((stop) => stop.sourceKey === result.key);
        const remaining = Math.max(0, result.tags?.__legMiles - result.alongMiles);
        return `<article class="route-search-result" data-route-result-index="${index}">
          <div class="route-result-heading">
            <div class="route-result-name">${escapeHtml(result.name)}</div>
            <span class="route-result-badge">${escapeHtml(result.symbol)} ${escapeHtml(result.categoryLabel)}</span>
          </div>
          <div class="route-result-location">About ${round(result.alongMiles)} mi from ${escapeHtml(result.fromName)} · ${round(result.lateralMiles, 1)} mi from route${Number.isFinite(remaining) ? ` · ${round(remaining)} mi before ${escapeHtml(result.toName)}` : ""}</div>
          ${result.details ? `<div class="route-result-detail">${escapeHtml(result.details)}</div>` : ""}
          <div class="route-result-actions">
            <button class="btn-light btn-small" data-route-result-action="show" type="button">Show on map</button>
            <button class="btn-light btn-small" data-route-result-action="open" type="button">Open map</button>
            <button class="${alreadyPlanned ? "btn-danger" : "btn-primary"} btn-small" data-route-result-action="${alreadyPlanned ? "remove-plan" : "plan"}" type="button">${alreadyPlanned ? "Remove from drive day" : "+ Add to drive day"}</button>
          </div>
          ${canBecomeDestination ? `<div class="route-result-add-options">
            <label class="route-result-days-control">Full destination days
              <select data-route-result-days>
                <option value="1" selected>1 day</option>
                <option value="2">2 days</option>
                <option value="3">3 days</option>
              </select>
            </label>
            <button class="btn-gold btn-small" data-route-result-action="destination" type="button" ${alreadyDestination ? "disabled" : ""}>${alreadyDestination ? "Already a destination" : "Add as full destination"}</button>
          </div>` : ""}
          <div class="route-result-detail">${alreadyPlanned ? "This stop is listed on the selected travel day without using a full destination day." : "Add to drive day for a quick planned stop without changing the route or consuming a full destination day."}${canBecomeDestination ? " Use the destination option when you want the route to pass through it and reserve activity days." : ""}</div>
        </article>`;
      }).join("");
      renderRouteSearchMarkers();
    }

    async function searchAlongRoute(quickCategory = "") {
      if (!state.routeCreated) {
        setStatus("routeQuestionStatus", "Create a route before searching along a drive.", "warning");
        return;
      }
      const summary = calculateRouteSummary();
      const roadRoute = getCachedRoadRoute(getRoutePoints());
      if (!roadRoute) {
        setStatus("routeQuestionStatus", "Wait for the solid road-following route to finish loading, then search again.", "warning");
        return;
      }
      let question = $("routeQuestion").value.trim();
      if (quickCategory) {
        const prompts = {
          fuel: "Find fuel stations along this drive",
          food: "Find food and coffee along this drive",
          interesting: "Find interesting things to do and scenic stops along this drive",
          restroom: "Find public restrooms along this drive",
          grocery: "Find groceries and supplies along this drive",
          ev: "Find EV charging stations along this drive",
          lodging: "Find hotels and motels along this drive"
        };
        question = prompts[quickCategory];
        $("routeQuestion").value = question;
      }
      if (!question) question = "Find interesting stops along this drive";
      const inferredIndex = inferRouteLegIndex(question, summary);
      if (inferredIndex >= 0) $("routeQuestionLeg").value = String(inferredIndex);
      const legIndex = clamp(Number.parseInt($("routeQuestionLeg").value, 10) || 0, 0, summary.legs.length - 1);
      const leg = summary.legs[legIndex];
      if (!leg?.path?.length) {
        setStatus("routeQuestionStatus", "Detailed road geometry is not available for this leg yet. Try again after the route finishes loading.", "warning");
        return;
      }
      const categories = quickCategory ? [quickCategory] : detectRouteSearchCategories(question);
      const radiusMiles = clamp(Number.parseFloat($("routeSearchRadius").value) || 8, 1, 20);
      const cacheKey = routeSearchCacheKey(leg, categories, radiusMiles);
      state.routeSearchLegSignature = routeLegSignature(leg);
      if (state.routeSearchController) state.routeSearchController.abort();
      const batchController = new AbortController();
      state.routeSearchController = batchController;
      setRouteSearchBusy(true);
      clearRouteSearchFallbackLinks();
      setStatus("routeQuestionStatus", `Searching lightweight route points within ${radiusMiles} miles of ${leg.from.name} → ${leg.to.name}…`, "info");
      try {
        let results = state.routeSearchCache.get(cacheKey);
        let searchMeta = { sectionCount: 0, failedSections: 0, cached: Boolean(results), provider: "saved search" };
        if (!results) {
          const overpassData = await fetchRoutePoiDataInSegments(
            categories,
            leg,
            radiusMiles,
            batchController.signal,
            (section, total, provider) => setStatus(
              "routeQuestionStatus",
              `${provider || "OpenStreetMap"}: searching batch ${section} of ${total} along ${leg.from.name} → ${leg.to.name}…`,
              "info"
            )
          );
          results = normalizeRoutePoiElements(overpassData.elements, leg, categories);
          searchMeta = {
            sectionCount: overpassData.sectionCount,
            failedSections: overpassData.failedSections,
            cached: false,
            provider: "OpenStreetMap Overpass"
          };

          if (!results.length) {
            setStatus("routeQuestionStatus", "The primary OpenStreetMap search did not return results. Trying a lighter OSM-based backup search…", "info");
            try {
              const photonData = await fetchPhotonRoutePoiData(
                categories,
                leg,
                radiusMiles,
                batchController.signal,
                (section, total, provider) => setStatus(
                  "routeQuestionStatus",
                  `${provider}: checking area ${section} of ${total} along ${leg.from.name} → ${leg.to.name}…`,
                  "info"
                )
              );
              results.push(...photonData.results);
              searchMeta.provider = "Photon OSM backup";
              searchMeta.backupFailedRequests = photonData.failedRequests;
              searchMeta.backupRequestCount = photonData.requestCount;
            } catch (backupError) {
              if (batchController.signal.aborted || backupError?.name === "AbortError") throw backupError;
              searchMeta.backupError = backupError;
            }
          }

          // The built-in nationwide destination library remains available even
          // when public POI APIs are busy, so interesting-stop searches can still
          // produce useful alternatives near the selected road leg.
          results.push(...findBuiltInRouteAlternatives(leg, categories, radiusMiles));
          results = dedupeRouteSearchResults(results, radiusMiles).map((result) => ({
            ...result,
            legIndex,
            legSignature: routeLegSignature(leg),
            tags: { ...result.tags, __legMiles: leg.miles }
          }));
          if (results.length) state.routeSearchCache.set(cacheKey, results);
        }
        state.routeSearchResults = results;
        state.routeSearchRouteKey = buildRouteKey(getRoutePoints());
        state.routeSearchStale = false;

        if (!results.length) {
          renderRouteSearchFallbackLinks(
            leg,
            categories,
            question,
            "Both in-app public search methods were unavailable or returned no matching places. These links search the same selected drive without relying on the embedded service."
          );
          setStatus("routeQuestionStatus", `No dependable in-app listings were returned within ${radiusMiles} miles of this leg. Use the external map-search buttons below, or try one quick category and a smaller radius.`, "warning");
        } else if (searchMeta.failedSections) {
          renderRouteSearchFallbackLinks(leg, categories, question, `${searchMeta.failedSections} of ${searchMeta.sectionCount} OpenStreetMap batches did not respond, so external searches are available as a cross-check.`);
          setStatus("routeQuestionStatus", `Found ${results.length} route-side option${results.length === 1 ? "" : "s"}. Some public search batches were unavailable, so the list may be incomplete.`, "warning");
        } else {
          clearRouteSearchFallbackLinks();
          setStatus("routeQuestionStatus", `Found ${results.length} route-side option${results.length === 1 ? "" : "s"}${searchMeta.cached ? " from the saved search" : ` using ${searchMeta.provider}`}. Select a result to inspect it on the map.`, "success");
        }
        renderRouteSearchResults();
      } catch (error) {
        if (error?.name !== "AbortError") {
          state.routeSearchResults = findBuiltInRouteAlternatives(leg, categories, radiusMiles).map((result) => ({
            ...result,
            legIndex,
            legSignature: routeLegSignature(leg),
            tags: { ...result.tags, __legMiles: leg.miles }
          }));
          renderRouteSearchFallbackLinks(leg, categories, question, "The shared public search services did not respond. External route searches remain available.");
          if (state.routeSearchResults.length) {
            setStatus("routeQuestionStatus", `Public POI services did not respond, but ${state.routeSearchResults.length} built-in destination${state.routeSearchResults.length === 1 ? " is" : "s are"} near this route. External search buttons are also available below.`, "warning");
            renderRouteSearchResults();
          } else {
            setStatus("routeQuestionStatus", "The embedded public search services did not respond. Use the external map-search buttons below; they do not depend on the embedded API.", "warning");
            renderRouteSearchResults();
          }
        }
      } finally {
        if (state.routeSearchController === batchController) {
          state.routeSearchController = null;
          setRouteSearchBusy(false);
        }
      }
    }

    function showRouteSearchResult(index) {
      const result = state.routeSearchResults[index];
      if (!result || !state.map) return;
      state.map.setView([result.lat, result.lng], Math.max(state.map.getZoom(), 12));
      state.routeSearchMarkerIndex.get(String(index))?.openPopup();
    }

    function routeResultCurrentLeg(result) {
      const summary = calculateRouteSummary();
      return summary.legs[result.legIndex]
        || summary.legs.find((item) => routeLegSignature(item) === result.legSignature)
        || null;
    }

    function addRouteSearchResultToDriveDay(index) {
      const result = state.routeSearchResults[index];
      if (!result) return;
      if (!isCoordinateInAmericas(result.lat, result.lng)) {
        setStatus("routeQuestionStatus", "This search result is outside North and South America and cannot be added to the itinerary.", "error");
        return;
      }
      if (state.plannedDriveStops.some((stop) => stop.sourceKey === result.key)) {
        setStatus("routeQuestionStatus", `${result.name} is already listed on a drive day.`, "info");
        return;
      }
      const leg = routeResultCurrentLeg(result);
      if (!leg) {
        setStatus("routeQuestionStatus", "The selected driving leg changed. Search this drive again, then add the stop.", "warning");
        return;
      }
      const planned = {
        id: `planned-drive-${result.osmType || "map"}-${result.osmId || normalizePlaceText(result.name).replaceAll(" ", "-")}-${Date.now()}`,
        sourceKey: result.key,
        name: result.name,
        lat: result.lat,
        lng: result.lng,
        category: result.category,
        categoryLabel: result.categoryLabel,
        details: result.details || `Found along the drive from ${leg.from.name} to ${leg.to.name}.`,
        provider: result.provider || "OpenStreetMap data",
        legFromId: leg.from.id,
        legToId: leg.to.id,
        legFromName: leg.from.name,
        legToName: leg.to.name,
        alongMiles: clamp(Number(result.alongMiles) || 0, 0, leg.miles || 0),
        lateralMiles: Math.max(0, Number(result.lateralMiles) || 0),
        addedAt: Date.now()
      };
      state.plannedDriveStops.push(planned);
      reconcilePlannedDriveStops(calculateRouteSummary());
      renderAll({ fitMap: false });
      renderRouteSearchResults();
      setSectionCollapsed("itinerary", false);
      window.setTimeout(() => {
        document.querySelector(`[data-planned-drive-stop-id="${CSS.escape(planned.id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 0);
      setStatus("routeQuestionStatus", `${planned.name} was added to the selected drive day without reserving a full destination day.`, "success");
    }

    function removePlannedDriveStopBySourceKey(sourceKey) {
      const stop = state.plannedDriveStops.find((item) => item.sourceKey === sourceKey);
      if (!stop) return;
      state.plannedDriveStops = state.plannedDriveStops.filter((item) => item.sourceKey !== sourceKey);
      renderAll({ fitMap: false });
      renderRouteSearchResults();
      setStatus("routeQuestionStatus", `${stop.name} was removed from the drive-day itinerary.`, "info");
    }

    function removePlannedDriveStop(stopId) {
      const stop = state.plannedDriveStops.find((item) => item.id === stopId);
      if (!stop) return;
      state.plannedDriveStops = state.plannedDriveStops.filter((item) => item.id !== stopId);
      renderAll({ fitMap: false });
      renderRouteSearchResults();
      setStatus("plannerStatus", `${stop.name} was removed from the drive-day itinerary.`, "info");
    }

    function showPlannedDriveStop(stopId) {
      const stop = state.plannedDriveStops.find((item) => item.id === stopId);
      if (!stop || !state.map) return;
      state.map.setView([stop.lat, stop.lng], Math.max(state.map.getZoom(), 13));
      state.plannedDriveStopMarkerIndex.get(stop.id)?.openPopup();
    }

    function reconcilePlannedDriveStops(summary = calculateRouteSummary()) {
      if (!state.plannedDriveStops.length || !summary.legs.length) return;
      state.plannedDriveStops.forEach((stop) => {
        const exact = summary.legs.find((leg) => leg.from.id === stop.legFromId && leg.to.id === stop.legToId);
        if (exact) {
          stop.legFromName = exact.from.name;
          stop.legToName = exact.to.name;
          stop.alongMiles = clamp(Number(stop.alongMiles) || 0, 0, exact.miles || 0);
          return;
        }
        let best = null;
        summary.legs.forEach((leg) => {
          const path = Array.isArray(leg.path) && leg.path.length > 1
            ? leg.path
            : [[leg.from.lat, leg.from.lng], [leg.to.lat, leg.to.lng]];
          const projection = projectPlaceOntoPath(path, stop, leg.miles);
          if (!projection) return;
          const score = projection.lateralMiles;
          if (!best || score < best.score) best = { leg, projection, score };
        });
        if (!best) return;
        stop.legFromId = best.leg.from.id;
        stop.legToId = best.leg.to.id;
        stop.legFromName = best.leg.from.name;
        stop.legToName = best.leg.to.name;
        stop.alongMiles = best.projection.alongMiles;
        stop.lateralMiles = best.projection.lateralMiles;
      });
    }

    function plannedStopsForLeg(leg) {
      return state.plannedDriveStops
        .filter((stop) => stop.legFromId === leg.from.id && stop.legToId === leg.to.id)
        .sort((a, b) => a.alongMiles - b.alongMiles);
    }

    function renderPlannedDriveStopMarkers() {
      if (!state.map || !state.plannedDriveStopLayer) return;
      state.plannedDriveStopLayer.clearLayers();
      state.plannedDriveStopMarkerIndex.clear();
      state.plannedDriveStops.forEach((stop) => {
        const marker = L.marker([stop.lat, stop.lng], {
          icon: createPinIcon("planned-drive", "✓"),
          zIndexOffset: 930
        }).bindPopup(`
          <div class="popup-title">${escapeHtml(stop.name)}</div>
          <div class="popup-meta">Planned drive-day stop · ${escapeHtml(stop.categoryLabel || stop.category || "Route stop")}</div>
          <div>${escapeHtml(stop.details || "Added from the route assistant.")}</div>
          <div class="popup-meta">Listed between ${escapeHtml(stop.legFromName)} and ${escapeHtml(stop.legToName)}. It does not reserve a full destination day or force a route detour.</div>`)
          .addTo(state.plannedDriveStopLayer);
        state.plannedDriveStopMarkerIndex.set(stop.id, marker);
      });
    }

    function addRouteSearchResultAsDestination(index, fullDays = 1) {
      const result = state.routeSearchResults[index];
      if (!result || !["interesting", "lodging"].includes(result.category)) return;
      if (!isCoordinateInAmericas(result.lat, result.lng)) {
        setStatus("routeQuestionStatus", "This search result is outside North and South America and cannot be added as a destination.", "error");
        return;
      }
      if (state.customStops.some((stop) => stop.osmRef === result.key)) {
        setStatus("routeQuestionStatus", `${result.name} is already in the route.`, "info");
        return;
      }
      const days = clamp(Number.parseInt(fullDays, 10) || 1, 1, 3);
      const stop = {
        id: `route-discovery-${result.osmType || "map"}-${result.osmId || normalizePlaceText(result.name).replaceAll(" ", "-")}-${Date.now()}`,
        osmRef: result.key,
        name: result.name,
        lat: result.lat,
        lng: result.lng,
        category: `Route discovery · ${result.categoryLabel}`,
        description: result.details || `Found along the drive from ${result.fromName} to ${result.toName}.`,
        duration: `${days} full day${days === 1 ? "" : "s"} initially`,
        overnight: days > 1 ? "Multi-day route discovery" : "Optional route discovery",
        baseDays: days,
        days,
        enabled: true,
        custom: true,
        source: "route search",
        priority: 16,
        tags: ["route discovery", result.category],
        region: result.tags?.["addr:state"] || result.tags?.["addr:city"] || "Along route"
      };
      state.customStops.push(stop);
      const summary = calculateRouteSummary();
      const leg = summary.legs[result.legIndex] || summary.legs.find((item) => routeLegSignature(item) === result.legSignature);
      let insertAt = state.routeStops.length;
      if (leg) {
        if (leg.from.id === state.start.id) {
          const firstEnabledIndex = state.routeStops.findIndex((item) => item.enabled !== false);
          insertAt = firstEnabledIndex >= 0 ? firstEnabledIndex : 0;
        } else {
          const fromIndex = state.routeStops.findIndex((item) => item.id === leg.from.id);
          if (fromIndex >= 0) insertAt = fromIndex + 1;
        }
      }
      state.routeStops.splice(insertAt, 0, stop);
      state.plannedDriveStops = state.plannedDriveStops.filter((item) => item.sourceKey !== result.key);
      state.routeCreated = true;
      state.routeSearchStale = true;
      renderAll({ fitMap: true });
      renderRouteSearchResults();
      setSectionCollapsed("itinerary", false);
      window.setTimeout(() => {
        document.querySelector(`[data-stop-id="${CSS.escape(stop.id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 0);
      setStatus("routeQuestionStatus", `${stop.name} was added as a ${days}-full-day destination on the selected driving leg.`, "success");
    }

    function handleRouteSearchResultClick(event) {
      const button = event.target.closest("button[data-route-result-action]");
      if (!button) return;
      const card = button.closest("[data-route-result-index]");
      if (!card) return;
      const index = Number.parseInt(card.dataset.routeResultIndex, 10);
      const result = state.routeSearchResults[index];
      if (!result) return;
      const action = button.dataset.routeResultAction;
      if (action === "show") showRouteSearchResult(index);
      if (action === "open") {
        const osmUrl = result.osmType && result.osmId
          ? `https://www.openstreetmap.org/${encodeURIComponent(result.osmType)}/${encodeURIComponent(result.osmId)}`
          : `https://www.openstreetmap.org/?mlat=${encodeURIComponent(result.lat)}&mlon=${encodeURIComponent(result.lng)}#map=13/${encodeURIComponent(result.lat)}/${encodeURIComponent(result.lng)}`;
        window.open(osmUrl, "_blank", "noopener,noreferrer");
      }
      if (action === "plan") addRouteSearchResultToDriveDay(index);
      if (action === "remove-plan") removePlannedDriveStopBySourceKey(result.key);
      if (action === "destination") {
        const days = card.querySelector("[data-route-result-days]")?.value || "1";
        addRouteSearchResultAsDestination(index, days);
      }
    }
