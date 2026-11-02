"use strict";

/* ---------------------------------------------------------------------
       Nominatim geocoding
       --------------------------------------------------------------------- */
    async function requestNominatimSearch(params) {
      await waitForNominatimSlot();
      const url = `https://nominatim.openstreetmap.org/search?${params.toString()}`;
      try {
        return await requestJsonWithLocalFileFallback(url, {
          timeoutMs: 14000,
          jsonpParam: "json_callback",
          headers: { "Accept": "application/json" }
        });
      } catch (primaryError) {
        // Photon provides a second OpenStreetMap-based geocoder when Nominatim
        // is unavailable. Its response is normalized to the Nominatim shape used
        // by the rest of the planner.
        const query = params.get("q") || "";
        const limit = clamp(Number.parseInt(params.get("limit"), 10) || 5, 1, 10);
        const photonParams = new URLSearchParams({ q: query, limit: String(limit), lang: "en" });
        try {
          const photon = await requestJsonWithLocalFileFallback(`https://photon.komoot.io/api/?${photonParams.toString()}`, {
            timeoutMs: 14000,
            headers: { "Accept": "application/json" }
          });
          return (photon?.features || []).map((feature, index) => {
            const properties = feature.properties || {};
            const coordinates = feature.geometry?.coordinates || [];
            const parts = [properties.name, properties.city, properties.county, properties.state, properties.country].filter(Boolean);
            return {
              place_id: properties.osm_id || `photon-${Date.now()}-${index}`,
              osm_id: properties.osm_id,
              osm_type: properties.osm_type,
              lat: String(coordinates[1]),
              lon: String(coordinates[0]),
              display_name: parts.join(", ") || query,
              name: properties.name || query,
              type: properties.type || properties.osm_value || "place",
              namedetails: { name: properties.name || query },
              address: {
                country_code: String(properties.countrycode || "").toLowerCase(),
                country: properties.country || "",
                state: properties.state || "",
                county: properties.county || "",
                city: properties.city || properties.locality || properties.district || ""
              }
            };
          }).filter((item) => Number.isFinite(Number(item.lat)) && Number.isFinite(Number(item.lon)));
        } catch (fallbackError) {
          if (primaryError?.name === "AbortError") throw new Error("The location search was cancelled.");
          throw new Error("The location search service could not be reached from this mobile browser. Confirm internet access or choose a built-in destination marker.");
        }
      }
    }

    async function geocodePlace(query, limit = 5) {
      const normalized = query.trim().toLowerCase();
      if (!normalized) throw new Error("Enter a location to search.");
      const safeLimit = clamp(Number.parseInt(limit, 10) || 5, 1, 10);
      const cacheKey = `americas-only|${normalized}|${safeLimit}`;
      if (state.geocodeCache.has(cacheKey)) return state.geocodeCache.get(cacheKey);

      const baseParams = {
        q: query,
        format: "jsonv2",
        limit: String(Math.max(safeLimit, 5)),
        addressdetails: "1",
        namedetails: "1",
        "accept-language": "en",
        application: "trail-history-road-trip-planner"
      };

      // First ask Nominatim only for countries and territories in the Americas.
      // This lets ambiguous names such as Paris or London resolve to an American
      // match when one exists rather than defaulting to Europe.
      const restrictedParams = new URLSearchParams({
        ...baseParams,
        countrycodes: AMERICAS_COUNTRY_CODES_PARAM
      });
      const restrictedResults = (await requestNominatimSearch(restrictedParams))
        .filter(isGeocodeResultInAmericas)
        .slice(0, safeLimit);
      if (restrictedResults.length) {
        state.geocodeCache.set(cacheKey, restrictedResults);
        return restrictedResults;
      }

      // If the restricted search found nothing, perform one unrestricted lookup
      // solely to distinguish a misspelling from an explicitly overseas location.
      const unrestrictedParams = new URLSearchParams(baseParams);
      const unrestrictedResults = await requestNominatimSearch(unrestrictedParams);
      const validAmericasResults = unrestrictedResults
        .filter(isGeocodeResultInAmericas)
        .slice(0, safeLimit);
      if (validAmericasResults.length) {
        state.geocodeCache.set(cacheKey, validAmericasResults);
        return validAmericasResults;
      }
      if (unrestrictedResults.length) throw createOutsideAmericasError(query, unrestrictedResults[0]);

      state.geocodeCache.set(cacheKey, []);
      return [];
    }

    async function setEndpointLocation(endpoint) {
      const isStart = endpoint === "start";
      const inputId = isStart ? "startLocation" : "endLocation";
      const buttonId = isStart ? "setStartBtn" : "setEndBtn";
      const statusId = isStart ? "startStatus" : "endStatus";
      const label = isStart ? "start" : "end";
      const query = $(inputId).value.trim();
      if (!query) {
        setStatus(statusId, `Enter an ${label} location.`, "warning");
        return false;
      }

      $(buttonId).disabled = true;
      setStatus(statusId, `Searching for the ${label} location…`, "info");
      try {
        const results = await geocodePlace(query, 1);
        if (!results.length) throw new Error(`No matching ${label} location was found.`);
        const result = results[0];
        if (!isGeocodeResultInAmericas(result)) throw createOutsideAmericasError(query, result);
        const location = {
          id: `${label}-${result.place_id}`,
          name: result.display_name,
          lat: Number.parseFloat(result.lat),
          lng: Number.parseFloat(result.lon),
          category: isStart ? "Start" : "Finish"
        };
        state[endpoint] = location;
        $(inputId).value = result.display_name;
        state.overnightLodgingCache.clear();
        state.overnightLookupPending.clear();
        clearRouteSearchResults({ silent: true });
        setStatus(statusId, `${isStart ? "Start" : "End"} location updated.`, "success");
        renderAll({ fitMap: state.routeCreated });
        if (state.map && !state.routeCreated) {
          if (sameLocation(state.start, state.end)) state.map.setView([state.start.lat, state.start.lng], 7);
          else state.map.fitBounds([[state.start.lat, state.start.lng], [state.end.lat, state.end.lng]], { padding: [45, 45], maxZoom: 7 });
        }
        return true;
      } catch (error) {
        setStatus(statusId, error.message || `The ${label} location could not be found.`, "error");
        return false;
      } finally {
        $(buttonId).disabled = false;
      }
    }

    function setStartLocation() {
      return setEndpointLocation("start");
    }

    function setEndLocation() {
      return setEndpointLocation("end");
    }

    function copyStartToEnd() {
      state.end = { ...state.start, category: "Finish" };
      $("endLocation").value = state.start.name;
      state.overnightLodgingCache.clear();
      state.overnightLookupPending.clear();
      clearRouteSearchResults({ silent: true });
      setStatus("endStatus", "End location now matches the start for a round trip.", "success");
      renderAll({ fitMap: state.routeCreated });
    }

    async function prepareEndpointsOrReport() {
      const startInput = $("startLocation").value.trim();
      const endInput = $("endLocation").value.trim();
      if (!startInput || !endInput) {
        setStatus("plannerStatus", "Enter both a start and an end location before creating the route.", "warning");
        return false;
      }
      if (normalizePlaceText(startInput) !== normalizePlaceText(state.start.name)) {
        const startReady = await setStartLocation();
        if (!startReady) {
          setStatus("plannerStatus", "The route was not created because the start location could not be resolved.", "error");
          return false;
        }
      }
      if (normalizePlaceText(endInput) !== normalizePlaceText(state.end.name)) {
        const endReady = await setEndLocation();
        if (!endReady) {
          setStatus("plannerStatus", "The route was not created because the end location could not be resolved.", "error");
          return false;
        }
      }
      return true;
    }

    async function submitCustomPlace(event) {
      event.preventDefault();
      const name = $("customPlaceName").value.trim();
      const description = $("customDescription").value.trim();
      const days = clamp(Number.parseInt($("customDays").value, 10) || 1, 1, 10);
      if (!name) {
        setStatus("geocodeStatus", "Enter a place name.", "warning");
        return;
      }

      $("customSubmitBtn").disabled = true;
      $("geocodeChoices").classList.add("hidden");
      $("geocodeChoices").innerHTML = "";
      setStatus("geocodeStatus", `Searching OpenStreetMap for “${name}”…`, "info");

      try {
        const results = await geocodePlace(name, 5);
        if (!results.length) throw new Error("No matching location was found. Try adding a city, state, or region.");
        state.pendingGeocodeResults = results.map((result) => ({ result, name, description, days }));

        if (results.length === 1) {
          addCustomGeocodeResult(0);
        } else {
          renderGeocodeChoices(results);
          setStatus("geocodeStatus", "Multiple matches were found. Select the best location below.", "warning");
        }
      } catch (error) {
        setStatus("geocodeStatus", error.message || "The location search failed. Check internet access and try again.", "error");
      } finally {
        $("customSubmitBtn").disabled = false;
      }
    }

    function renderGeocodeChoices(results) {
      const container = $("geocodeChoices");
      container.innerHTML = `
        <div class="field" style="margin-top:10px">
          <label for="geocodeSelect">Choose a matching place</label>
          <select id="geocodeSelect">
            ${results.map((result, index) => `<option value="${index}">${escapeHtml(result.display_name)}</option>`).join("")}
          </select>
        </div>
        <button id="useGeocodeResultBtn" class="btn-primary btn-small" type="button">Use selected result</button>`;
      container.classList.remove("hidden");
      $("useGeocodeResultBtn").addEventListener("click", () => {
        const index = Number.parseInt($("geocodeSelect").value, 10) || 0;
        addCustomGeocodeResult(index);
      }, { once: true });
    }

    function addCustomGeocodeResult(index) {
      const pending = state.pendingGeocodeResults[index];
      if (!pending) {
        setStatus("geocodeStatus", "The selected location is no longer available. Search again.", "error");
        return;
      }

      const { result, name, description, days } = pending;
      if (!isGeocodeResultInAmericas(result)) {
        setStatus("geocodeStatus", createOutsideAmericasError(name || result.display_name, result).message, "error");
        return;
      }
      const id = `custom-${result.place_id}-${Date.now()}`;
      const customStop = {
        id,
        name: name || result.display_name,
        lat: Number.parseFloat(result.lat),
        lng: Number.parseFloat(result.lon),
        category: "Custom idea",
        description: description || result.display_name,
        duration: `${days} day${days === 1 ? "" : "s"}`,
        overnight: days > 1 ? "Custom multi-day stop" : "Custom stop",
        baseDays: days,
        days,
        enabled: true,
        custom: true,
        source: "custom",
        priority: 20,
        tags: ["custom"],
        region: result.address?.state || result.address?.county || "Custom"
      };

      state.customStops.push(customStop);
      state.routeStops = insertStopAtLowestCost(state.routeStops, customStop);
      state.pendingGeocodeResults = [];
      $("geocodeChoices").classList.add("hidden");
      $("geocodeChoices").innerHTML = "";
      $("customPlaceForm").reset();
      $("customDays").value = "1";
      setStatus("geocodeStatus", `${customStop.name} was added at the lowest estimated mileage increase.`, "success");
      renderAll({ fitMap: true });
    }
