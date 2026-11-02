"use strict";

/* ---------------------------------------------------------------------
       Rendering summary, itinerary, and suggestions
       --------------------------------------------------------------------- */
    function renderAll({ fitMap = false } = {}) {
      if (state.routeCreated && state.plannedDriveStops.length) reconcilePlannedDriveStops(calculateRouteSummary());
      renderMap();
      renderStopBrowser();
      if (state.routeCreated) {
        $("postRouteControls").classList.remove("hidden");
        renderSummary();
        renderItinerary();
        renderSuggestions();
        populateRouteQuestionLegs();
        markRouteSearchStaleIfNeeded();
        ensureOvernightLodgingSuggestions();
        focusRouteSectionsOnce();
        if (fitMap) zoomToFullRoute();
      } else {
        $("postRouteControls").classList.add("hidden");
        populateRouteQuestionLegs();
      }
    }

    function renderStopBrowser() {
      const container = $("stopBrowserContent");
      if (!container) return;
      const allMatches = getFilteredBrowserStops();
      const limit = clamp(Number.parseInt($("stopResultLimit")?.value, 10) || 40, 10, 100);
      const visible = allMatches.slice(0, limit);
      const selectedIds = new Set(state.routeStops.map((stop) => stop.id));

      $("stopBrowserCount").innerHTML = `<span><strong>${allMatches.length}</strong> matching stops · <strong>${CANDIDATES.length}</strong> contiguous-U.S. candidates</span><span>${visible.length < allMatches.length ? `Showing first ${visible.length}` : "Showing all matches"}</span>`;

      if (!visible.length) {
        container.innerHTML = `<p class="helper">No built-in stops match these filters. Try a broader search or add a custom place.</p>`;
        return;
      }

      container.innerHTML = visible.map((stop) => {
        const selected = selectedIds.has(stop.id);
        const distance = round(haversineMiles(state.start, stop));
        let routeAction;
        if (selected) {
          routeAction = `<button class="btn-danger btn-small" type="button" data-browser-action="remove">Remove from route</button>`;
        } else if (state.routeCreated) {
          routeAction = `<button class="btn-primary btn-small" type="button" data-browser-action="add">Add to route</button>`;
        } else {
          routeAction = `<button class="btn-gold btn-small" type="button" data-browser-action="idea">Add as must-see</button>`;
        }
        return `<article class="browser-item" data-stop-id="${escapeHtml(stop.id)}">
          <div class="stop-title">${escapeHtml(stop.name)}</div>
          <div class="stop-meta">${escapeHtml(stop.region)} · ${escapeHtml(stop.category)} · about ${distance.toLocaleString()} straight-line mi from start</div>
          <div class="stop-description">${escapeHtml(stop.description)}</div>
          <div class="browser-actions">
            <button class="btn-light btn-small" type="button" data-browser-action="show">Show on map</button>
            ${routeAction}
          </div>
        </article>`;
      }).join("");
    }

    function renderSummary() {
      const preferences = getPreferences();
      const summary = calculateRouteSummary(state.routeStops, preferences);
      const warnings = [];

      summary.violatingLegs.forEach((leg) => {
        const reasons = [];
        if (leg.exceedsMiles) reasons.push(`${round(leg.dailyMiles)} mi per split day exceeds the ${round(preferences.maxMiles * (1 + preferences.lodgingWindowRatio))} mi lodging-flexibility ceiling (${preferences.maxMiles} mi target +${preferences.lodgingWindowPercent}%)`);
        if (leg.exceedsHours) reasons.push(`${round(leg.dailyHours, 1)} hr per split day exceeds ${preferences.maxHours} hr`);
        warnings.push(`${leg.from.name} to ${leg.to.name}: ${reasons.join(" and ")}.`);
      });

      if (summary.overDays > 0) warnings.push(`The estimated plan uses ${summary.overDays} more day${summary.overDays === 1 ? "" : "s"} than the selected maximum.`);
      if (summary.enabledStops.length === 0 && sameLocation(state.start, state.end)) {
        warnings.push("No included destinations remain and the start and end are the same. Add a stop or choose a different end location.");
      }

      const emphasisText = state.lastRandomEmphasis
        ? `<p class="small-note"><strong>Randomized emphasis:</strong> ${escapeHtml(labelForEmphasis(state.lastRandomEmphasis))}</p>`
        : "";

      $("summaryContent").innerHTML = `
        <div class="summary-grid">
          <div class="metric"><strong>${round(summary.totalMiles).toLocaleString()} mi</strong><span>${summary.usesRoadRouting ? "Road-route mileage" : "Estimated mileage"}</span></div>
          <div class="metric"><strong>${round(summary.totalHours, 1)} hr</strong><span>${summary.usesRoadRouting ? "Road-route driving" : "Estimated driving"}</span></div>
          <div class="metric"><strong>${summary.drivingLegs}</strong><span>Driving legs</span></div>
          <div class="metric"><strong>${summary.enRouteOvernights}</strong><span>En-route hotel nights</span></div>
          <div class="metric"><strong>${state.plannedDriveStops.length}</strong><span>Planned drive-day stops</span></div>
          <div class="metric"><strong>${summary.travelDays}</strong><span>Travel days</span></div>
          <div class="metric"><strong>${summary.fullDestinationDays}</strong><span>Full destination days</span></div>
          <div class="metric"><strong>${summary.totalDays}</strong><span>Total calendar days</span></div>
          <div class="metric"><strong>${summary.unusedDays}</strong><span>Unused days</span></div>
        </div>
        ${emphasisText}
        <p class="small-note"><strong>${summary.usesRoadRouting ? "Road-route results:" : "Planning estimates:"}</strong> ${summary.usesRoadRouting ? "The map follows the fastest drivable route from the selected start through the stops in their displayed order to the selected end, and mileage and time use that road route." : "The road route is still loading or unavailable, so mileage, time, and the dashed line use geographic planning estimates."} Planned drive-day stops are itinerary reminders near the selected road leg; they do not reserve a full destination day or force the route through the exact property. Overnight-city selection may use a ±${preferences.lodgingWindowPercent}% mileage window around the daily target to find a better lodging hub; driving-hour limits remain unchanged. This is not live navigation and does not account for current traffic, closures, weather, construction, or seasonal road access.</p>
        ${warnings.length ? `<ul class="warning-list">${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>` : `<div class="status show success">${summary.usesRoadRouting ? "The road-route results" : "The current planning estimates"} fit the selected day, mileage, and driving-hour limits.</div>`}
      `;
    }


    function renderTravelLegCards(leg, startDay, usesRoadRouting) {
      if (!leg || leg.requiredDays <= 0) return { html: "", nextDay: startDay };
      const plans = getLegOvernightPlans(leg);
      const cards = [];
      const preferences = getPreferences();
      const acceptedMileageLimit = preferences.maxMiles * (1 + preferences.lodgingWindowRatio);
      const breakpoints = [0];
      plans.forEach((plan) => {
        const alongMiles = plan.lodging?.routeMilesIntoLeg ?? plan.targetMiles;
        breakpoints.push(clamp(alongMiles, breakpoints.at(-1) + 1, leg.miles - 1));
      });
      breakpoints.push(leg.miles);

      for (let segmentIndex = 0; segmentIndex < leg.requiredDays; segmentIndex += 1) {
        const isLastSegment = segmentIndex === leg.requiredDays - 1;
        const previousPlan = plans[segmentIndex - 1];
        const nextPlan = plans[segmentIndex];
        const fromName = segmentIndex === 0
          ? leg.from.name
          : previousPlan?.lodging?.name || "prior overnight area";
        const toName = isLastSegment
          ? leg.to.name
          : nextPlan?.lodging?.name || "suggested overnight city";
        const segmentMiles = Math.max(0, breakpoints[segmentIndex + 1] - breakpoints[segmentIndex]);
        const segmentHours = leg.miles ? leg.hours * (segmentMiles / leg.miles) : 0;
        const exceedsMiles = segmentMiles > acceptedMileageLimit + 0.01;
        const exceedsHours = segmentHours > preferences.maxHours + 0.01;
        const over = exceedsMiles || exceedsHours;
        let lodgingMarkup = "";

        if (!isLastSegment) {
          if (nextPlan?.lodging) {
            const lodging = nextPlan.lodging;
            const cityLabel = lodging.selectionSource === "major-city search" ? "Suggested lodging city" : "Suggested overnight community";
            lodgingMarkup = `<div class="lodging-suggestion">
              <strong>${cityLabel}:</strong> ${escapeHtml(lodging.name)}
              <span class="lodging-caveat">${escapeHtml(lodging.selectionNote || "Selected near the route's planned break point.")} The planner allows a ±${preferences.lodgingWindowPercent}% mileage window to favor better lodging options.</span>
              <button class="btn-light btn-small" type="button" data-action="show-lodging" data-lodging-key="${escapeHtml(nextPlan.key)}">Show lodging city on map</button>
            </div>`;
          } else {
            lodgingMarkup = `<div class="lodging-suggestion pending"><strong>Suggested overnight:</strong> ${usesRoadRouting ? `Finding the best larger city within the ±${preferences.lodgingWindowPercent}% window…` : "Waiting for the road route…"}<span class="lodging-caveat">The planner prioritizes population, proximity to the road route, and closeness to the ideal daily mileage.</span></div>`;
          }
        }

        const note = isLastSegment
          ? `Arrival day. Any remaining time is partial destination time and is not counted as a full activity day.`
          : `Overnight en route; continue toward ${escapeHtml(leg.to.name)} the next day.`;
        const toleranceNote = segmentMiles > preferences.maxMiles
          ? ` · within the accepted +${preferences.lodgingWindowPercent}% lodging flexibility (${round(acceptedMileageLimit)} mi ceiling)`
          : "";
        const segmentStartMiles = breakpoints[segmentIndex];
        const segmentEndMiles = breakpoints[segmentIndex + 1];
        const plannedStops = plannedStopsForLeg(leg).filter((stop) => {
          const along = clamp(Number(stop.alongMiles) || 0, 0, leg.miles || 0);
          return along >= segmentStartMiles - 0.01 && (isLastSegment ? along <= segmentEndMiles + 0.01 : along < segmentEndMiles - 0.01);
        });
        const plannedMarkup = plannedStops.length ? `<div class="planned-drive-stops">
          <strong>Planned stops on this drive day</strong>
          ${plannedStops.map((stop) => `<div class="planned-drive-stop" data-planned-drive-stop-id="${escapeHtml(stop.id)}">
            <div class="planned-drive-stop-name">✓ ${escapeHtml(stop.name)}</div>
            <div class="planned-drive-stop-meta">${escapeHtml(stop.categoryLabel || stop.category || "Route stop")} · about ${round(stop.alongMiles)} miles into the ${escapeHtml(leg.from.name)} → ${escapeHtml(leg.to.name)} drive · approximately ${round(stop.lateralMiles, 1)} miles from the mapped road</div>
            ${stop.details ? `<div class="planned-drive-stop-meta">${escapeHtml(stop.details)}</div>` : ""}
            <div class="planned-drive-stop-actions">
              <button class="btn-light btn-small" type="button" data-action="show-planned" data-planned-stop-id="${escapeHtml(stop.id)}">Show on map</button>
              <button class="btn-danger btn-small" type="button" data-action="remove-planned" data-planned-stop-id="${escapeHtml(stop.id)}">Remove</button>
            </div>
          </div>`).join("")}
        </div>` : "";

        cards.push(`<div class="travel-day ${over ? "over" : ""}">
          <div class="travel-head">
            <span class="day-badge">Day ${startDay + segmentIndex}</span>
            <strong>Drive: ${escapeHtml(fromName)} → ${escapeHtml(toName)}</strong>
          </div>
          <div class="travel-details">Approximately ${round(segmentMiles)} miles · ${round(segmentHours, 1)} hours · ${usesRoadRouting ? "road-route result" : "planning estimate"}${toleranceNote} · ${note}</div>
          ${plannedMarkup}
          ${lodgingMarkup}
        </div>`);
      }
      return { html: cards.join(""), nextDay: startDay + leg.requiredDays };
    }

    function renderItinerary() {
      const preferences = getPreferences();
      const summary = calculateRouteSummary(state.routeStops, preferences);

      if (state.routeStops.length === 0 && (!state.routeCreated || sameLocation(state.start, state.end))) {
        $("itineraryContent").innerHTML = `<p class="helper">No stops are currently in the itinerary.</p>`;
        return;
      }

      const dayRangeLabel = (startDay, length) => length === 1
        ? `Day ${startDay}`
        : `Days ${startDay}–${startDay + length - 1}`;

      let currentDay = 1;
      const scheduleParts = [
        `<div class="schedule-key"><strong>How to read this plan:</strong> gold cards are individual driving/arrival days. Multi-day transfers include a city-prioritized overnight stop and a crescent-moon marker on the map. White destination cards are complete days available for meals, hikes, tours, and activities. A short drive may leave partial arrival time, but that time is not counted as a full destination day.</div>`
      ];

      summary.enabledStops.forEach((stop, enabledIndex) => {
        const inboundLeg = summary.legs[enabledIndex];
        if (inboundLeg && inboundLeg.requiredDays > 0) {
          const travelCards = renderTravelLegCards(inboundLeg, currentDay, summary.usesRoadRouting);
          scheduleParts.push(travelCards.html);
          currentDay = travelCards.nextDay;
        }

        const fullDays = fullDaysForStop(stop);
        const fullDayLabel = fullDays === 0 ? `Arrival Day ${Math.max(1, currentDay - 1)}` : dayRangeLabel(currentDay, fullDays);
        scheduleParts.push(`
          <article class="itinerary-stop" data-stop-id="${escapeHtml(stop.id)}">
            <div class="stop-head">
              <div>
                <div class="stop-title">${escapeHtml(stop.name)}${stop.requiredMustSee ? `<span class="required-badge">Required must-see</span>` : ""}</div>
                <div class="stop-meta">${escapeHtml(fullDayLabel)} · ${fullDays === 0 ? "Pass-through stop · no full destination days" : `${fullDays} full day${fullDays === 1 ? "" : "s"}`} · ${escapeHtml(stop.category)}</div>
              </div>
              <label class="include-control"><input type="checkbox" data-action="toggle" checked ${stop.requiredMustSee ? "disabled" : ""}> ${stop.requiredMustSee ? "Required" : "Include"}</label>
            </div>
            <p class="stop-description">${escapeHtml(stop.description)}</p>
            <div class="leg-note"><strong>${fullDays === 0 ? "Pass-through timing:" : "Full destination time:"}</strong> ${fullDays === 0 ? "this stop is included in the route but does not reserve a complete activity day." : "these days begin after the inbound travel day and are reserved for activities at this location."}</div>
            <div class="stop-controls">
              <label class="day-control">Full days <input type="number" min="0" max="10" step="1" value="${fullDays}" data-action="days"></label>
              <button class="btn-light btn-small" type="button" data-action="show">Show on map</button>
              <button class="btn-danger btn-small" type="button" data-action="remove">${stop.requiredMustSee ? "Remove must-see" : "Remove"}</button>
            </div>
          </article>`);
        currentDay += fullDays;
      });

      const finalLeg = summary.legs.at(-1);
      if (finalLeg && finalLeg.requiredDays > 0) {
        const travelCards = renderTravelLegCards(finalLeg, currentDay, summary.usesRoadRouting);
        scheduleParts.push(travelCards.html);
        currentDay = travelCards.nextDay;
      }

      const excludedStops = state.routeStops.filter((stop) => stop.enabled === false);
      if (excludedStops.length) {
        scheduleParts.push(`<h3 class="excluded-heading">Excluded stops</h3>`);
        excludedStops.forEach((stop) => {
          const fullDays = fullDaysForStop(stop);
          scheduleParts.push(`
            <article class="itinerary-stop disabled-stop" data-stop-id="${escapeHtml(stop.id)}">
              <div class="stop-head">
                <div>
                  <div class="stop-title">${escapeHtml(stop.name)}${stop.requiredMustSee ? `<span class="required-badge">Required must-see</span>` : ""}</div>
                  <div class="stop-meta">Excluded from route calculations · ${escapeHtml(stop.category)}</div>
                </div>
                <label class="include-control"><input type="checkbox" data-action="toggle"> Include</label>
              </div>
              <p class="stop-description">${escapeHtml(stop.description)}</p>
              <div class="stop-controls">
                <label class="day-control">Full days <input type="number" min="0" max="10" step="1" value="${fullDays}" data-action="days"></label>
                <button class="btn-light btn-small" type="button" data-action="show">Show on map</button>
                <button class="btn-danger btn-small" type="button" data-action="remove">Remove</button>
              </div>
            </article>`);
        });
      }

      $("itineraryContent").innerHTML = scheduleParts.join("");
    }

    function renderSuggestions() {
      const preferences = getPreferences();
      const selectedIds = new Set(state.routeStops.map((stop) => stop.id));
      const all = [...CANDIDATES, ...state.customStops];
      const ranked = all
        .map((stop) => ({ stop, selected: selectedIds.has(stop.id), score: scoreCandidate(stop, preferences, false, state.lastRandomEmphasis || preferences.emphasis) }))
        .filter((item) => item.score > -1000)
        .sort((a, b) => {
          if (a.selected !== b.selected) return a.selected ? -1 : 1;
          return b.score - a.score;
        })
        .slice(0, 14);

      if (!ranked.length) {
        $("suggestionsContent").innerHTML = `<p class="helper">No suggestions match the current exclusions.</p>`;
        return;
      }

      $("suggestionsContent").innerHTML = ranked.map(({ stop, selected }) => `
        <article class="suggestion-item" data-stop-id="${escapeHtml(stop.id)}">
          <div class="stop-title">${escapeHtml(stop.name)}</div>
          <div class="stop-meta">${escapeHtml(stop.category)} · ${escapeHtml(stop.duration || `${stop.days || 1} day`)}</div>
          <div class="stop-description">${escapeHtml(stop.description)}</div>
          <div class="suggestion-actions">
            <button class="btn-light btn-small" type="button" data-action="show">Show on map</button>
            ${selected
              ? `<button class="btn-danger btn-small" type="button" data-action="remove">Remove from route</button>`
              : `<button class="btn-primary btn-small" type="button" data-action="add">Add to route</button>`}
          </div>
        </article>`).join("");
    }

    function labelForEmphasis(value) {
      return {
        balanced: "Balanced",
        history: "History",
        parks: "National parks and scenery",
        fewerHotels: "Fewer hotel changes"
      }[value] || value;
    }
