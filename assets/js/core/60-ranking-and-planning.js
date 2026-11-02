"use strict";

/* ---------------------------------------------------------------------
       Candidate ranking and automatic planning
       --------------------------------------------------------------------- */
    function scoreCandidate(stop, preferences, randomize = false, forcedEmphasis = null) {
      const emphasis = forcedEmphasis || preferences.emphasis;
      const mustTerms = tokenize(preferences.mustSee);
      const historyTerms = tokenize(preferences.history);
      const sceneryTerms = tokenize(preferences.scenery);
      const noteTerms = tokenize(preferences.notes);
      const excludeTerms = tokenize(preferences.exclusions);
      const text = searchableText(stop);

      if (matchesAny(stop, excludeTerms)) return -10000;

      let score = stop.priority || 5;
      if (mustTerms.some((term) => text.includes(term))) score += 28;
      if (historyTerms.some((term) => text.includes(term))) score += 12;
      if (sceneryTerms.some((term) => text.includes(term))) score += 12;
      if (noteTerms.some((term) => text.includes(term))) score += 5;

      if (emphasis === "history") {
        if (/historic|history|mission|fort|museum|mining|gold rush|civil rights/.test(text)) score += 14;
        if (stop.majorPark) score -= 1;
      } else if (emphasis === "parks") {
        if (/national park|state park|national monument|national seashore|scenic/.test(text)) score += 14;
        if (stop.majorPark) score += 6;
      } else if (emphasis === "fewerHotels") {
        if (/best as overnight|multi-night|overnight base/.test(`${stop.overnight} ${stop.description}`.toLowerCase())) score += 8;
        if (stop.baseDays >= 2) score += 5;
      } else {
        if (stop.majorPark) score += 4;
        if (/historic|history/.test(text)) score += 3;
      }

      const directEndpointMiles = estimateLeg(state.start, state.end).miles;
      const endpointDetourMiles = Math.max(0,
        estimateLeg(state.start, stop).miles
        + estimateLeg(stop, state.end).miles
        - directEndpointMiles);
      const practicalDetour = preferences.maxMiles * Math.max(1.5, preferences.tripDays * 0.28);
      if (endpointDetourMiles > practicalDetour) score -= (endpointDetourMiles - practicalDetour) / 42;

      if (preferences.pace === "relaxed" && stop.baseDays >= 2) score += 5;
      if (preferences.pace === "fast" && stop.duration.toLowerCase().includes("hour")) score += 4;

      if (randomize) score += Math.random() * 18 - 5;
      return score;
    }

    function defaultDaysForStop(stop, preferences, emphasis) {
      let days = clamp(stop.baseDays || 1, 1, 3);
      if (preferences.pace === "fast") days = 1;
      if (preferences.pace === "relaxed" && stop.majorPark) days = Math.max(days, 2);
      if (emphasis === "parks" && stop.majorPark) days = Math.max(days, 2);
      if (emphasis === "fewerHotels" && /overnight|base|multi-night/i.test(stop.overnight || "")) days = Math.max(days, 2);
      return clamp(days, 1, 3);
    }

    function candidateIsMandatory(stop, preferences) {
      const mustTerms = parseMustSeeEntries(preferences.mustSee).map(normalizePlaceText);
      const haystack = normalizePlaceText(searchableText(stop));
      return mustTerms.length > 0 && mustTerms.some((term) => haystack.includes(term));
    }

    function findBestCandidateForMustSee(entry) {
      const needle = normalizePlaceText(entry);
      if (!needle) return null;

      const scored = CANDIDATES.map((stop) => {
        const name = normalizePlaceText(stop.name);
        const region = normalizePlaceText(stop.region);
        const allText = normalizePlaceText(searchableText(stop));
        let matchScore = null;
        if (name === needle) matchScore = 1000;
        else if (name.startsWith(needle) || needle.startsWith(name)) matchScore = 850;
        else if (name.includes(needle)) matchScore = 750;
        else if (region === needle) matchScore = 650;
        else if (region.includes(needle)) matchScore = 550;
        else if (allText.includes(needle)) matchScore = 450;
        return { stop, matchScore: matchScore === null ? null : matchScore + (stop.priority || 0) };
      }).filter((item) => item.matchScore !== null);

      scored.sort((a, b) => b.matchScore - a.matchScore);
      return scored[0]?.stop || null;
    }

    function mustSeeEntryMatchesStop(entry, stop) {
      const needle = normalizePlaceText(entry);
      if (!needle || !stop) return false;
      return normalizePlaceText(stop.name).includes(needle)
        || normalizePlaceText(stop.description).includes(needle)
        || normalizePlaceText(stop.region).includes(needle)
        || normalizePlaceText(stop.mustSeeQuery || "") === needle
        || (stop.mustSeeQueries || []).some((query) => normalizePlaceText(query) === needle);
    }

    async function resolveRequiredMustSeeStops(preferences) {
      const entries = parseMustSeeEntries(preferences.mustSee);
      if (!entries.length) return { requiredStops: [], unresolved: [], outsideAmericas: [], satisfiedByStart: [], satisfiedByEnd: [] };

      state.resolvingMustSees = true;
      const requiredById = new Map();
      const unresolved = [];
      const outsideAmericas = [];
      const satisfiedByStart = [];
      const satisfiedByEnd = [];

      // Remove stale auto-geocoded must-sees that are no longer in the field.
      state.customStops = state.customStops.filter((stop) => {
        if (!stop.autoMustSee) return true;
        return entries.some((entry) => mustSeeEntryMatchesStop(entry, stop));
      });

      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        setStatus("plannerStatus", `Resolving required must-see ${index + 1} of ${entries.length}: ${entry}…`, "info");

        const endpointNeedle = normalizePlaceText(entry);
        if (normalizePlaceText(state.start.name).includes(endpointNeedle)) {
          satisfiedByStart.push(entry);
          continue;
        }
        if (normalizePlaceText(state.end.name).includes(endpointNeedle)) {
          satisfiedByEnd.push(entry);
          continue;
        }

        const existingCustom = state.customStops.find((stop) => mustSeeEntryMatchesStop(entry, stop));
        if (existingCustom) {
          const prepared = {
            ...existingCustom,
            requiredMustSee: true,
            mustSeeQueries: [...new Set([...(existingCustom.mustSeeQueries || []), entry])],
            enabled: true,
            priority: 1000
          };
          requiredById.set(prepared.id, prepared);
          continue;
        }

        const candidate = findBestCandidateForMustSee(entry);
        if (candidate) {
          const prior = requiredById.get(candidate.id);
          requiredById.set(candidate.id, {
            ...candidate,
            requiredMustSee: true,
            mustSeeQueries: [...new Set([...(prior?.mustSeeQueries || []), entry])],
            enabled: true,
            priority: 1000
          });
          continue;
        }

        try {
          const results = await geocodePlace(entry, 5);
          if (!results.length) {
            unresolved.push(entry);
            continue;
          }
          const result = results[0];
          const id = `must-see-${result.place_id}`;
          const existing = state.customStops.find((stop) => stop.id === id);
          const displayName = result.namedetails?.name || result.name || entry;
          const requiredStop = {
            ...(existing || {}),
            id,
            name: displayName,
            lat: Number.parseFloat(result.lat),
            lng: Number.parseFloat(result.lon),
            category: "Required must-see",
            description: `Required location entered as “${entry}”. OpenStreetMap match: ${result.display_name}`,
            duration: existing?.duration || "1 full day",
            overnight: existing?.overnight || "Required itinerary stop",
            baseDays: existing?.baseDays || 1,
            days: existing?.days || 1,
            enabled: true,
            custom: true,
            autoMustSee: true,
            requiredMustSee: true,
            source: "must-see",
            priority: 1000,
            tags: ["must-see", "required"],
            region: result.address?.state || result.address?.county || result.address?.country || "Geocoded location",
            mustSeeQuery: entry,
            mustSeeQueries: [...new Set([...(existing?.mustSeeQueries || []), entry])],
            geocodeDisplayName: result.display_name
          };
          const customIndex = state.customStops.findIndex((stop) => stop.id === id);
          if (customIndex >= 0) state.customStops[customIndex] = requiredStop;
          else state.customStops.push(requiredStop);
          requiredById.set(id, requiredStop);
        } catch (error) {
          if (error?.code === "OUTSIDE_AMERICAS") outsideAmericas.push(entry);
          else unresolved.push(entry);
        }
      }

      state.resolvingMustSees = false;
      return { requiredStops: [...requiredById.values()], unresolved, outsideAmericas, satisfiedByStart, satisfiedByEnd };
    }

    function targetStopCount(preferences, emphasis) {
      let divisor = preferences.pace === "fast" ? 1.25 : preferences.pace === "relaxed" ? 2.2 : 1.65;
      if (emphasis === "fewerHotels") divisor = Math.max(divisor, 2.4);
      return clamp(Math.floor((preferences.tripDays - 1) / divisor), 2, 8);
    }

    function routeFitsReasonably(stops, preferences, allowViolations = false) {
      const summary = calculateRouteSummary(stops, preferences);
      const totalMileageBudget = preferences.maxMiles * preferences.tripDays;
      const distanceOkay = summary.totalMiles <= totalMileageBudget * 1.03;
      const daysOkay = summary.totalDays <= preferences.tripDays;
      const legsOkay = summary.violatingLegs.length === 0;
      return distanceOkay && daysOkay && (allowViolations || legsOkay);
    }

    function trimAndAllocate(stops, preferences, scoreMap, mandatoryIds, emphasis) {
      let working = stops.map((stop) => ({ ...stop }));

      // First reduce multi-day stays before removing destinations.
      let summary = calculateRouteSummary(working, preferences);
      while (summary.totalDays > preferences.tripDays) {
        const reducible = [...working]
          .filter((stop) => stop.enabled !== false && stop.days > 1)
          .sort((a, b) => (scoreMap.get(a.id) || 0) - (scoreMap.get(b.id) || 0));
        if (reducible.length === 0) break;
        reducible[0].days -= 1;
        summary = calculateRouteSummary(working, preferences);
      }

      // Then remove the lowest-priority non-mandatory destination if needed.
      while (summary.totalDays > preferences.tripDays && working.length > 1) {
        const removable = working
          .filter((stop) => !mandatoryIds.has(stop.id) && !stop.custom)
          .sort((a, b) => (scoreMap.get(a.id) || 0) - (scoreMap.get(b.id) || 0));
        if (removable.length === 0) break;
        working = working.filter((stop) => stop.id !== removable[0].id);
        summary = calculateRouteSummary(working, preferences);
      }

      // Use spare days on high-priority major destinations when appropriate.
      summary = calculateRouteSummary(working, preferences);
      const addable = [...working]
        .filter((stop) => stop.enabled !== false)
        .sort((a, b) => {
          const parkBonusA = a.majorPark ? 10 : 0;
          const parkBonusB = b.majorPark ? 10 : 0;
          return ((scoreMap.get(b.id) || 0) + parkBonusB) - ((scoreMap.get(a.id) || 0) + parkBonusA);
        });

      while (summary.unusedDays > 0 && addable.length > 0) {
        const preferred = addable.find((stop) => {
          if (preferences.pace === "relaxed") return stop.days < 3 && (stop.majorPark || stop.baseDays >= 2);
          if (emphasis === "fewerHotels") return stop.days < 3 && /overnight|base|multi-night/i.test(stop.overnight || "");
          if (emphasis === "parks") return stop.days < 3 && stop.majorPark;
          return stop.days < 2 && stop.majorPark;
        });
        if (!preferred) break;
        preferred.days += 1;
        summary = calculateRouteSummary(working, preferences);
      }

      return working;
    }

    function buildRoute(preferences, options = {}) {
      const randomize = Boolean(options.randomize);
      const preserveCustom = Boolean(options.preserveCustom);
      const requiredStops = Array.isArray(options.requiredStops) ? options.requiredStops : [];
      const availableEmphases = ["balanced", "history", "parks", "fewerHotels"];
      const emphasis = randomize
        ? availableEmphases[Math.floor(Math.random() * availableEmphases.length)]
        : preferences.emphasis;

      state.lastRandomEmphasis = randomize ? emphasis : null;

      const exclusions = tokenize(preferences.exclusions);
      const requiredIds = new Set(requiredStops.map((stop) => stop.id));
      const customMandatory = preserveCustom
        ? state.customStops
            .filter((stop) => !stop.autoMustSee || requiredIds.has(stop.id))
            .map((stop) => ({ ...stop, enabled: true }))
        : [];
      const ranked = CANDIDATES
        .filter((stop) => !matchesAny(stop, exclusions))
        .map((stop) => ({ stop, score: scoreCandidate(stop, preferences, randomize, emphasis) }))
        .filter((item) => item.score > -1000)
        .sort((a, b) => b.score - a.score);

      const scoreMap = new Map(ranked.map((item) => [item.stop.id, item.score]));
      customMandatory.forEach((stop) => scoreMap.set(stop.id, 1000));

      const mandatoryMap = new Map();
      requiredStops.forEach((stop) => {
        const prior = mandatoryMap.get(stop.id);
        mandatoryMap.set(stop.id, {
          ...(prior || {}),
          ...stop,
          requiredMustSee: true,
          mustSeeQueries: [...new Set([...(prior?.mustSeeQueries || []), ...(stop.mustSeeQueries || [])])]
        });
      });
      const mandatory = [...mandatoryMap.values()];
      const mandatoryIds = new Set([...mandatory.map((stop) => stop.id), ...customMandatory.map((stop) => stop.id)]);
      const targetCount = Math.max(targetStopCount(preferences, emphasis), mandatoryIds.size);
      let selected = [];

      [...customMandatory, ...mandatory].forEach((stop) => {
        if (!selected.some((item) => item.id === stop.id)) {
          const prepared = {
            ...stop,
            days: stop.days || defaultDaysForStop(stop, preferences, emphasis),
            enabled: true,
            requiredMustSee: Boolean(stop.requiredMustSee || mandatoryIds.has(stop.id)),
            source: stop.requiredMustSee ? "must-see" : (stop.custom ? "custom" : "candidate")
          };
          selected = insertStopAtLowestCost(selected, prepared);
        }
      });

      for (const item of ranked) {
        if (selected.length >= targetCount) break;
        if (selected.some((stop) => stop.id === item.stop.id)) continue;

        const prepared = {
          ...item.stop,
          days: defaultDaysForStop(item.stop, preferences, emphasis),
          enabled: true,
          source: "candidate"
        };
        const proposed = insertStopAtLowestCost(selected, prepared);
        if (routeFitsReasonably(proposed, preferences, false)) {
          selected = proposed;
        }
      }

      // If strict leg limits produced too few stops, add the best practical choices
      // and allow the warning system to explain any remaining compromise.
      if (selected.length < Math.min(2, targetCount)) {
        for (const item of ranked) {
          if (selected.length >= Math.min(3, targetCount)) break;
          if (selected.some((stop) => stop.id === item.stop.id)) continue;
          const prepared = { ...item.stop, days: 1, enabled: true, source: "candidate" };
          const proposed = insertStopAtLowestCost(selected, prepared);
          if (calculateRouteSummary(proposed, preferences).totalDays <= preferences.tripDays + 1) selected = proposed;
        }
      }

      selected = trimAndAllocate(selected, preferences, scoreMap, mandatoryIds, emphasis);
      return { stops: selected, emphasis };
    }
