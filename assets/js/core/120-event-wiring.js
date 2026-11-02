"use strict";

/* ---------------------------------------------------------------------
       Event wiring
       --------------------------------------------------------------------- */
    function handleItineraryClick(event) {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      if (button.dataset.action === "show-lodging") {
        showLodgingOnMap(button.dataset.lodgingKey);
        return;
      }
      if (button.dataset.action === "show-planned") {
        showPlannedDriveStop(button.dataset.plannedStopId);
        return;
      }
      if (button.dataset.action === "remove-planned") {
        removePlannedDriveStop(button.dataset.plannedStopId);
        return;
      }
      const card = button.closest("[data-stop-id]");
      if (!card) return;
      const stopId = card.dataset.stopId;
      if (button.dataset.action === "show") showStopOnMap(stopId);
      if (button.dataset.action === "remove") removeStopFromRoute(stopId);
    }

    function handleItineraryChange(event) {
      const control = event.target.closest("[data-action]");
      if (!control) return;
      const card = control.closest("[data-stop-id]");
      if (!card) return;
      const stopId = card.dataset.stopId;
      if (control.dataset.action === "toggle") toggleStop(stopId, control.checked);
      if (control.dataset.action === "days") updateStopDays(stopId, control.value);
    }

    function handleSuggestionClick(event) {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      const card = button.closest("[data-stop-id]");
      if (!card) return;
      const stopId = card.dataset.stopId;
      if (button.dataset.action === "show") showStopOnMap(stopId);
      if (button.dataset.action === "add") addStopToRoute(stopId);
      if (button.dataset.action === "remove") removeStopFromRoute(stopId);
    }

    function handleStopBrowserClick(event) {
      const button = event.target.closest("button[data-browser-action]");
      if (!button) return;
      const card = button.closest("[data-stop-id]");
      if (!card) return;
      const stopId = card.dataset.stopId;
      const action = button.dataset.browserAction;
      if (action === "show") showStopOnMap(stopId);
      if (action === "add") addStopToRoute(stopId);
      if (action === "remove") removeStopFromRoute(stopId);
      if (action === "idea") addCandidateToIdeas(stopId);
    }
