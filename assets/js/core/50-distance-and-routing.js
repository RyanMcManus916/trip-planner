"use strict";

/* ---------------------------------------------------------------------
       Distance and route calculations
       --------------------------------------------------------------------- */
    function haversineMiles(a, b) {
      const earthRadiusMiles = 3958.8;
      const toRadians = (degrees) => degrees * Math.PI / 180;
      const dLat = toRadians(b.lat - a.lat);
      const dLng = toRadians(b.lng - a.lng);
      const lat1 = toRadians(a.lat);
      const lat2 = toRadians(b.lat);
      const sinLat = Math.sin(dLat / 2);
      const sinLng = Math.sin(dLng / 2);
      const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
      return earthRadiusMiles * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
    }

    function sameLocation(a, b, tolerance = 0.00001) {
      return Boolean(a && b)
        && Math.abs(Number(a.lat) - Number(b.lat)) <= tolerance
        && Math.abs(Number(a.lng) - Number(b.lng)) <= tolerance;
    }

    function tripHasMovement() {
      return getEnabledStops().length > 0 || !sameLocation(state.start, state.end);
    }

    function estimateLeg(a, b) {
      if (!a || !b || (a.lat === b.lat && a.lng === b.lng)) {
        return { miles: 0, hours: 0, source: "same location" };
      }

      const known = KNOWN_LEGS[`${a.id}|${b.id}`] || KNOWN_LEGS[`${b.id}|${a.id}`];
      if (known) return { ...known, source: "known planning estimate" };

      const straightMiles = haversineMiles(a, b);
      const roadFactor = straightMiles < 45 ? 1.28 : straightMiles < 180 ? 1.23 : 1.18;
      const miles = straightMiles * roadFactor;
      const averageSpeed = miles < 55 ? 42 : miles < 180 ? 48 : 53;
      const hours = miles / averageSpeed + 0.12;
      return { miles, hours, source: "coordinate-based estimate" };
    }

    function buildRouteKey(points) {
      return points
        .map((point) => `${Number(point.lat).toFixed(5)},${Number(point.lng).toFixed(5)}`)
        .join("|");
    }

    function getCachedRoadRoute(points) {
      const key = buildRouteKey(points);
      const route = state.roadRouteCache.get(key);
      if (!route || route.legs.length !== Math.max(0, points.length - 1)) return null;
      return route;
    }

    function drawRoadRouteGeometry(route) {
      if (!state.map || !state.routeLayer || !route?.latLngs?.length) return;
      if (state.routePolyline && state.routeLayer.hasLayer(state.routePolyline)) {
        state.routeLayer.removeLayer(state.routePolyline);
      }
      state.routePolyline = L.polyline(route.latLngs, {
        color: "#9c4337",
        weight: 5,
        opacity: 0.92,
        lineCap: "round",
        lineJoin: "round"
      }).addTo(state.routeLayer);
    }

    function drawEstimatedRouteLine(points) {
      if (!state.map || !state.routeLayer || points.length < 2) return;
      const latLngs = points.map((point) => [point.lat, point.lng]);
      state.routePolyline = L.polyline(latLngs, {
        color: "#9c4337",
        weight: 5,
        opacity: 0.75,
        dashArray: "10 7"
      }).addTo(state.routeLayer);
    }

    function cancelRoadRouteRequest() {
      if (state.roadRouteTimer) {
        window.clearTimeout(state.roadRouteTimer);
        state.roadRouteTimer = null;
      }
      if (state.roadRouteController) {
        state.roadRouteController.abort();
        state.roadRouteController = null;
      }
      state.pendingRoadRouteKey = null;
    }

    function scheduleRoadRoute(points) {
      if (!state.routeCreated || points.length < 2) return;
      const routeKey = buildRouteKey(points);
      const cached = getCachedRoadRoute(points);
      if (cached) {
        drawRoadRouteGeometry(cached);
        return;
      }
      const retryAfter = state.roadRouteFailureUntil?.get(routeKey) || 0;
      if (retryAfter > Date.now()) return;
      if (state.pendingRoadRouteKey === routeKey) {
        showMapMessage("Loading the road-following driving route…");
        return;
      }

      cancelRoadRouteRequest();
      state.pendingRoadRouteKey = routeKey;
      showMapMessage("Loading the road-following driving route…");

      const elapsed = Date.now() - state.lastRoadRequestAt;
      const delay = Math.max(250, 850 - elapsed);
      state.roadRouteTimer = window.setTimeout(() => {
        state.roadRouteTimer = null;
        fetchRoadRoute(points, routeKey);
      }, delay);
    }


    function localFileLikeContext() {
      const protocol = String(window.location.protocol || "").toLowerCase();
      const href = String(window.location.href || "").toLowerCase();
      return protocol === "file:" || protocol === "edge:" || href.startsWith("edge://") || href.startsWith("file://");
    }

    function makeAbortError(message = "Request cancelled.") {
      const error = new Error(message);
      error.name = "AbortError";
      return error;
    }

    // JSONP is used only as a geocoding compatibility fallback. Mobile Edge on
    // iOS can display a locally opened HTML file while blocking fetch() requests
    // from the edge://external-file security context. Nominatim supports a
    // callback-wrapped JSON response, which can still load through a script tag.
    function requestJsonp(url, callbackParam, timeoutMs = 16000, signal = null) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(makeAbortError());
          return;
        }

        const callbackName = `__tripPlannerJsonp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const script = document.createElement("script");
        let timer = null;
        let settled = false;

        const cleanup = () => {
          if (timer) window.clearTimeout(timer);
          script.remove();
          try { delete window[callbackName]; } catch (_) { window[callbackName] = undefined; }
          signal?.removeEventListener?.("abort", onAbort);
        };
        const finish = (handler, value) => {
          if (settled) return;
          settled = true;
          cleanup();
          handler(value);
        };
        const onAbort = () => finish(reject, makeAbortError());

        window[callbackName] = (data) => finish(resolve, data);
        script.async = true;
        script.referrerPolicy = "no-referrer";
        script.onerror = () => finish(reject, new Error("The compatibility request could not reach the online service."));
        const joiner = url.includes("?") ? "&" : "?";
        script.src = `${url}${joiner}${encodeURIComponent(callbackParam)}=${encodeURIComponent(callbackName)}`;
        timer = window.setTimeout(() => finish(reject, new Error("The compatibility request timed out.")), timeoutMs);
        signal?.addEventListener?.("abort", onAbort, { once: true });
        document.head.appendChild(script);
      });
    }

    async function requestJsonWithLocalFileFallback(url, options = {}) {
      const {
        timeoutMs = 16000,
        jsonpParam = null,
        signal = null,
        headers = { "Accept": "application/json" }
      } = options;
      let lastError = null;

      const tryFetch = async () => {
        if (signal?.aborted) throw makeAbortError();
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        signal?.addEventListener?.("abort", onAbort, { once: true });
        const timer = window.setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch(url, {
            method: "GET",
            headers,
            signal: controller.signal,
            cache: "no-store",
            mode: "cors"
          });
          if (!response.ok) throw new Error(`Online service returned ${response.status}.`);
          return await response.json();
        } finally {
          window.clearTimeout(timer);
          signal?.removeEventListener?.("abort", onAbort);
        }
      };

      const attempts = localFileLikeContext() && jsonpParam
        ? ["jsonp", "fetch"]
        : ["fetch", ...(jsonpParam ? ["jsonp"] : [])];

      for (const attempt of attempts) {
        try {
          if (attempt === "jsonp") return await requestJsonp(url, jsonpParam, timeoutMs, signal);
          return await tryFetch();
        } catch (error) {
          if (error?.name === "AbortError" && signal?.aborted) throw error;
          lastError = error;
        }
      }
      throw lastError || new Error("The online service did not respond.");
    }

    async function fetchRoadRoute(points, routeKey) {
      const coordinates = points
        .map((point) => `${Number(point.lng).toFixed(6)},${Number(point.lat).toFixed(6)}`)
        .join(";");
      const params = new URLSearchParams({
        alternatives: "false",
        steps: "true",
        geometries: "geojson",
        overview: "full",
        annotations: "false",
        continue_straight: "false"
      });
      const controller = new AbortController();
      state.roadRouteController = controller;
      state.lastRoadRequestAt = Date.now();
      const endpointBases = [
        "https://router.project-osrm.org/route/v1/driving/",
        "https://routing.openstreetmap.de/routed-car/route/v1/driving/"
      ];
      let lastError = null;

      try {
        let data = null;
        for (const base of endpointBases) {
          if (controller.signal.aborted) throw makeAbortError();
          try {
            const url = `${base}${coordinates}?${params.toString()}`;
            const candidate = await requestJsonWithLocalFileFallback(url, {
              timeoutMs: 15000,
              signal: controller.signal
            });
            if (candidate?.code === "Ok" && candidate.routes?.length) {
              data = candidate;
              break;
            }
            throw new Error(candidate?.message || "No drivable route was returned.");
          } catch (error) {
            if (error?.name === "AbortError" && controller.signal.aborted) throw error;
            lastError = error;
          }
        }
        if (!data) throw lastError || new Error("No road-routing service responded.");

        const result = data.routes[0];
        const roadRoute = {
          key: routeKey,
          latLngs: result.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
          totalMiles: result.distance / 1609.344,
          totalHours: result.duration / 3600,
          legs: result.legs.map((leg) => {
            const path = [];
            (leg.steps || []).forEach((step) => {
              const coordinates = step.geometry?.coordinates || [];
              coordinates.forEach(([lng, lat]) => {
                const previous = path.at(-1);
                if (!previous || previous[0] !== lat || previous[1] !== lng) path.push([lat, lng]);
              });
            });
            return {
              miles: leg.distance / 1609.344,
              hours: leg.duration / 3600,
              source: "OpenStreetMap road route",
              path
            };
          })
        };
        state.roadRouteCache.set(routeKey, roadRoute);
        state.roadRouteFailureUntil?.delete(routeKey);

        if (buildRouteKey(getRoutePoints()) !== routeKey) return;
        if ($("mapRetryRoadBtn")) $("mapRetryRoadBtn").hidden = true;
        hideMapMessage();
        renderMap();
        renderSummary();
        renderItinerary();
        populateRouteQuestionLegs();
        ensureOvernightLodgingSuggestions();
        if (typeof epLog === "function") epLog("Road-following route loaded successfully.", "success");
      } catch (error) {
        if (error?.name === "AbortError" && buildRouteKey(getRoutePoints()) !== routeKey) return;
        if (buildRouteKey(getRoutePoints()) === routeKey) {
          if (!state.roadRouteFailureUntil) state.roadRouteFailureUntil = new Map();
          state.roadRouteFailureUntil.set(routeKey, Date.now() + 45000);
          if ($("mapRetryRoadBtn")) $("mapRetryRoadBtn").hidden = false;
          hideMapMessage();
          setStatus(
            "plannerStatus",
            "The trip was created, but mobile Edge could not reach the live road-routing service. A dashed estimated route is shown instead. The itinerary remains usable; open Service status and tap Retry road route when the connection is available.",
            "warning"
          );
          if (typeof epLog === "function") epLog(`Road routing fallback used: ${error?.message || "service unavailable"}`, "warning");
        }
      } finally {
        if (state.roadRouteController === controller) state.roadRouteController = null;
        if (state.pendingRoadRouteKey === routeKey) state.pendingRoadRouteKey = null;
      }
    }

    function getEnabledStops(stops = state.routeStops) {
      return stops.filter((stop) => stop.enabled !== false);
    }

    function getRoutePoints(stops = state.routeStops) {
      return [state.start, ...getEnabledStops(stops), state.end];
    }

    function fullDaysForStop(stop) {
      if (!stop) return 0;
      if (stop.visitStyle === "passThrough") return 0;
      const parsed = Number(stop.days);
      return clamp(Number.isFinite(parsed) ? parsed : 1, 0, 10);
    }

    function calculateRouteSummary(stops = state.routeStops, preferences = getPreferences()) {
      const enabledStops = getEnabledStops(stops);
      const points = [state.start, ...enabledStops, state.end];
      const cachedRoadRoute = getCachedRoadRoute(points);
      const legs = [];
      let totalMiles = 0;
      let totalHours = 0;
      let travelDays = 0;

      for (let i = 0; i < points.length - 1; i += 1) {
        const from = points[i];
        const to = points[i + 1];
        const estimate = cachedRoadRoute?.legs[i] || estimateLeg(from, to);
        // A lodging stop may fall beyond the mileage target by the user-selected
        // percentage when that produces a substantially better overnight city.
        // Driving hours remain a firm planning limit because congestion and road
        // type vary too much to safely infer an equivalent time tolerance.
        const lodgingMileageLimit = preferences.maxMiles * (1 + preferences.lodgingWindowRatio);
        const requiredDays = estimate.miles === 0
          ? 0
          : Math.max(1, Math.ceil(Math.max(estimate.miles / lodgingMileageLimit, estimate.hours / preferences.maxHours)));
        const dailyMiles = requiredDays ? estimate.miles / requiredDays : 0;
        const dailyHours = requiredDays ? estimate.hours / requiredDays : 0;
        const exceedsMiles = dailyMiles > lodgingMileageLimit + 0.01;
        const exceedsHours = dailyHours > preferences.maxHours + 0.01;
        travelDays += requiredDays;
        totalMiles += estimate.miles;
        totalHours += estimate.hours;
        legs.push({ from, to, ...estimate, requiredDays, dailyMiles, dailyHours, exceedsMiles, exceedsHours });
      }

      // A stop's `days` value means complete destination days. Every driving
      // leg is counted separately, including the final transfer to the selected end.
      const fullDestinationDays = enabledStops.reduce((sum, stop) => sum + fullDaysForStop(stop), 0);
      const totalDays = fullDestinationDays + travelDays;
      const unusedDays = Math.max(0, preferences.tripDays - totalDays);
      const overDays = Math.max(0, totalDays - preferences.tripDays);
      const drivingLegs = legs.filter((leg) => leg.miles > 0.1).length;
      const enRouteOvernights = legs.reduce((sum, leg) => sum + Math.max(0, leg.requiredDays - 1), 0);

      return {
        enabledStops,
        points,
        legs,
        totalMiles,
        totalHours,
        drivingLegs,
        enRouteOvernights,
        averageMiles: drivingLegs ? totalMiles / drivingLegs : 0,
        stopDays: fullDestinationDays,
        fullDestinationDays,
        travelDays,
        totalDays,
        unusedDays,
        overDays,
        violatingLegs: legs.filter((leg) => leg.exceedsMiles || leg.exceedsHours),
        usesRoadRouting: Boolean(cachedRoadRoute),
        routeSource: cachedRoadRoute ? "OpenStreetMap road routing" : "planning estimates"
      };
    }


    // Finds a coordinate at a proportional distance along a road-path polyline.
    function pointAlongPath(path, fraction) {
      if (!Array.isArray(path) || !path.length) return null;
      if (path.length === 1) return { lat: path[0][0], lng: path[0][1] };
      const safeFraction = clamp(fraction, 0, 1);
      const segmentLengths = [];
      let total = 0;
      for (let i = 0; i < path.length - 1; i += 1) {
        const length = haversineMiles(
          { lat: path[i][0], lng: path[i][1] },
          { lat: path[i + 1][0], lng: path[i + 1][1] }
        );
        segmentLengths.push(length);
        total += length;
      }
      if (!total) return { lat: path[0][0], lng: path[0][1] };
      const target = total * safeFraction;
      let covered = 0;
      for (let i = 0; i < segmentLengths.length; i += 1) {
        const nextCovered = covered + segmentLengths[i];
        if (target <= nextCovered || i === segmentLengths.length - 1) {
          const localFraction = segmentLengths[i] ? (target - covered) / segmentLengths[i] : 0;
          return {
            lat: path[i][0] + (path[i + 1][0] - path[i][0]) * localFraction,
            lng: path[i][1] + (path[i + 1][1] - path[i][1]) * localFraction
          };
        }
        covered = nextCovered;
      }
      return { lat: path.at(-1)[0], lng: path.at(-1)[1] };
    }

    function pathLengthMiles(path) {
      if (!Array.isArray(path) || path.length < 2) return 0;
      let total = 0;
      for (let i = 0; i < path.length - 1; i += 1) {
        total += haversineMiles(
          { lat: path[i][0], lng: path[i][1] },
          { lat: path[i + 1][0], lng: path[i + 1][1] }
        );
      }
      return total;
    }

    function buildPathDistanceIndex(path) {
      const cumulative = [0];
      let total = 0;
      for (let i = 0; i < path.length - 1; i += 1) {
        total += haversineMiles(
          { lat: path[i][0], lng: path[i][1] },
          { lat: path[i + 1][0], lng: path[i + 1][1] }
        );
        cumulative.push(total);
      }
      return { cumulative, total };
    }

    // Projects a city onto the nearest point represented by the OSRM geometry.
    // OSRM's full overview is dense enough that nearest-vertex projection is a
    // useful planning approximation without requiring a geometry library.
    function projectPlaceOntoPath(path, point, legMiles) {
      if (!Array.isArray(path) || !path.length) return null;
      const index = buildPathDistanceIndex(path);
      let nearestIndex = 0;
      let nearestMiles = Number.POSITIVE_INFINITY;
      path.forEach(([lat, lng], pathIndex) => {
        const distance = haversineMiles(point, { lat, lng });
        if (distance < nearestMiles) {
          nearestMiles = distance;
          nearestIndex = pathIndex;
        }
      });
      const geometryAlong = index.cumulative[nearestIndex] || 0;
      const ratio = index.total ? geometryAlong / index.total : 0;
      return {
        alongMiles: ratio * legMiles,
        lateralMiles: nearestMiles,
        routeLat: path[nearestIndex][0],
        routeLng: path[nearestIndex][1]
      };
    }

    function getLegOvernightPlans(leg) {
      if (!leg || leg.requiredDays <= 1) return [];
      const fallbackPath = [[leg.from.lat, leg.from.lng], [leg.to.lat, leg.to.lng]];
      const path = Array.isArray(leg.path) && leg.path.length > 1 ? leg.path : fallbackPath;
      const preferences = getPreferences();
      const idealSegmentMiles = leg.miles / leg.requiredDays;
      const toleranceMiles = preferences.maxMiles * preferences.lodgingWindowRatio;
      const plans = [];

      for (let overnightIndex = 1; overnightIndex < leg.requiredDays; overnightIndex += 1) {
        const targetMiles = idealSegmentMiles * overnightIndex;
        const fraction = leg.miles ? targetMiles / leg.miles : overnightIndex / leg.requiredDays;
        const point = pointAlongPath(path, fraction);
        if (!point) continue;
        const key = `${leg.from.id || leg.from.name}|${leg.to.id || leg.to.name}|${overnightIndex}|window-${preferences.lodgingWindowPercent}|${point.lat.toFixed(4)},${point.lng.toFixed(4)}`;
        plans.push({
          key,
          point,
          path,
          legMiles: leg.miles,
          legHours: leg.hours,
          overnightIndex,
          totalDriveDays: leg.requiredDays,
          targetMiles,
          toleranceMiles,
          minimumMiles: Math.max(0, targetMiles - toleranceMiles),
          maximumMiles: Math.min(leg.miles, targetMiles + toleranceMiles),
          lodging: state.overnightLodgingCache.get(key) || null,
          pending: state.overnightLookupPending.has(key)
        });
      }
      return plans;
    }

    function getAllOvernightPlans(summary = calculateRouteSummary()) {
      return summary.legs.flatMap((leg, legIndex) => getLegOvernightPlans(leg).map((plan) => ({ ...plan, leg, legIndex })));
    }

    async function waitForNominatimSlot() {
      const previousRequest = state.nominatimQueue;
      let releaseQueue;
      state.nominatimQueue = new Promise((resolve) => { releaseQueue = resolve; });
      await previousRequest;
      try {
        const elapsed = Date.now() - state.lastGeocodeAt;
        if (elapsed < 1100) await new Promise((resolve) => window.setTimeout(resolve, 1100 - elapsed));
        state.lastGeocodeAt = Date.now();
      } finally {
        releaseQueue();
      }
    }

    function parsePopulation(value) {
      const parsed = Number.parseInt(String(value || "").replaceAll(",", ""), 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    }

    function formatPopulation(population) {
      if (!population) return "Population not listed";
      if (population >= 1000000) return `${round(population / 1000000, 1)} million residents`;
      if (population >= 1000) return `${Math.round(population / 1000).toLocaleString()}k residents`;
      return `${population.toLocaleString()} residents`;
    }

    async function searchLargeLodgingCity(plan, usedNames = new Set(), previousBreakMiles = 0) {
      // Search a broad area around the ideal break point, then keep only places
      // that project into the user's selected mileage window and remain close to
      // the actual OSRM path. Population and place type drive the final ranking.
      const radiusMeters = 115000;
      const query = `[out:json][timeout:18];(
        node(around:${radiusMeters},${plan.point.lat},${plan.point.lng})["place"~"^(city|town)$"]["name"];
        way(around:${radiusMeters},${plan.point.lat},${plan.point.lng})["place"~"^(city|town)$"]["name"];
        relation(around:${radiusMeters},${plan.point.lat},${plan.point.lng})["place"~"^(city|town)$"]["name"];
      );out center tags;`;
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 18000);
      try {
        const response = await fetch("https://overpass-api.de/api/interpreter", {
          method: "POST",
          headers: {
            "Accept": "application/json",
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"
          },
          body: new URLSearchParams({ data: query }).toString(),
          signal: controller.signal
        });
        if (!response.ok) throw new Error(`City search returned ${response.status}.`);
        const data = await response.json();
        const candidates = (data.elements || []).map((element) => {
          const lat = Number(element.lat ?? element.center?.lat);
          const lng = Number(element.lon ?? element.center?.lon);
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
          const tags = element.tags || {};
          const name = String(tags.name || "").trim();
          if (!name || usedNames.has(name.toLowerCase())) return null;
          const projection = projectPlaceOntoPath(plan.path, { lat, lng }, plan.legMiles);
          if (!projection) return null;
          const population = parsePopulation(tags.population);
          const placeType = tags.place || "town";
          const preferences = getPreferences();
          const acceptedMileageLimit = preferences.maxMiles * (1 + preferences.lodgingWindowRatio);
          const segmentMilesFromPrevious = projection.alongMiles - previousBreakMiles;
          const remainingDriveDays = Math.max(1, plan.totalDriveDays - plan.overnightIndex);
          const remainingMiles = plan.legMiles - projection.alongMiles;
          const withinDistanceWindow = projection.alongMiles >= plan.minimumMiles
            && projection.alongMiles <= plan.maximumMiles;
          const keepsCurrentDayFeasible = segmentMilesFromPrevious > 0
            && segmentMilesFromPrevious <= acceptedMileageLimit + 0.01;
          const keepsRemainingDaysFeasible = remainingMiles / remainingDriveDays <= acceptedMileageLimit + 0.01;
          const routeDistanceLimit = placeType === "city" ? 32 : 24;
          if (!withinDistanceWindow || !keepsCurrentDayFeasible || !keepsRemainingDaysFeasible
              || projection.lateralMiles > routeDistanceLimit) return null;

          // A city with missing population still outranks a small unpopulated town.
          const assumedPopulation = population || (placeType === "city" ? 125000 : 18000);
          const populationScore = Math.log10(assumedPopulation + 1) * 38;
          const placeBonus = placeType === "city" ? 75 : 18;
          const capitalBonus = tags.capital ? 20 : 0;
          const targetPenalty = Math.abs(projection.alongMiles - plan.targetMiles)
            / Math.max(1, plan.toleranceMiles) * 28;
          const routePenalty = projection.lateralMiles * 2.2;
          return {
            name,
            lat,
            lng,
            ...projection,
            population,
            placeType,
            stateName: tags["addr:state"] || "",
            displayName: name,
            selectionSource: "major-city search",
            score: populationScore + placeBonus + capitalBonus - targetPenalty - routePenalty
          };
        }).filter(Boolean);

        candidates.sort((a, b) => b.score - a.score);
        const best = candidates[0];
        if (!best) return null;
        return {
          ...best,
          localityType: best.placeType,
          routeMilesIntoLeg: best.alongMiles,
          targetMiles: plan.targetMiles,
          toleranceMiles: plan.toleranceMiles,
          selectionNote: `${formatPopulation(best.population)} · about ${round(best.lateralMiles)} mi from the primary route · ${round(best.alongMiles)} mi into this leg`
        };
      } finally {
        window.clearTimeout(timeout);
      }
    }

    async function reverseGeocodeLodgingArea(point, plan = null) {
      await waitForNominatimSlot();
      const params = new URLSearchParams({
        lat: String(point.lat),
        lon: String(point.lng),
        format: "jsonv2",
        zoom: "10",
        addressdetails: "1",
        "accept-language": "en",
        application: "trail-history-road-trip-planner"
      });
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 12000);
      try {
        const response = await fetch(`https://nominatim.openstreetmap.org/reverse?${params.toString()}`, {
          method: "GET",
          headers: { "Accept": "application/json" },
          signal: controller.signal
        });
        if (!response.ok) throw new Error(`Lodging-area search returned ${response.status}.`);
        const result = await response.json();
        if (result.error) throw new Error(result.error);
        const address = result.address || {};
        const locality = address.city || address.town || address.village || address.municipality || address.hamlet || address.county || address.state_district;
        const stateCode = String(address["ISO3166-2-lvl4"] || address.state_code || "").replace(/^US-/, "");
        const stateName = stateCode || address.state || "";
        const fallbackName = String(result.display_name || "Approximate overnight area").split(",").slice(0, 2).join(",");
        const name = [locality, stateName].filter(Boolean).join(", ") || fallbackName;
        const lat = Number.parseFloat(result.lat) || point.lat;
        const lng = Number.parseFloat(result.lon) || point.lng;
        const projection = plan ? projectPlaceOntoPath(plan.path, { lat, lng }, plan.legMiles) : null;
        return {
          name,
          lat,
          lng,
          routeLat: projection?.routeLat ?? point.lat,
          routeLng: projection?.routeLng ?? point.lng,
          lateralMiles: projection?.lateralMiles ?? 0,
          routeMilesIntoLeg: projection?.alongMiles ?? plan?.targetMiles ?? 0,
          targetMiles: plan?.targetMiles ?? 0,
          toleranceMiles: plan?.toleranceMiles ?? 0,
          localityType: address.city ? "city" : address.town ? "town" : address.village ? "village" : "area",
          displayName: result.display_name || name,
          selectionSource: "nearest-community fallback",
          selectionNote: `No larger city was found within the ±${getPreferences().lodgingWindowPercent}% distance window; this is the nearest identifiable lodging community.`
        };
      } finally {
        window.clearTimeout(timeout);
      }
    }

    async function ensureOvernightLodgingSuggestions() {
      if (!state.routeCreated) return;
      const summary = calculateRouteSummary();
      // Wait for the road geometry before identifying overnight communities.
      if (!summary.usesRoadRouting) return;
      const routeKeyAtStart = buildRouteKey(summary.points);
      const plans = getAllOvernightPlans(summary);
      const usedNames = new Set();
      const previousBreakByLeg = new Map();
      plans.forEach((plan) => {
        const cached = state.overnightLodgingCache.get(plan.key);
        if (cached?.name) usedNames.add(cached.name.toLowerCase());
      });

      for (const plan of plans) {
        const cached = state.overnightLodgingCache.get(plan.key);
        if (cached) {
          previousBreakByLeg.set(plan.legIndex, cached.routeMilesIntoLeg ?? plan.targetMiles);
          continue;
        }
        if (state.overnightLookupPending.has(plan.key)) continue;
        state.overnightLookupPending.add(plan.key);
        renderItinerary();
        try {
          const previousBreakMiles = previousBreakByLeg.get(plan.legIndex) || 0;
          let lodging = await searchLargeLodgingCity(plan, usedNames, previousBreakMiles);
          if (!lodging) lodging = await reverseGeocodeLodgingArea(plan.point, plan);
          state.overnightLodgingCache.set(plan.key, lodging);
          if (lodging?.name) usedNames.add(lodging.name.toLowerCase());
        } catch (error) {
          try {
            const lodging = await reverseGeocodeLodgingArea(plan.point, plan);
            state.overnightLodgingCache.set(plan.key, lodging);
            if (lodging?.name) usedNames.add(lodging.name.toLowerCase());
          } catch (fallbackError) {
            state.overnightLodgingCache.set(plan.key, {
              name: "Approximate overnight area",
              lat: plan.point.lat,
              lng: plan.point.lng,
              routeLat: plan.point.lat,
              routeLng: plan.point.lng,
              routeMilesIntoLeg: plan.targetMiles,
              targetMiles: plan.targetMiles,
              toleranceMiles: plan.toleranceMiles,
              localityType: "area",
              selectionSource: "unavailable",
              selectionNote: "A city lookup was unavailable; use this approximate road-route break point.",
              unavailable: true
            });
          }
        } finally {
          state.overnightLookupPending.delete(plan.key);
        }
        const selectedLodging = state.overnightLodgingCache.get(plan.key);
        previousBreakByLeg.set(plan.legIndex, selectedLodging?.routeMilesIntoLeg ?? plan.targetMiles);
        if (!state.routeCreated || buildRouteKey(getRoutePoints()) !== routeKeyAtStart) return;
        renderItinerary();
        renderMap();
      }
    }

    function showLodgingOnMap(key) {
      const lodging = state.overnightLodgingCache.get(key);
      if (!lodging || !state.map) return;
      state.map.setView([lodging.lat, lodging.lng], 9);
      const marker = state.markerIndex.get(`lodging:${key}`);
      if (marker) marker.openPopup();
    }

    function lowestCostInsertionIndex(stops, newStop) {
      const enabled = getEnabledStops(stops);
      if (enabled.length === 0) return stops.length;

      const enabledPositions = [];
      stops.forEach((stop, index) => {
        if (stop.enabled !== false) enabledPositions.push(index);
      });

      const points = [state.start, ...enabled, state.end];
      let bestEnabledInsertion = 0;
      let smallestIncrease = Number.POSITIVE_INFINITY;

      for (let i = 0; i < points.length - 1; i += 1) {
        const before = points[i];
        const after = points[i + 1];
        const increase = estimateLeg(before, newStop).miles + estimateLeg(newStop, after).miles - estimateLeg(before, after).miles;
        if (increase < smallestIncrease) {
          smallestIncrease = increase;
          bestEnabledInsertion = i;
        }
      }

      if (bestEnabledInsertion >= enabledPositions.length) return stops.length;
      return enabledPositions[bestEnabledInsertion];
    }

    function insertStopAtLowestCost(stops, newStop) {
      const copy = [...stops];
      const index = lowestCostInsertionIndex(copy, newStop);
      copy.splice(index, 0, newStop);
      return copy;
    }
