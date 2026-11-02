"use strict";

/* ---------------------------------------------------------------------
       Safety and input helpers
       --------------------------------------------------------------------- */
    function escapeHtml(value) {
      return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }

    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, value));
    }

    function round(value, digits = 0) {
      const power = 10 ** digits;
      return Math.round(value * power) / power;
    }

    function setStatus(elementId, message, type = "info") {
      const el = $(elementId);
      el.textContent = message;
      el.className = `status show ${type}`;
    }

    function clearStatus(elementId) {
      const el = $(elementId);
      el.textContent = "";
      el.className = "status";
    }

    function getPreferences() {
      const tripDays = clamp(Number.parseInt($("tripDays").value, 10) || 10, 2, 45);
      const maxMiles = clamp(Number.parseFloat($("maxMiles").value) || 300, 50, 900);
      const maxHours = clamp(Number.parseFloat($("maxHours").value) || 5.5, 1, 14);
      const lodgingWindowInput = $("lodgingWindowPercent");
      const parsedLodgingWindow = Number.parseFloat(lodgingWindowInput?.value);
      const lodgingWindowPercent = clamp(Number.isFinite(parsedLodgingWindow) ? parsedLodgingWindow : 10, 0, 25);

      $("tripDays").value = String(tripDays);
      $("maxMiles").value = String(maxMiles);
      $("maxHours").value = String(maxHours);
      if (lodgingWindowInput) lodgingWindowInput.value = String(lodgingWindowPercent);

      return {
        mustSee: $("mustSee").value.trim(),
        history: $("historyInterests").value.trim(),
        scenery: $("sceneryInterests").value.trim(),
        exclusions: $("excludePlaces").value.trim(),
        notes: $("planningNotes").value.trim(),
        tripDays,
        maxMiles,
        maxHours,
        lodgingWindowPercent,
        lodgingWindowRatio: lodgingWindowPercent / 100,
        pace: $("pace").value,
        emphasis: $("emphasis").value
      };
    }

    function tokenize(text) {
      return String(text || "")
        .toLowerCase()
        .split(/[,;\n|]+|\band\b/)
        .map((item) => item.trim())
        .filter((item) => item.length > 1);
    }

    // Must-see entries are treated as individual required places. We avoid
    // splitting on the word “and” because it is part of many official names.
    function parseMustSeeEntries(text) {
      return [...new Set(String(text || "")
        .split(/[,;\n|]+/)
        .map((item) => item.trim())
        .filter((item) => item.length > 1))];
    }

    function normalizePlaceText(text) {
      return String(text || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
    }

    function searchableText(stop) {
      return [stop.name, stop.category, stop.description, stop.region, ...(stop.tags || [])]
        .join(" ")
        .toLowerCase();
    }

    function matchesAny(stop, terms) {
      const haystack = searchableText(stop);
      return terms.some((term) => haystack.includes(term));
    }

    function stopMatchesType(stop, type) {
      if (type === "all") return true;
      const text = searchableText(stop);
      if (type === "parks") {
        return /national park|national monument|national seashore|national lakeshore|national preserve|national recreation area|national scenic river|national river|national memorial|national battlefield|national military park/.test(text);
      }
      if (type === "history") {
        return /historic|history|battlefield|memorial|museum|mission|fort|civil rights|architecture|archaeology|president|maritime|native history|revolutionary war|civil war/.test(text);
      }
      return /scenic|state park|waterfall|lake|coast|beach|mountain|canyon|river|forest|wildlife|geology|hiking|dunes|gorge/.test(text);
    }

    function populateStopBrowserRegions() {
      const select = $("stopRegion");
      if (!select) return;
      const current = select.value || "all";
      const regions = [...new Set(CANDIDATES.map((stop) => stop.macroRegion || "Other"))]
        .sort((a, b) => a.localeCompare(b));
      select.innerHTML = `<option value="all">All regions</option>${regions.map((region) => `<option value="${escapeHtml(region)}">${escapeHtml(region)}</option>`).join("")}`;
      select.value = regions.includes(current) ? current : "all";
    }

    function getFilteredBrowserStops() {
      const query = normalizePlaceText($("stopSearch")?.value || "");
      const region = $("stopRegion")?.value || "all";
      const category = $("stopCategory")?.value || "all";
      const sort = $("stopSort")?.value || "distance";

      const filtered = CANDIDATES.filter((stop) => {
        const searchMatch = !query || normalizePlaceText(searchableText(stop)).includes(query);
        const regionMatch = region === "all" || (stop.macroRegion || "Other") === region;
        const categoryMatch = stopMatchesType(stop, category);
        return searchMatch && regionMatch && categoryMatch;
      });

      filtered.sort((a, b) => {
        if (sort === "name") return a.name.localeCompare(b.name);
        if (sort === "priority") return (b.priority || 0) - (a.priority || 0) || a.name.localeCompare(b.name);
        const direct = haversineMiles(state.start, state.end);
        const detourA = haversineMiles(state.start, a) + haversineMiles(a, state.end) - direct;
        const detourB = haversineMiles(state.start, b) + haversineMiles(b, state.end) - direct;
        return detourA - detourB || (b.priority || 0) - (a.priority || 0);
      });
      return filtered;
    }
