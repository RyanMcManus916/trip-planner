"use strict";

/* ---------------------------------------------------------------------
       Leaflet map rendering
       --------------------------------------------------------------------- */
    function createPinIcon(kind, label) {
      return L.divIcon({
        className: "",
        html: `<div class="map-pin pin-${kind}"><span>${escapeHtml(label)}</span></div>`,
        iconSize: [30, 30],
        iconAnchor: [15, 29],
        popupAnchor: [0, -28]
      });
    }

    function configuredTileLayer(provider, extraOptions = {}) {
      return L.tileLayer(provider.url, {
        maxZoom: provider.maxZoom,
        attribution: provider.attribution,
        referrerPolicy: MAP_TILE_CONFIG.referrerPolicy,
        providerKey: provider.key,
        ...extraOptions
      });
    }

    function initializeMap() {
      if (typeof L === "undefined") {
        $("mapFallback").classList.add("show");
        return;
      }

      const hostedContext = !localFileLikeContext()
        && ["http:", "https:"].includes(String(window.location.protocol || "").toLowerCase());
      const streetProvider = MAP_TILE_CONFIG.providers.street;
      const topoProvider = MAP_TILE_CONFIG.providers.topographic;
      const street = configuredTileLayer(streetProvider, {
        disabled: !hostedContext,
        disabledReason: "Publish this planner over HTTPS to use online street-map tiles."
      });
      const topo = configuredTileLayer(topoProvider, {
        disabled: !hostedContext,
        disabledReason: "Publish this planner over HTTPS to use online topographic tiles."
      });

      // This local canvas has no geographic detail, but it keeps route lines and
      // markers usable without sending policy-noncompliant requests from file://.
      const offlineSvg = encodeURIComponent(`
        <svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
          <rect width="256" height="256" fill="#e8eee8"/>
          <path d="M0 64H256M0 128H256M0 192H256M64 0V256M128 0V256M192 0V256" stroke="#ced9cf" stroke-width="1"/>
          <path d="M0 0L256 256M256 0L0 256" stroke="#dbe3db" stroke-width="1"/>
        </svg>`);
      const offlineCanvas = L.tileLayer(`data:image/svg+xml;charset=UTF-8,${offlineSvg}`, {
        maxZoom: 19,
        attribution: "Offline planning canvas",
        providerKey: "offline"
      });

      // Start on the local canvas while a single policy-compliant health check
      // selects the online provider. This prevents a 403 block image from being
      // requested repeatedly across the full viewport.
      const initialLayer = offlineCanvas;
      state.mapTileProvider = "offline";
      state.mapTileHealth = hostedContext ? "checking" : "local-file";
      state.mapTileLastStatus = null;
      state.map = L.map("map", {
        center: [state.start.lat, state.start.lng],
        zoom: 6,
        layers: [initialLayer],
        zoomControl: true
      });
      state.map.getContainer().addEventListener("tripplanner:baselayerchange", (event) => {
        const providerKey = event?.detail?.providerKey;
        if (!providerKey) return;
        state.mapTileProvider = providerKey;
        if (providerKey === "offline" && state.mapTileHealth === "available") state.mapTileHealth = "manual-offline";
      });
      if (L.__embeddedFallback) {
        document.documentElement.classList.add("embedded-map-engine-active");
        console.info("Trip planner: using the embedded map engine.");
      }

      let tileFallbackStage = hostedContext ? -1 : 2;
      let primaryTileErrors = 0;
      let backupTileErrors = 0;
      let tileNoticeTimer = null;
      const announceTileFallback = (message, duration = 8500) => {
        showMapMessage(message);
        if (tileNoticeTimer) window.clearTimeout(tileNoticeTimer);
        tileNoticeTimer = window.setTimeout(() => hideMapMessage(), duration);
      };
      const activateTileLayer = (layer, stage, providerKey, health, message) => {
        if (tileFallbackStage >= stage || !state.map) return false;
        tileFallbackStage = stage;
        state.mapTileProvider = providerKey;
        state.mapTileHealth = health;
        layer.addTo(state.map);
        if (message) announceTileFallback(message);
        return true;
      };
      const activateTopographicFallback = (reason) => activateTileLayer(
        topo,
        1,
        "topographic",
        reason,
        "The OpenStreetMap street tiles were unavailable, so the planner switched to the topographic backup."
      );
      const activateOfflineFallback = (reason) => activateTileLayer(
        offlineCanvas,
        2,
        "offline",
        reason,
        "Online map tiles are unavailable. Route lines and markers remain usable on the offline planning canvas."
      );

      const handlePrimaryTileError = () => {
        state.tileErrorCount += 1;
        primaryTileErrors += 1;
        if (primaryTileErrors >= 3) activateTopographicFallback("tile-error");
      };
      const handleBackupTileError = () => {
        state.tileErrorCount += 1;
        backupTileErrors += 1;
        if (backupTileErrors >= 3) activateOfflineFallback("backup-tile-error");
      };
      street.on("tileerror", handlePrimaryTileError);
      topo.on("tileerror", handleBackupTileError);

      state.candidateLayer = L.layerGroup().addTo(state.map);
      state.routeLayer = L.layerGroup().addTo(state.map);
      state.plannedDriveStopLayer = L.layerGroup().addTo(state.map);
      state.routeSearchLayer = L.layerGroup().addTo(state.map);
      const baseLayers = hostedContext
        ? {
            "Street map": street,
            "Topographic backup": topo,
            "Offline route canvas": offlineCanvas
          }
        : {
            "Offline route canvas": offlineCanvas,
            "Street map (HTTPS required)": street,
            "Topographic map (HTTPS required)": topo
          };
      L.control.layers(baseLayers, null, { position: "bottomright" }).addTo(state.map);

      const legend = L.control({ position: "bottomleft" });
      legend.onAdd = () => {
        const div = L.DomUtil.create("div", "legend");
        div.innerHTML = `
          <div><strong>Map legend</strong></div>
          <div class="legend-row"><span class="legend-dot" style="background:#173f35"></span>Start</div>
          <div class="legend-row"><span class="legend-dot" style="background:#172821;border-color:#d4a74f"></span>Finish</div>
          <div class="legend-row"><span class="legend-dot" style="background:#9c4337"></span>Selected stop</div>
          <div class="legend-row"><span class="legend-dot" style="background:#4c7569"></span>Interesting stop</div>
          <div class="legend-row"><span class="legend-dot" style="background:#d4a74f"></span>Custom stop</div>
          <div class="legend-row"><span class="legend-dot" style="background:#356f7b"></span>☾ Overnight lodging city</div>
          <div class="legend-row"><span class="legend-dot" style="background:#665078"></span>Route search result</div>
          <div class="legend-row"><span class="legend-dot" style="background:#2f6b55"></span>✓ Planned drive-day stop</div>
          <div class="legend-row"><span class="legend-line"></span>Road-following route</div>
          <div class="legend-row"><span class="legend-line-fallback"></span>Estimated fallback</div>`;
        L.DomEvent.disableClickPropagation(div);
        L.DomEvent.disableScrollPropagation(div);
        return div;
      };
      legend.addTo(state.map);
      state.map.getContainer().addEventListener("click", handleMapPopupAction);
      renderMap();

      const probeProvider = async (provider) => {
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), MAP_TILE_CONFIG.probeTimeoutMs);
        try {
          const response = await fetch(provider.probeUrl, {
            method: "GET",
            mode: "cors",
            cache: "default",
            credentials: "omit",
            referrerPolicy: MAP_TILE_CONFIG.referrerPolicy,
            signal: controller.signal
          });
          state.mapTileLastStatus = response.status;
          const ok = response.ok;
          try { await response.body?.cancel(); } catch (_) { /* response body is not needed */ }
          return ok;
        } catch (error) {
          // Some tile services may not expose CORS status even though image tiles
          // can load. Let normal tile events decide in that case.
          console.info(`Trip planner: ${provider.label} health probe was inconclusive.`, error?.message || error);
          return null;
        } finally {
          window.clearTimeout(timer);
        }
      };

      if (!hostedContext) {
        window.setTimeout(() => announceTileFallback(
          "This planner is open as a local file. Online map tiles are disabled to comply with provider rules; publish the project over HTTPS for the full map.",
          12000
        ), 200);
      } else {
        window.setTimeout(async () => {
          const streetAvailable = await probeProvider(streetProvider);
          if (streetAvailable === true) {
            activateTileLayer(street, 0, "street", "available", "");
            return;
          }
          if (streetAvailable === null) {
            // A CORS-inconclusive probe does not necessarily mean image tiles
            // are unavailable. Try the layer and let tileerror events decide.
            activateTileLayer(street, 0, "street", "unverified", "");
            return;
          }

          const streetStatus = state.mapTileLastStatus || "error";
          const topoAvailable = await probeProvider(topoProvider);
          if (topoAvailable === true) {
            activateTileLayer(
              topo,
              1,
              "topographic",
              "backup-available",
              "The OpenStreetMap street service rejected this request, so the planner switched to the topographic backup."
            );
          } else if (topoAvailable === null) {
            activateTileLayer(
              topo,
              1,
              "topographic",
              "backup-unverified",
              "The street map was blocked. The planner is trying its topographic backup."
            );
          } else {
            activateOfflineFallback(`street-http-${streetStatus};backup-http-${state.mapTileLastStatus || "error"}`);
          }
        }, 0);
      }

      window.setTimeout(() => {
        if (!document.querySelector("#map .leaflet-pane")) $("mapFallback").classList.add("show");
      }, 3500);
    }

    function showMapMessage(message) {
      const el = $("mapMessage");
      el.textContent = message;
      el.classList.add("show");
    }

    function hideMapMessage() {
      $("mapMessage").classList.remove("show");
    }

    function stopPopupHtml(stop, selectedState) {
      const routeExists = state.routeCreated;
      let action = "";
      if (selectedState === "enabled") {
        action = `<button class="btn-danger" type="button" data-map-action="remove" data-stop-id="${escapeHtml(stop.id)}">Remove from route</button>`;
      } else if (selectedState === "disabled") {
        action = `<button class="btn-primary" type="button" data-map-action="enable" data-stop-id="${escapeHtml(stop.id)}">Re-enable stop</button>`;
      } else if (routeExists) {
        action = `<button class="btn-primary" type="button" data-map-action="add" data-stop-id="${escapeHtml(stop.id)}">Add to route</button>`;
      } else {
        action = `<button class="btn-gold" type="button" data-map-action="idea" data-stop-id="${escapeHtml(stop.id)}">Add to must-see ideas</button>`;
      }

      return `
        <div class="popup-title">${escapeHtml(stop.name)}</div>
        <div class="popup-meta">${escapeHtml(stop.category)} · ${escapeHtml(stop.duration || `${stop.days || 1} day`)}</div>
        <div>${escapeHtml(stop.description)}</div>
        <div class="popup-meta"><strong>Visit style:</strong> ${escapeHtml(stop.overnight || "Custom stop")}</div>
        <div class="popup-actions">${action}</div>`;
    }

    function renderMap() {
      if (!state.map || typeof L === "undefined") return;
      hideMapMessage();
      state.candidateLayer.clearLayers();
      state.routeLayer.clearLayers();
      if (state.plannedDriveStopLayer) state.plannedDriveStopLayer.clearLayers();
      if (state.routeSearchLayer) state.routeSearchLayer.clearLayers();
      state.markerIndex.clear();

      const enabledStops = getEnabledStops();
      const selectedIds = new Set(state.routeStops.map((stop) => stop.id));

      const startMarker = L.marker([state.start.lat, state.start.lng], { icon: createPinIcon("start", "S"), zIndexOffset: 1000 })
        .bindPopup(`<div class="popup-title">${escapeHtml(state.start.name)}</div><div class="popup-meta">Start location</div><div>The route begins here.</div>`)
        .addTo(state.routeLayer);
      state.markerIndex.set("__start", startMarker);

      const endpointsOverlap = sameLocation(state.start, state.end);
      if (!endpointsOverlap || state.routeCreated) {
        const finishDisplay = endpointsOverlap
          ? [state.end.lat + 0.018, state.end.lng + 0.018]
          : [state.end.lat, state.end.lng];
        const finishNote = endpointsOverlap
          ? "The finish pin is slightly offset for visibility; the trip ends at the same physical location as the start."
          : "The route ends here.";
        const finishMarker = L.marker(finishDisplay, { icon: createPinIcon("finish", "F"), zIndexOffset: 1100 })
          .bindPopup(`<div class="popup-title">${escapeHtml(state.end.name)}</div><div class="popup-meta">Finish location</div><div>${finishNote}</div>`)
          .addTo(state.routeLayer);
        state.markerIndex.set("__end", finishMarker);
        state.markerIndex.set("__finish", finishMarker);
      }

      const allCandidateStops = [...CANDIDATES, ...state.customStops];
      allCandidateStops.forEach((stop) => {
        if (enabledStops.some((selected) => selected.id === stop.id)) return;
        const isDisabled = selectedIds.has(stop.id);
        const kind = stop.custom ? "custom" : isDisabled ? "disabled" : "candidate";
        const marker = L.marker([stop.lat, stop.lng], { icon: createPinIcon(kind, stop.custom ? "C" : "•") })
          .bindPopup(stopPopupHtml(stop, isDisabled ? "disabled" : "unselected"))
          .addTo(state.candidateLayer);
        state.markerIndex.set(stop.id, marker);
      });

      enabledStops.forEach((stop, index) => {
        const kind = stop.custom ? "custom" : "route";
        const marker = L.marker([stop.lat, stop.lng], { icon: createPinIcon(kind, String(index + 1)), zIndexOffset: 800 })
          .bindPopup(stopPopupHtml(stop, "enabled"))
          .addTo(state.routeLayer);
        state.markerIndex.set(stop.id, marker);
      });

      if (state.routeCreated) {
        const lodgingPlans = getAllOvernightPlans(calculateRouteSummary());
        lodgingPlans.forEach((plan) => {
          const lodging = state.overnightLodgingCache.get(plan.key);
          if (!lodging) return;
          if (Number.isFinite(lodging.routeLat) && Number.isFinite(lodging.routeLng)
              && haversineMiles({ lat: lodging.lat, lng: lodging.lng }, { lat: lodging.routeLat, lng: lodging.routeLng }) > 1) {
            L.polyline([[lodging.routeLat, lodging.routeLng], [lodging.lat, lodging.lng]], {
              color: "#356f7b",
              weight: 3,
              opacity: 0.82,
              dashArray: "5 7",
              interactive: false
            }).addTo(state.routeLayer);
          }
          const marker = L.marker([lodging.lat, lodging.lng], { icon: createPinIcon("lodging", "☾"), zIndexOffset: 700 })
            .bindPopup(`<div class="popup-title">Overnight lodging city: ${escapeHtml(lodging.name)}</div><div class="popup-meta">${escapeHtml(lodging.localityType || "city")} · ${escapeHtml(lodging.selectionSource || "route-based selection")}</div><div>${escapeHtml(lodging.selectionNote || "Selected near the planned break point for this multi-day drive.")}</div><div class="popup-meta">The dotted connector shows the approximate offset from the primary route. Verify lodging, road conditions, and the final route before booking.</div>`)
            .addTo(state.routeLayer);
          state.markerIndex.set(`lodging:${plan.key}`, marker);
        });
      }

      if (state.routeCreated && tripHasMovement()) {
        const routePoints = getRoutePoints();
        const cachedRoadRoute = getCachedRoadRoute(routePoints);
        if (cachedRoadRoute) {
          drawRoadRouteGeometry(cachedRoadRoute);
        } else {
          drawEstimatedRouteLine(routePoints);
          scheduleRoadRoute(routePoints);
        }

      } else {
        cancelRoadRouteRequest();
        state.routePolyline = null;
      }
      renderPlannedDriveStopMarkers();
      renderRouteSearchMarkers();
    }

    function zoomToFullRoute() {
      if (!state.map) return;
      if (state.routeCreated && state.routePolyline && state.routeLayer.hasLayer(state.routePolyline)) {
        const bounds = state.routePolyline.getBounds();
        if (bounds.isValid()) {
          state.map.fitBounds(bounds, { padding: [35, 35], maxZoom: 9 });
          return;
        }
      }
      const points = state.routeCreated && tripHasMovement()
        ? getRoutePoints().map((point) => [point.lat, point.lng])
        : [[state.start.lat, state.start.lng], [state.end.lat, state.end.lng], ...CANDIDATES.map((stop) => [stop.lat, stop.lng])];
      state.map.fitBounds(L.latLngBounds(points), { padding: [35, 35], maxZoom: 7 });
    }

    function zoomToUsStopOverview() {
      if (!state.map || !CANDIDATES.length) return;
      const bounds = L.latLngBounds(CANDIDATES.map((stop) => [stop.lat, stop.lng]));
      if (bounds.isValid()) state.map.fitBounds(bounds, { padding: [30, 30], maxZoom: 5 });
    }

    function zoomToFilteredStops() {
      if (!state.map) return;
      const stops = getFilteredBrowserStops();
      if (!stops.length) {
        setStatus("stopBrowserStatus", "No stops match the current filters.", "warning");
        return;
      }
      const bounds = L.latLngBounds(stops.map((stop) => [stop.lat, stop.lng]));
      if (bounds.isValid()) state.map.fitBounds(bounds, { padding: [35, 35], maxZoom: stops.length === 1 ? 10 : 7 });
      setStatus("stopBrowserStatus", `Showing ${stops.length} matching stop${stops.length === 1 ? "" : "s"} on the map.`, "success");
    }

    function clearStopBrowserFilters() {
      $("stopSearch").value = "";
      $("stopRegion").value = "all";
      $("stopCategory").value = "all";
      $("stopSort").value = "distance";
      $("stopResultLimit").value = "40";
      clearStatus("stopBrowserStatus");
      renderStopBrowser();
    }

    function showStopOnMap(stopId) {
      if (!state.map) return;
      const stop = stopId === "__start"
        ? state.start
        : (stopId === "__end" || stopId === "__finish")
          ? state.end
          : findStopById(stopId);
      if (!stop) return;
      state.map.setView([stop.lat, stop.lng], Math.max(state.map.getZoom(), 9));
      const marker = state.markerIndex.get(stopId);
      if (marker) marker.openPopup();
    }

    function handleMapPopupAction(event) {
      const button = event.target.closest("button[data-map-action]");
      if (!button) return;
      const stopId = button.dataset.stopId;
      const action = button.dataset.mapAction;
      if (action === "add") addStopToRoute(stopId);
      if (action === "enable") toggleStop(stopId, true);
      if (action === "remove") removeStopFromRoute(stopId);
      if (action === "idea") addCandidateToIdeas(stopId);
      if (action === "add-route-search-plan" || action === "remove-route-search-plan") {
        const index = Number.parseInt(button.dataset.routeResultIndex, 10);
        const result = state.routeSearchResults[index];
        if (!result) {
          setStatus("routeQuestionStatus", "This map result is no longer current. Search the selected drive again.", "warning");
          return;
        }
        if (action === "add-route-search-plan") addRouteSearchResultToDriveDay(index);
        if (action === "remove-route-search-plan") removePlannedDriveStopBySourceKey(result.key);
      }
    }
