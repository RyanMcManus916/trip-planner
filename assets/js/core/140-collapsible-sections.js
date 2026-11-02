"use strict";

/* ---------------------------------------------------------------------
       Collapsible section and map-focus controls
       --------------------------------------------------------------------- */
    function setSectionCollapsed(sectionId, collapsed) {
      const card = document.querySelector(`.collapsible-card[data-section-id="${sectionId}"]`);
      if (!card) return;
      const body = card.querySelector('.collapsible-body');
      const toggle = card.querySelector('.section-toggle');
      const label = toggle?.querySelector('.toggle-label');
      const chevron = toggle?.querySelector('.toggle-chevron');

      card.classList.toggle('is-collapsed', collapsed);
      if (body) body.hidden = collapsed;
      if (toggle) toggle.setAttribute('aria-expanded', String(!collapsed));
      if (label) label.textContent = collapsed ? 'Show' : 'Hide';
      if (chevron) chevron.textContent = collapsed ? '▾' : '▴';
    }

    function setManySections(openSectionIds) {
      const openIds = new Set(openSectionIds);
      document.querySelectorAll('.collapsible-card[data-section-id]').forEach((card) => {
        setSectionCollapsed(card.dataset.sectionId, !openIds.has(card.dataset.sectionId));
      });
    }

    function openEssentialSections() {
      if (state.routeCreated) {
        setManySections(['route', 'route-assistant', 'summary', 'itinerary']);
      } else {
        setManySections(['browse', 'trip']);
      }
    }

    function expandAllSections() {
      document.querySelectorAll('.collapsible-card[data-section-id]').forEach((card) => {
        setSectionCollapsed(card.dataset.sectionId, false);
      });
    }

    function collapseAllSections() {
      document.querySelectorAll('.collapsible-card[data-section-id]').forEach((card) => {
        setSectionCollapsed(card.dataset.sectionId, true);
      });
    }

    function applyInitialSectionLayout() {
      document.querySelectorAll('.collapsible-card[data-section-id]').forEach((card) => {
        setSectionCollapsed(card.dataset.sectionId, card.dataset.defaultOpen !== 'true');
      });
    }

    function focusRouteSectionsOnce() {
      if (state.sectionLayoutFocused) return;
      setManySections(['route', 'route-assistant', 'summary', 'itinerary']);
      state.sectionLayoutFocused = true;
    }

    function togglePlannerPanel() {
      const shell = document.querySelector('.app-shell');
      const button = $('togglePlannerBtn');
      const collapsed = !shell.classList.contains('panel-collapsed');
      shell.classList.toggle('panel-collapsed', collapsed);
      button.setAttribute('aria-pressed', String(collapsed));
      button.textContent = collapsed ? 'Show planner' : 'Map focus';
      if (state.map) window.setTimeout(() => state.map.invalidateSize(), 0);
    }

    function initializeSectionControls() {
      applyInitialSectionLayout();
      document.querySelectorAll('.section-toggle').forEach((button) => {
        button.addEventListener('click', () => {
          const card = button.closest('.collapsible-card');
          if (!card) return;
          setSectionCollapsed(card.dataset.sectionId, !card.classList.contains('is-collapsed'));
        });
      });
      $('openEssentialsBtn').addEventListener('click', openEssentialSections);
      $('expandAllSectionsBtn').addEventListener('click', expandAllSections);
      $('collapseAllSectionsBtn').addEventListener('click', collapseAllSections);
      $('togglePlannerBtn').addEventListener('click', togglePlannerPanel);
    }


    function attachEventListeners() {
      $("createIdeasBtn").addEventListener("click", createRouteFromIdeas);
      $("randomTripBtn").addEventListener("click", createRandomRoute);
      $("rebuildBtn").addEventListener("click", rebuildRoute);
      $("resetBtn").addEventListener("click", resetRoute);
      $("setStartBtn").addEventListener("click", setStartLocation);
      $("setEndBtn").addEventListener("click", setEndLocation);
      $("copyStartToEndBtn").addEventListener("click", copyStartToEnd);
      $("zoomRouteBtn").addEventListener("click", zoomToFullRoute);
      $("mapRetryRoadBtn").addEventListener("click", () => {
        const routeKey = buildRouteKey(getRoutePoints());
        state.roadRouteCache.delete(routeKey);
        state.roadRouteFailureUntil?.delete(routeKey);
        $("mapRetryRoadBtn").hidden = true;
        scheduleRoadRoute(getRoutePoints());
      });
      $("zoomUsStopsBtn").addEventListener("click", zoomToUsStopOverview);
      $("zoomFilteredStopsBtn").addEventListener("click", zoomToFilteredStops);
      $("clearStopFiltersBtn").addEventListener("click", clearStopBrowserFilters);
      $("stopBrowserContent").addEventListener("click", handleStopBrowserClick);
      ["stopRegion", "stopCategory", "stopSort", "stopResultLimit"].forEach((id) => {
        $(id).addEventListener("change", renderStopBrowser);
      });
      $("stopSearch").addEventListener("input", renderStopBrowser);
      $("customPlaceForm").addEventListener("submit", submitCustomPlace);
      $("itineraryContent").addEventListener("click", handleItineraryClick);
      $("itineraryContent").addEventListener("change", handleItineraryChange);
      $("suggestionsContent").addEventListener("click", handleSuggestionClick);
      $("askRouteBtn").addEventListener("click", () => searchAlongRoute());
      $("clearRouteSearchBtn").addEventListener("click", () => clearRouteSearchResults());
      $("routeQuestionResults").addEventListener("click", handleRouteSearchResultClick);
      $("routeQuestionLeg").addEventListener("change", () => {
        state.routeSearchLegSignature = $("routeQuestionLeg").selectedOptions[0]?.dataset.signature || "";
      });
      $("routeSearchLimit").addEventListener("change", renderRouteSearchResults);
      document.querySelectorAll("[data-route-quick]").forEach((button) => {
        button.addEventListener("click", () => searchAlongRoute(button.dataset.routeQuick));
      });
      $("routeQuestion").addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          searchAlongRoute();
        }
      });

      ["tripDays", "maxMiles", "maxHours", "pace", "emphasis"].forEach((id) => {
        $(id).addEventListener("change", () => {
          getPreferences();
          if (state.routeCreated) renderAll({ fitMap: false });
        });
      });

      $("lodgingWindowPercent").addEventListener("change", () => {
        const preferences = getPreferences();
        state.overnightLodgingCache.clear();
        state.overnightLookupPending.clear();
        if (state.routeCreated) {
          setStatus("plannerStatus", `Overnight stop mileage flexibility set to ±${preferences.lodgingWindowPercent}%. Lodging cities are being recalculated.`, "info");
          renderAll({ fitMap: false });
        }
      });

      $("startLocation").addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          setStartLocation();
        }
      });
      $("endLocation").addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          setEndLocation();
        }
      });
    }

    document.addEventListener("DOMContentLoaded", () => {
      populateStopBrowserRegions();
      initializeSectionControls();
      initializePlannerResizer();
      attachEventListeners();
      initializeMap();
      renderStopBrowser();
    });
