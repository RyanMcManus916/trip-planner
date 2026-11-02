"use strict";

/* Geographic scope ---------------------------------------------------
       The planner intentionally supports destinations only in North America,
       Central America, the Caribbean, and South America. Nominatim returns
       lower-case ISO country/territory codes when address details are enabled.
       Coordinates are used only as a defensive check for built-in data and a
       few overseas territories whose parent-country code can be ambiguous. */
    const AMERICAS_COUNTRY_CODES = new Set([
      "ag", "ai", "ar", "aw", "bb", "bl", "bm", "bo", "bq", "br", "bs", "bz",
      "ca", "cl", "co", "cr", "cu", "cw", "dm", "do", "ec", "fk", "gd", "gf",
      "gl", "gp", "gt", "gy", "hn", "ht", "jm", "kn", "ky", "lc", "mf", "mq",
      "ms", "mx", "ni", "pa", "pe", "pm", "pr", "py", "sr", "sv", "sx", "tc",
      "tt", "us", "uy", "vc", "ve", "vg", "vi"
    ]);
    const AMERICAS_COUNTRY_CODES_PARAM = [...AMERICAS_COUNTRY_CODES].join(",");
    const AMERICAS_PARENT_TERRITORY_CODES = new Set(["dk", "fr", "gb", "nl"]);

    function isCoordinateInAmericas(latValue, lngValue) {
      const lat = Number(latValue);
      const lng = Number(lngValue);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
      const northCentralCaribbean = lat >= 5 && lat <= 84
        && ((lng >= -170 && lng <= -20) || (lng >= 170 && lng <= 180));
      const southAmerica = lat >= -57 && lat <= 15 && lng >= -83 && lng <= -30;
      return northCentralCaribbean || southAmerica;
    }

    function geocodeCountryCode(result) {
      return String(result?.address?.country_code || "").trim().toLowerCase();
    }

    function isGeocodeResultInAmericas(result) {
      const code = geocodeCountryCode(result);
      if (AMERICAS_COUNTRY_CODES.has(code)) return true;
      // Some territories can inherit a parent-country code. Permit those only
      // when their coordinates are physically within the Americas.
      return AMERICAS_PARENT_TERRITORY_CODES.has(code)
        && isCoordinateInAmericas(result?.lat, result?.lon);
    }

    function createOutsideAmericasError(query, result = null) {
      const country = String(result?.address?.country || "").trim();
      const locationLabel = country || String(result?.display_name || "an overseas location").split(",").pop().trim();
      const error = new Error(`“${query}” appears to be in ${locationLabel || "an overseas location"}, outside North and South America. Choose a destination in the Americas.`);
      error.code = "OUTSIDE_AMERICAS";
      error.location = locationLabel;
      return error;
    }

    // Defensive validation of the bundled destination library. Any accidental
    // future entry outside the supported geography is removed before display.
    const validAmericasCandidates = CANDIDATES.filter((stop) => isCoordinateInAmericas(stop.lat, stop.lng));
    if (validAmericasCandidates.length !== CANDIDATES.length) {
      console.warn(`${CANDIDATES.length - validAmericasCandidates.length} bundled destination(s) outside the Americas were excluded.`);
      CANDIDATES.splice(0, CANDIDATES.length, ...validAmericasCandidates);
    }
