"use strict";

/* ---------------------------------------------------------------------
       Route editing and state management
       --------------------------------------------------------------------- */
    function findStopById(stopId) {
      return state.routeStops.find((stop) => stop.id === stopId)
        || state.customStops.find((stop) => stop.id === stopId)
        || CANDIDATES.find((stop) => stop.id === stopId)
        || null;
    }

    function addCandidateToIdeas(stopId) {
      const stop = CANDIDATES.find((item) => item.id === stopId);
      if (!stop) return;
      const current = $("mustSee").value.trim();
      const names = current ? current.split(/[,\n]/).map((name) => name.trim().toLowerCase()) : [];
      if (!names.includes(stop.name.toLowerCase())) {
        $("mustSee").value = current ? `${current}, ${stop.name}` : stop.name;
      }
      setStatus("plannerStatus", `${stop.name} was added to your must-see ideas.`, "success");
    }

    function removeMustSeeEntriesForStop(stop) {
      const entries = parseMustSeeEntries($("mustSee").value);
      const exactQueries = new Set((stop.mustSeeQueries || [stop.mustSeeQuery])
        .filter(Boolean)
        .map(normalizePlaceText));
      const kept = entries.filter((entry) => {
        if (exactQueries.size) return !exactQueries.has(normalizePlaceText(entry));
        return !mustSeeEntryMatchesStop(entry, stop);
      });
      $("mustSee").value = kept.join(", ");
      if (stop.autoMustSee) {
        state.customStops = state.customStops.filter((item) => item.id !== stop.id);
      }
    }

    function addStopToRoute(stopId) {
      const base = findStopById(stopId);
      if (!base || state.routeStops.some((stop) => stop.id === stopId)) return;
      const preferences = getPreferences();
      const stop = { ...base, days: base.days || defaultDaysForStop(base, preferences, preferences.emphasis), enabled: true, source: base.custom ? "custom" : "suggested" };
      state.routeStops = insertStopAtLowestCost(state.routeStops, stop);
      state.routeCreated = true;
      renderAll({ fitMap: true });
      setStatus("plannerStatus", `${stop.name} was added at the lowest estimated mileage increase.`, "success");
    }

    function removeStopFromRoute(stopId) {
      const stop = state.routeStops.find((item) => item.id === stopId);
      if (!stop) return;
      if (stop.requiredMustSee) removeMustSeeEntriesForStop(stop);
      state.routeStops = state.routeStops.filter((item) => item.id !== stopId);
      if (stop.custom) state.customStops = state.customStops.filter((item) => item.id !== stopId);
      renderAll({ fitMap: false });
      setStatus(
        "plannerStatus",
        stop.requiredMustSee
          ? `${stop.name} was removed from both the required must-see list and the route.`
          : `${stop.name} was removed and the route was recalculated.`,
        "info"
      );
    }

    function toggleStop(stopId, enabled) {
      const stop = state.routeStops.find((item) => item.id === stopId);
      if (!stop) return;
      if (stop.requiredMustSee && !enabled) {
        setStatus("plannerStatus", `${stop.name} is required because it is in the must-see field. Remove it from the must-see list to exclude it.`, "warning");
        renderItinerary();
        return;
      }
      stop.enabled = enabled;
      renderAll({ fitMap: false });
    }

    function updateStopDays(stopId, days) {
      const stop = state.routeStops.find((item) => item.id === stopId);
      if (!stop) return;
      stop.days = clamp(Number.isFinite(Number.parseInt(days, 10)) ? Number.parseInt(days, 10) : 1, 0, 10);
      if (stop.days === 0) stop.visitStyle = "passThrough";
      else if (stop.visitStyle === "passThrough") stop.visitStyle = "destination";
      renderAll({ fitMap: false });
    }

    function setRouteButtonsDisabled(disabled) {
      ["createIdeasBtn", "randomTripBtn", "rebuildBtn"].forEach((id) => {
        const button = $(id);
        if (button) button.disabled = disabled;
      });
    }

    async function prepareMustSeesOrReport(preferences) {
      const entries = parseMustSeeEntries(preferences.mustSee);
      if (!entries.length) return { requiredStops: [], satisfiedByStart: [], satisfiedByEnd: [] };

      const resolution = await resolveRequiredMustSeeStops(preferences);
      if (resolution.outsideAmericas?.length) {
        setStatus(
          "plannerStatus",
          `The route was not created because these required must-see locations are outside North or South America: ${resolution.outsideAmericas.join(", ")}. Remove or replace them with destinations in the Americas.`,
          "error"
        );
        return null;
      }
      if (resolution.unresolved.length) {
        setStatus(
          "plannerStatus",
          `The route was not created because these required must-see locations could not be found: ${resolution.unresolved.join(", ")}. Add a city/state or correct the spelling, then try again.`,
          "error"
        );
        return null;
      }
      return resolution;
    }

    async function createRouteFromIdeas() {
      const preferences = getPreferences();
      const hasIdeas = [preferences.mustSee, preferences.history, preferences.scenery, preferences.exclusions, preferences.notes].some(Boolean);
      if (!hasIdeas) {
        setStatus("plannerStatus", "Enter at least one idea, interest, exclusion, or planning note—or use Random trip from parameters.", "warning");
        return;
      }

      setRouteButtonsDisabled(true);
      try {
        const endpointsReady = await prepareEndpointsOrReport();
        if (!endpointsReady) return;
        const mustSeeResolution = await prepareMustSeesOrReport(preferences);
        if (!mustSeeResolution) return;
        const result = buildRoute(preferences, {
          randomize: false,
          preserveCustom: true,
          requiredStops: mustSeeResolution.requiredStops
        });
        state.routeStops = result.stops;
        state.routeCreated = true;
        state.lastBuildMode = "ideas";
        state.lastRandomEmphasis = null;
        renderAll({ fitMap: true });
        const requiredCount = mustSeeResolution.requiredStops.length
          + mustSeeResolution.satisfiedByStart.length
          + mustSeeResolution.satisfiedByEnd.length;
        const prefix = requiredCount
          ? `${requiredCount} required must-see location${requiredCount === 1 ? " is" : "s are"} included. `
          : "";
        setStatus("plannerStatus", `${prefix}${buildOutcomeMessage(result.stops, preferences)}`, tripHasMovement() ? "success" : "warning");
      } finally {
        setRouteButtonsDisabled(false);
        state.resolvingMustSees = false;
      }
    }

    async function createRandomRoute() {
      const preferences = getPreferences();
      setRouteButtonsDisabled(true);
      try {
        const endpointsReady = await prepareEndpointsOrReport();
        if (!endpointsReady) return;
        const mustSeeResolution = await prepareMustSeesOrReport(preferences);
        if (!mustSeeResolution) return;
        const result = buildRoute(preferences, {
          randomize: true,
          preserveCustom: true,
          requiredStops: mustSeeResolution.requiredStops
        });
        state.routeStops = result.stops;
        state.routeCreated = true;
        state.lastBuildMode = "random";
        renderAll({ fitMap: true });
        const requiredCount = mustSeeResolution.requiredStops.length
          + mustSeeResolution.satisfiedByStart.length
          + mustSeeResolution.satisfiedByEnd.length;
        const requiredText = requiredCount
          ? ` All ${requiredCount} required must-see location${requiredCount === 1 ? " was" : "s were"} retained or satisfied by an endpoint.`
          : "";
        setStatus("plannerStatus", `Random route created with a ${labelForEmphasis(result.emphasis).toLowerCase()} emphasis.${requiredText} Press again for a different result.`, "success");
      } finally {
        setRouteButtonsDisabled(false);
        state.resolvingMustSees = false;
      }
    }

    async function rebuildRoute() {
      const preferences = getPreferences();
      setRouteButtonsDisabled(true);
      try {
        const endpointsReady = await prepareEndpointsOrReport();
        if (!endpointsReady) return;
        const mustSeeResolution = await prepareMustSeesOrReport(preferences);
        if (!mustSeeResolution) return;
        const result = buildRoute(preferences, {
          randomize: state.lastBuildMode === "random",
          preserveCustom: true,
          requiredStops: mustSeeResolution.requiredStops
        });
        state.routeStops = result.stops;
        state.routeCreated = true;
        renderAll({ fitMap: true });
        const requiredCount = mustSeeResolution.requiredStops.length
          + mustSeeResolution.satisfiedByStart.length
          + mustSeeResolution.satisfiedByEnd.length;
        const prefix = requiredCount
          ? `${requiredCount} required must-see location${requiredCount === 1 ? " remains" : "s remain"} in the route. `
          : "";
        setStatus("plannerStatus", `${prefix}${buildOutcomeMessage(result.stops, preferences)}`, tripHasMovement() ? "success" : "warning");
      } finally {
        setRouteButtonsDisabled(false);
        state.resolvingMustSees = false;
      }
    }

    function buildOutcomeMessage(stops, preferences) {
      if (!stops.length && sameLocation(state.start, state.end)) return "No practical route could be built from the current constraints and exclusions. Increase days or driving limits, choose a different end, or remove an exclusion.";
      if (!stops.length) return "A direct start-to-end route was created without intermediate destination days. Add a suggested or custom stop if desired.";
      const summary = calculateRouteSummary(stops, preferences);
      if (summary.violatingLegs.length || summary.overDays) {
        return "A best-fit route was created and all required must-see stops were retained, but not every day or driving constraint can be satisfied. Review the warnings in the trip summary.";
      }
      return "Route created. Travel days and full destination days are shown separately. You can edit full days, exclude stops, add suggestions, or add a custom place.";
    }

    function resetRoute() {
      cancelRoadRouteRequest();
      state.routeStops = [];
      state.customStops = [];
      state.plannedDriveStops = [];
      state.routeCreated = false;
      state.lastRandomEmphasis = null;
      state.sectionLayoutFocused = false;
      state.pendingGeocodeResults = [];
      clearRouteSearchResults({ silent: true });
      clearStatus("routeQuestionStatus");
      clearStatus("geocodeStatus");
      $("geocodeChoices").classList.add("hidden");
      $("geocodeChoices").innerHTML = "";
      renderAll();
      setManySections(['browse', 'trip']);
      if (state.map) state.map.setView([state.start.lat, state.start.lng], 6);
      setStatus("plannerStatus", "Route cleared. The selected start and end remain in place, and candidate stops remain available on the map.", "info");
    }
